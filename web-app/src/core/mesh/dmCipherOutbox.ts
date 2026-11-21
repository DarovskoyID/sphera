import { parseGuildCipherMessage, type GuildCipherMessage } from './guildCipherMessage';
import { verifyCipherScope, type CipherScopeProof } from './cipherPolicy';
import { cipherMembershipRoom } from './pairwiseCipher';
/** Durable personal-message intents and exact wire bytes. SQL acceptance is
 * distinct from BFT finality, recipient delivery, and reading the plaintext. */
import { accountBytes, accountDigest } from './account';
import { encryptArchive, decryptArchive, type ArchiveMessage } from './vault';
import { cipherUserId, type CipherIdentity } from './pairwiseCipher';
import { parseDmCipherMessage, type DmCipherMessage, type DmCipherText } from './dmCipherMessage';
import { acquireCipherStoreLock } from './cipherStoreLock';
import { entryProbeNonce, validateTrustedEntryPoints, verifyEntryProbe, type TrustedEntryPoint } from './entryPoint';

type Wire = DmCipherMessage | GuildCipherMessage;
export type DmOutboxRecord<W extends Wire = DmCipherMessage> = {
  domain: 'sfera-dm-outbox-record-v1'; id: string; scope: string; nonce: string; queuedAt: number;
  authorization?: CipherScopeProof;
  guild?: string; payload: DmCipherText; wire: W | null;
  state: 'draft' | 'ready' | 'pending' | 'accepted' | 'rejected';
  writeId: string | null; publication: 'local' | 'pending' | 'confirmed' | null;
  rejection: 'deleted' | null;
};
type Options<W extends Wire> = {
  source?: 'dm' | 'guild';
  guard: () => boolean; token: () => string;
  seal: (scope: string, id: string, payload: DmCipherText, guild?: string) => Promise<W>;
  sealAuthorized?: (scope: string, id: string, payload: DmCipherText, guild?: string) => Promise<{ wire: W; authorization: CipherScopeProof }>;
  transport?: typeof fetch;
  publishDistributed?: (scope:string,cipher:W,queuedAt:number)=>Promise<unknown>;
};
type Row = { key: string; sealed: ArchiveMessage };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;
const MAX_ROWS = 256, MAX_BYTES = 16 * 1048576, MAX_RECORD = 262144;
// Fixed-size status fields can grow by < 256 encoded bytes per row. Keep
// headroom so SQL acceptance can be journaled when the payload budget is full.
const STATUS_RESERVE = MAX_ROWS * 256;
const decoder = new TextDecoder('utf-8', { fatal: true });
function schema(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) throw new Error('invalid_dm_outbox_schema');
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error('invalid_dm_outbox_identity');
}
function payload(value: unknown): DmCipherText {
  schema(value, ['text', 'replyTo']);
  if (typeof value.text !== 'string' || !value.text.trim() || accountBytes(value).length > 32768) throw new Error('invalid_dm_outbox_text');
  if (value.replyTo !== null) identifier(value.replyTo);
  return { text: value.text, replyTo: value.replyTo as string | null };
}
export class DmOutboxHttpError extends Error {
  readonly status: number;
  constructor(status: number) { super('dm_outbox_http_' + status); this.status = status; }
}

export class DmCipherOutbox<W extends Wire = DmCipherMessage> {
  private db: IDBDatabase;
  private root: Uint8Array;
  private own: CipherIdentity;
  private pin: TrustedEntryPoint;
  private user: string;
  private context: string;
  private options: Options<W>;
  private release: () => Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private closing?: Promise<void>;
  private abort = new AbortController();
  private lastQueued = 0;
  private constructor(db: IDBDatabase, root: Uint8Array, own: CipherIdentity, pin: TrustedEntryPoint,
    user: string, context: string, options: Options<W>, release: () => Promise<void>) {
    this.db = db; this.root = root; this.own = own; this.pin = pin; this.user = user;
    this.context = context; this.options = { ...options }; this.release = release;
  }
  static async open<W extends Wire = DmCipherMessage>(own: CipherIdentity, pin: TrustedEntryPoint, user: string, root: Uint8Array, options: Options<W>) {
    own = { network: own.network, genesis: own.genesis, owner: own.owner, device: own.device };
    root = new Uint8Array(root);
    let db: IDBDatabase | undefined, release: (() => Promise<void>) | undefined;
    try {
      cipherUserId(own); identifier(user);
      if (options.source !== undefined && !['dm', 'guild'].includes(options.source)) throw new Error('invalid_outbox_source');
      if (root.length !== 32 || !options.guard() || typeof indexedDB === 'undefined') throw new Error('invalid_dm_outbox_context');
      const { network, nodeId, publicKey, url, label } = pin;
      pin = (await validateTrustedEntryPoints([{ network, nodeId, publicKey, url, label }]))[0];
      if (pin.network !== own.network) throw new Error('invalid_dm_outbox_context');
      const context = await accountDigest(accountBytes([options.source === 'guild' ? 'sfera-guild-outbox-v1' : 'sfera-dm-outbox-v1', own.network, own.genesis,
        own.owner, own.device, pin.nodeId, pin.publicKey, pin.url, user]));
      release = await acquireCipherStoreLock('sphere-dm-outbox-v1:' + context);
      db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('sphere-dm-outbox-v1:' + context, 1);
        request.onupgradeneeded = () => { request.result.createObjectStore('config'); request.result.createObjectStore('messages'); };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('dm_outbox_unavailable'));
        request.onblocked = () => reject(new Error('dm_outbox_blocked'));
      });
      const outbox = new DmCipherOutbox(db, root, own, pin, user, context, options, release);
      await outbox.checkKey();
      for (const row of await outbox.rows()) outbox.lastQueued = Math.max(outbox.lastQueued, (await outbox.decode(row)).queuedAt);
      outbox.assert();
      return outbox;
    } catch (error) { db?.close(); root.fill(0); await release?.(); throw error; }
  }
  private assert() {
    if (this.stopping || this.abort.signal.aborted || !this.options.guard()) throw new Error('dm_outbox_context_changed_or_closed');
  }
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => { this.assert(); const result = await task(); this.assert(); return result; });
    this.queue = next.catch(() => undefined);
    return next;
  }
  private get(store: 'messages' | 'config', key: string): Promise<ArchiveMessage | undefined> {
    this.assert();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readonly'), request = tx.objectStore(store).get(key);
      let result: ArchiveMessage | undefined;
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(new Error('dm_outbox_read_failed'));
    });
  }
  private async checkKey() {
    const marker = accountBytes(['sfera-dm-outbox-key-v1', this.context]);
    let sealed = await this.get('config', 'key');
    if (!sealed) {
      const next = await encryptArchive(this.root, this.own.owner, this.context, 'key', marker);
      this.assert();
      await new Promise<void>((resolve, reject) => {
        const tx = this.db.transaction('config', 'readwrite', { durability: 'strict' });
        tx.objectStore('config').add(next, 'key');
        tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(new Error('dm_outbox_key_write_failed'));
      });
      sealed = await this.get('config', 'key');
    }
    if (!sealed || decoder.decode(await decryptArchive(this.root, this.own.owner, this.context, 'key', sealed)) !== decoder.decode(marker)) throw new Error('dm_outbox_key_mismatch');
    this.assert();
  }
  private rows(): Promise<Row[]> {
    this.assert();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('messages', 'readonly'), request = tx.objectStore('messages').openCursor();
      const result: Row[] = []; let size = 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        size += accountBytes(cursor.value).length;
        if (result.length >= MAX_ROWS || size > MAX_BYTES || typeof cursor.key !== 'string' || !uuid.test(cursor.key)) { tx.abort(); return; }
        result.push({ key: cursor.key, sealed: cursor.value }); cursor.continue();
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(new Error('dm_outbox_read_or_capacity_failed'));
    });
  }
  private async decode(row: Row): Promise<DmOutboxRecord<W>> {
    this.assert();
    schema(row.sealed, ['version', 'userId', 'dialogId', 'messageId', 'nonce', 'ciphertext']);
    if (typeof row.sealed.ciphertext !== 'string' || row.sealed.ciphertext.length > (MAX_RECORD + 16) * 2) throw new Error('dm_outbox_corrupt');
    const raw = await decryptArchive(this.root, this.own.owner, this.context, row.key, row.sealed);
    const value = JSON.parse(decoder.decode(raw));
    schema(value, ['domain', 'id', 'scope', 'nonce', 'queuedAt', 'payload', 'wire', 'state', 'writeId', 'publication', 'rejection', ...(Object.hasOwn(value, 'authorization') ? ['authorization'] : []), ...(Object.hasOwn(value, 'guild') ? ['guild'] : [])]);
    identifier(value.id); identifier(value.scope);
    if (this.options.source === 'guild') identifier(value.guild);
    else if (Object.hasOwn(value, 'guild')) throw new Error('dm_outbox_source_mismatch');
    if (value.domain !== 'sfera-dm-outbox-record-v1' || value.id !== row.key || value.nonce !== value.id ||
        !Number.isSafeInteger(value.queuedAt) || (value.queuedAt as number) < 0 ||
        !['draft', 'ready', 'pending', 'accepted', 'rejected'].includes(value.state as string) ||
        (value.writeId !== null && (typeof value.writeId !== 'string' || !hex.test(value.writeId))) ||
        ![null, 'local', 'pending', 'confirmed'].includes(value.publication as string | null) ||
        ![null, 'deleted'].includes(value.rejection as string | null)) throw new Error('dm_outbox_corrupt');
    payload(value.payload);
    if (value.state === 'draft') {
      if (value.wire !== null || value.writeId !== null || value.publication !== null || value.rejection !== null) throw new Error('dm_outbox_corrupt');
    } else {
      const wire = this.wire(value.wire, value.scope, value.id, value.guild as string | undefined);
      value.wire = wire;
      if ((value.state === 'rejected') !== (value.rejection === 'deleted') ||
          (value.state === 'ready' && (value.publication !== null || value.writeId !== null)) ||
          (value.state === 'pending' && value.publication !== 'pending') ||
          (value.state === 'accepted' && !['local', 'confirmed'].includes(value.publication as string))) throw new Error('dm_outbox_corrupt');
    }
    if (Object.hasOwn(value, 'authorization')) {
      const proof = value.authorization as CipherScopeProof;
      const certificate = proof?.body?.certificates?.find(item => item.body.owner === this.own.owner && item.body.device === this.own.device);
      if (!certificate || !value.wire) throw new Error('dm_outbox_authorization_mismatch');
      const peer = certificate.body;
      const checked = await verifyCipherScope(proof, this.pin, peer, this.user, this.options.source ?? 'dm', value.scope, proof.body.nonce, proof.body.issued_at);
      const wire = value.wire as DmCipherMessage;
      if (wire.envelope.epoch !== checked.membership.epoch || wire.envelope.content.sender_key !== peer.curve25519 ||
          wire.envelope.room !== await cipherMembershipRoom(checked.membership, peer)) throw new Error('dm_outbox_authorization_mismatch');
    }
    this.assert();
    return value as unknown as DmOutboxRecord<W>;
  }
  private wire(value: unknown, scope: string, id: string, guild?: string): W {
    const wire = this.options.source === 'guild' ? parseGuildCipherMessage(value, guild!, scope) : parseDmCipherMessage(value, scope);
    if (wire.id !== id || wire.sender.user !== this.user || wire.sender.owner !== this.own.owner || wire.sender.device !== this.own.device ||
        !new RegExp('^![0-9a-f]{64}:' + this.own.genesis + '\\.sphere$').test(wire.envelope.room) ||
        wire.envelope.content.device_id !== this.own.device ||
        !['sender_key', 'session_id'].every(key => typeof wire.envelope.content[key] === 'string' && /^[A-Za-z0-9+/]{43}$/.test(wire.envelope.content[key] as string))) throw new Error('dm_outbox_wire_context_mismatch');
    return wire as W;
  }
  private async put(record: DmOutboxRecord<W>, previous: ArchiveMessage | undefined) {
    this.assert();
    const raw = accountBytes(record);
    if (raw.length > MAX_RECORD) throw new Error('dm_outbox_record_too_large');
    const sealed = await encryptArchive(this.root, this.own.owner, this.context, record.id, raw);
    this.assert();
    const budget = ['draft', 'ready'].includes(record.state) ? MAX_BYTES - STATUS_RESERVE : MAX_BYTES;
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction('messages', 'readwrite', { durability: 'strict' }), store = tx.objectStore('messages');
      const request = store.openCursor(); let found: ArchiveMessage | undefined, count = 1, size = accountBytes(sealed).length;
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          if (cursor.key === record.id) found = cursor.value;
          else { count++; size += accountBytes(cursor.value).length; }
          if (count > MAX_ROWS || size > budget) { tx.abort(); return; }
          cursor.continue(); return;
        }
        if (JSON.stringify(found) !== JSON.stringify(previous)) { tx.abort(); return; }
        store.put(sealed, record.id);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error('dm_outbox_write_capacity_or_conflict'));
    });
  }
  enqueue(scope: string, id: string, text: DmCipherText, guild?: string) {
    identifier(scope); identifier(id);
    if (this.options.source === 'guild') identifier(guild);
    else if (guild !== undefined) throw new Error('dm_outbox_source_mismatch');
    const frozen = payload(JSON.parse(JSON.stringify(text)));
    const own = { user: this.user, owner: this.own.owner, device: this.own.device };
    if (accountBytes({ domain: this.options.source === 'guild' ? 'sfera-guild-cipher-message-v1' : 'sfera-dm-cipher-message-v1', ...(guild ? { guild } : {}), scope, id, sender: own, payload: frozen }).length > 32768) throw new Error('dm_outbox_text_too_large');
    return this.run(async () => {
      const sealed = await this.get('messages', id);
      if (sealed) {
        const old = await this.decode({ key: id, sealed });
        if (old.guild !== guild || old.scope !== scope || decoder.decode(accountBytes(old.payload)) !== decoder.decode(accountBytes(frozen))) throw new Error('dm_outbox_identity_conflict');
        return old;
      }
      const record: DmOutboxRecord<W> = { domain: 'sfera-dm-outbox-record-v1', id, scope, ...(guild ? { guild } : {}), nonce: id,
        queuedAt: Math.max(Date.now(), this.lastQueued + 1), payload: frozen, wire: null, state: 'draft',
        writeId: null, publication: null, rejection: null };
      if (!Number.isSafeInteger(record.queuedAt) || record.queuedAt < 0) throw new Error('invalid_dm_outbox_clock');
      await this.put(record, undefined); this.lastQueued = record.queuedAt;
      return JSON.parse(JSON.stringify(record)) as DmOutboxRecord<W>;
    });
  }
  list() {
    return this.run(async () => {
      const result: DmOutboxRecord<W>[] = [];
      for (const row of await this.rows()) result.push(await this.decode(row));
      return result.sort((a, b) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id));
    });
  }
  create(scope: string, text: DmCipherText, guild?: string) { return this.enqueue(scope, crypto.randomUUID(), text, guild); }
  async flush(scope: string, limit = 16) {
    identifier(scope);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error('invalid_dm_outbox_batch');
    const records = (await this.list()).filter(record => record.scope === scope &&
      ['draft', 'ready', 'pending'].includes(record.state)).slice(0, limit);
    const result: DmOutboxRecord<W>[] = [];
    for (const record of records) result.push(await this.send(record.id));
    return result;
  }
  private async http(path: string, body: unknown, authenticated: boolean, limit: number) {
    this.assert();
    const token = authenticated ? this.options.token() : '';
    if (authenticated && (typeof token !== 'string' || !token || token.length > 32768)) throw new Error('dm_outbox_login_required');
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.abort.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      const response = await (this.options.transport ?? fetch)(this.pin.url + path, { method: 'POST', body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', 'X-Ionik-Client': '1', ...(authenticated ? { Authorization: 'Bearer ' + token } : {}) },
        signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
      this.assert();
      if (controller.signal.aborted || response.redirected || (response.url && new URL(response.url).origin !== this.pin.url) ||
          Number(response.headers.get('Content-Length')) > limit) throw new Error('invalid_dm_outbox_response');
      if (![200, 201, 202, 410].includes(response.status)) { await response.body?.cancel(); throw new DmOutboxHttpError(response.status); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('invalid_dm_outbox_response');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const next = await reader.read(); this.assert();
          if (controller.signal.aborted) throw new Error('dm_outbox_request_timed_out');
          if (next.done) break;
          size += next.value.length;
          if (size > limit) { await reader.cancel(); throw new Error('invalid_dm_outbox_response'); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      const raw = new Uint8Array(size); let offset = 0;
      for (const part of chunks) { raw.set(part, offset); offset += part.length; }
      return { status: response.status, body: JSON.parse(decoder.decode(raw)) as unknown };
    } finally { clearTimeout(timer); controller.abort(); this.abort.signal.removeEventListener('abort', abort); }
  }
  private async trustedEntry() {
    const nonce = entryProbeNonce();
    const probe = await this.http('/api/auth/mesh/entry/', { nonce }, false, 65536);
    if (probe.status !== 200 || await verifyEntryProbe(probe.body, this.pin, nonce) !== this.own.genesis) throw new Error('dm_outbox_entry_changed');
    this.assert();
    const expires = (probe.body as { body: { expires_at: number } }).body.expires_at;
    if (expires <= Math.floor(Date.now() / 1000)) throw new Error('dm_outbox_entry_expired');
    return expires;
  }
  send(id: string) {
    identifier(id);
    return this.run(async () => {
      let sealed = await this.get('messages', id);
      if (!sealed) throw new Error('dm_outbox_message_missing');
      let record = await this.decode({ key: id, sealed });
      if (record.state === 'accepted' || record.state === 'rejected') return record;
      // Establish the selected entry before invoking the SDK callback, whose
      // membership/key exchanges can themselves require authentication.
      let expires = await this.trustedEntry();
      if (record.state === 'draft') {
        const prepared = this.options.sealAuthorized ? await this.options.sealAuthorized(record.scope, record.id, { ...record.payload }, record.guild) : undefined;
        const wire = this.wire(prepared ? prepared.wire : await this.options.seal(record.scope, record.id, { ...record.payload }, record.guild), record.scope, record.id, record.guild);
        this.assert();
        record = { ...record, state: 'ready', wire, ...(prepared ? { authorization: prepared.authorization } : {}) };
        await this.put(record, sealed);
        sealed = await this.get('messages', id);
        if (!sealed) throw new Error('dm_outbox_message_missing');
        record = await this.decode({ key: id, sealed });
      }
      this.assert();
      if (expires <= Math.floor(Date.now() / 1000)) expires = await this.trustedEntry();
      if(record.authorization?.body.domain==='sfera-mesh-cipher-scope-v2') {
        if(!this.options.publishDistributed)throw new Error('distributed_message_publisher_required');
        await this.options.publishDistributed(record.scope,record.wire!,record.queuedAt);this.assert();
        if(expires<=Math.floor(Date.now()/1000))expires=await this.trustedEntry();
      }
      const response = await this.http((this.options.source === 'guild' ? '/api/guilds/' + record.guild + '/channels/' : '/api/conversations/') + record.scope + '/messages/cipher/send/',
        { cipher: record.wire, nonce: record.nonce }, true, 1048576);
      this.assert();
      if(expires<=Math.floor(Date.now()/1000))expires=await this.trustedEntry();
      if (response.status === 410) {
        schema(response.body, ['error']);
        if (response.body.error !== 'cipher_message_deleted') throw new Error('invalid_dm_outbox_response');
        record = { ...record, state: 'rejected', rejection: 'deleted' };
      } else if (response.status === 202) {
        schema(response.body, ['type', 'id', 'write_id', 'nonce', 'publication_state', 'consensus_committed']);
        const body = response.body;
        if (body.type !== 'message_pending' || body.id !== id || body.nonce !== record.nonce || body.publication_state !== 'pending' ||
            body.consensus_committed !== false || typeof body.write_id !== 'string' || !hex.test(body.write_id) ||
            (record.writeId !== null && body.write_id !== record.writeId)) throw new Error('invalid_dm_outbox_pending');
        record = { ...record, state: 'pending', publication: 'pending', writeId: body.write_id };
      } else {
        const body = response.body as Record<string, unknown>;
        if (!body || typeof body !== 'object' || body.id !== id || body.message_type !== 'cipher' || body.content !== '' ||
            body.nonce !== record.nonce || body.reply_to !== null || body.edited !== false ||
            !Array.isArray(body.attachments) || body.attachments.length || !['local', 'pending', 'confirmed'].includes(body.publication_state as string) ||
            !body.author || (body.author as { id: string }).id !== this.user ||
            await accountDigest(accountBytes(this.wire(body.payload, record.scope, id, record.guild))) !== await accountDigest(accountBytes(record.wire))) throw new Error('invalid_dm_outbox_echo');
        record = { ...record, state: body.publication_state === 'pending' ? 'pending' : 'accepted',
          publication: body.publication_state as 'local' | 'pending' | 'confirmed' };
      }
      await this.put(record, sealed);
      return JSON.parse(JSON.stringify(record)) as DmOutboxRecord<W>;
    });
  }
  /** Explicit removal only: callers must archive accepted records first.
   * An ambiguous ready/pending send cannot be silently cancelled. */
  rejectDeleted(id: string, digest: string) {
    identifier(id);
    return this.run(async () => {
      const sealed = await this.get('messages', id); if (!sealed) return;
      const record = await this.decode({ key: id, sealed });
      if (!record.wire || await accountDigest(accountBytes(record.wire)) !== digest) throw new Error('dm_outbox_deletion_context_mismatch');
      await this.put({ ...record, state: 'rejected', rejection: 'deleted' }, sealed);
    });
  }
  forget(id: string) {
    identifier(id);
    return this.run(async () => {
      const sealed = await this.get('messages', id);
      if (!sealed) return;
      const record = await this.decode({ key: id, sealed });
      if (!['draft', 'accepted', 'rejected'].includes(record.state)) throw new Error('dm_outbox_send_outcome_uncertain');
      await new Promise<void>((resolve, reject) => {
        const tx = this.db.transaction('messages', 'readwrite', { durability: 'strict' }), store = tx.objectStore('messages');
        const request = store.get(id);
        request.onsuccess = () => { if (JSON.stringify(request.result) !== JSON.stringify(sealed)) tx.abort(); else store.delete(id); };
        tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(new Error('dm_outbox_remove_conflict'));
      });
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true; this.abort.abort();
    this.closing = this.queue.then(async () => { try { this.db.close(); this.root.fill(0); } finally { await this.release(); } });
    return this.closing;
  }
}
