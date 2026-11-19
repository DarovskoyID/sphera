import { parseGuildCipherMessage, openGuildCipherBody } from './guildCipherMessage';
/** Encrypted historical cache, never an assertion of current ACL or complete history.
 * Megolm receives may be decrypted again with the same event identity after a
 * crash. Text is returned to the application only after the archive transaction.
 */
import { accountBytes, accountDigest } from './account';
import { encryptArchive, decryptArchive, type ArchiveMessage } from './vault';
import { cipherUserId, cipherMembershipRoom, type CipherIdentity, type GroupEnvelope } from './pairwiseCipher';
import { AuthorizedCipher, verifyCipherScope, type CipherScopeProof } from './cipherPolicy';
import { validateTrustedEntryPoints, type TrustedEntryPoint } from './entryPoint';
import { ARCHIVE_DELETION_LIMIT, verifyArchiveDeletion, verifyArchiveDeletionPage, type ArchiveDeletion } from './archiveDeletion';
import { parseDmCipherMessage, openDmCipherBody } from './dmCipherMessage';

type Source = 'dm' | 'guild';
type Stored = { domain: 'sfera-mesh-cipher-archive-message-v1'; source: Source; scope: string;
  id: string; sender: { owner: string; device: string }; text: string; envelope: GroupEnvelope;
  authorization: CipherScopeProof; recipient_device: string; content_digest: string };
type Row = { key: string; sealed: ArchiveMessage };
type Exported = { domain: 'sfera-mesh-cipher-archive-export-v2'; context: string; rows: Row[]; checkpoints: Row[] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
const LIMIT = 512;

export class CipherArchive {
  private db: IDBDatabase;
  private root: Uint8Array;
  private own: CipherIdentity;
  private pin: TrustedEntryPoint;
  private user: string;
  private context: string;
  private closed = false;
  private histories = new Set<CipherArchive>();
  private keyMarker?: ArchiveMessage;
  private constructor(db: IDBDatabase, root: Uint8Array, own: CipherIdentity, pin: TrustedEntryPoint, user: string, context: string) {
    this.db = db; this.root = root; this.own = own; this.pin = pin; this.user = user; this.context = context;
  }
  static async open(own: CipherIdentity, pin: TrustedEntryPoint, user: string, root: Uint8Array, options?: { deviceLocal: boolean; namespace?: string }) {
    own = { network: own.network, genesis: own.genesis, owner: own.owner, device: own.device };
    pin = { ...pin }; root = new Uint8Array(root);
    try {
      cipherUserId(own);
      if (root.length !== 32 || !uuid.test(user) || pin.network !== own.network || typeof indexedDB === 'undefined' ||
          options?.namespace !== undefined && !/^[0-9a-f]{64}$/.test(options.namespace)) throw new Error('invalid_cipher_archive_context');
      const { network, nodeId, publicKey, url, label } = pin;
      await validateTrustedEntryPoints([{ network, nodeId, publicKey, url, label }]);
      let context = await accountDigest(accountBytes(options?.deviceLocal
        ? ['sfera-mesh-device-cipher-archive-v1', own.network, own.genesis, own.owner, own.device, nodeId, user]
        : ['sfera-mesh-cipher-archive-v1', own.network, own.genesis, own.owner, nodeId, user]));
      if (options?.namespace) context = await accountDigest(accountBytes(['sfera-mesh-imported-history-v1', options.namespace, context]));
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('sphere-e2ee-archive-v1:' + context, 1);
        request.onupgradeneeded = () => { request.result.createObjectStore('messages'); request.result.createObjectStore('config'); };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('cipher_archive_unavailable'));
        request.onblocked = () => reject(new Error('cipher_archive_blocked'));
      });
      const archive = new CipherArchive(db, root, own, pin, user, context);
      try { await archive.checkKey(); return archive; }
      catch (error) { archive.close(); throw error; }
    } catch (error) { root.fill(0); throw error; }
  }
  private active() { if (this.closed) throw new Error('cipher_archive_closed'); }
  assertNetwork(network: string, genesis: string) {
    this.active();
    if (network !== this.own.network || genesis !== this.own.genesis) throw new Error('cipher_archive_network_mismatch');
  }
  /** Isolated historical namespace owned by this target archive. Original
   * entry signatures remain original; they never authorize target messages.
   */
  async historical(pin: TrustedEntryPoint, user: string) {
    this.active();
    if (pin.network !== this.own.network) throw new Error('cipher_archive_transfer_context');
    const name = 'history:' + await accountDigest(accountBytes([pin.nodeId, user]));
    let sealed = await this.get('config', name);
    if (!sealed) {
      const generated = crypto.getRandomValues(new Uint8Array(32));
      try { await this.insert('config', name, await encryptArchive(this.root, this.own.owner, this.context, name, generated)); }
      finally { generated.fill(0); }
      sealed = await this.get('config', name);
    }
    if (!sealed) throw new Error('cipher_archive_history_key_missing');
    const root = await decryptArchive(this.root, this.own.owner, this.context, name, sealed);
    try {
      this.active(); if (root.length !== 32) throw new Error('cipher_archive_history_key_corrupt');
      const archive = await CipherArchive.open(this.own, pin, user, root, { deviceLocal: true, namespace: this.context });
      if (this.closed) { archive.close(); throw new Error('cipher_archive_closed'); }
      for (const previous of this.histories) if (previous.closed) this.histories.delete(previous);
      this.histories.add(archive); return archive;
    }
    finally { root.fill(0); }
  }
  private get(store: 'messages' | 'config', key: string): Promise<ArchiveMessage | undefined> {
    this.active();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readonly'), request = tx.objectStore(store).get(key);
      let value: ArchiveMessage | undefined;
      request.onsuccess = () => { value = request.result; };
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(new Error('cipher_archive_read_failed'));
    });
  }
  private insert(store: 'messages' | 'config', key: string, sealed: ArchiveMessage): Promise<boolean> {
    this.active();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store === 'messages' ? ['messages', 'config'] : ['config'], 'readwrite', { durability: 'strict' }), values = tx.objectStore(store);
      if (this.keyMarker) this.guardKey(tx);
      const found = values.get(key);
      let inserted = false;
      found.onsuccess = () => {
        if (found.result !== undefined) return;
        if (store === 'messages') {
          const deleted = tx.objectStore('config').get('deleted:' + key);
          deleted.onsuccess = () => { if (deleted.result !== undefined) tx.abort(); else add(); };
        } else add();
      };
      const add = () => {
        const count = values.count();
        count.onsuccess = () => {
          if (store === 'messages' && count.result >= LIMIT) { tx.abort(); return; }
          if (store === 'config') {
            if (key.startsWith('history:')) {
              const histories = values.count(IDBKeyRange.bound('history:', 'history;'));
              histories.onsuccess = () => { if (histories.result >= 128) tx.abort(); else { values.add(sealed, key); inserted = true; } };
            } else { values.add(sealed, key); inserted = true; }
            return;
          }
          // Keep every accepted store exportable as one bounded document. The
          // reserve covers its context/header; size includes per-row keys.
          let size = accountBytes({ key, sealed }).length + 1, completed = 0;
          for (const name of ['messages', 'config']) {
            const cursor = tx.objectStore(name).openCursor();
            cursor.onsuccess = () => {
              const row = cursor.result;
              if (row && (name === 'messages' || String(row.key).startsWith('checkpoint:'))) size += accountBytes({ key: row.key, sealed: row.value }).length + 1;
              if (size > 16 * 1048576 - 4096) { tx.abort(); return; }
              if (row) row.continue();
              else if (++completed === 2) { values.add(sealed, key); inserted = true; }
            };
          };
        };
      };
      tx.oncomplete = () => resolve(inserted);
      tx.onerror = tx.onabort = () => reject(new Error('cipher_archive_write_failed'));
    });
  }
  private async checkKey() {
    const marker = accountBytes(['sfera-mesh-cipher-archive-key-v1', this.context]);
    let sealed = await this.get('config', 'key');
    if (!sealed) {
      const next = await encryptArchive(this.root, this.own.owner, this.context, 'key', marker);
      await this.insert('config', 'key', next);
      sealed = await this.get('config', 'key');
    }
    if (!sealed || decoder.decode(await decryptArchive(this.root, this.own.owner, this.context, 'key', sealed)) !== decoder.decode(marker)) throw new Error('cipher_archive_key_mismatch');
    this.keyMarker = sealed;
    this.active();
  }
  private guardKey(tx: IDBTransaction) {
    const expected = JSON.stringify(this.keyMarker), request = tx.objectStore('config').get('key');
    request.onsuccess = () => { if (JSON.stringify(request.result) !== expected || this.closed) tx.abort(); };
  }
  private async key(source: Source, scope: string, id: string) {
    if (!['dm', 'guild'].includes(source) || !uuid.test(scope) || !uuid.test(id)) throw new Error('invalid_cipher_archive_message');
    return accountDigest(accountBytes([this.context, source, scope, id]));
  }
  private async validate(value: Stored, key: string) {
    if (!value || Object.keys(value).sort().join(',') !== 'authorization,content_digest,domain,envelope,id,recipient_device,scope,sender,source,text' ||
        value.domain !== 'sfera-mesh-cipher-archive-message-v1' || key !== await this.key(value.source, value.scope, value.id) ||
        !value.sender || Object.keys(value.sender).sort().join(',') !== 'device,owner' ||
        typeof value.text !== 'string' || new TextEncoder().encode(value.text).length > 32768 ||
        value.envelope?.message_id !== value.id || value.envelope?.sender_device !== value.sender.device) throw new Error('cipher_archive_message_corrupt');
    const proof = value.authorization;
    const certificate = proof?.body?.certificates?.find(item => item.body.owner === this.own.owner && item.body.device === value.recipient_device);
    if (!certificate) throw new Error('cipher_archive_recipient_mismatch');
    const { network, genesis, owner, device, ed25519, curve25519 } = certificate.body;
    const checked = await verifyCipherScope(proof, this.pin, { network, genesis, owner, device, ed25519, curve25519 },
      this.user, value.source, value.scope, proof.body.nonce, proof.body.issued_at);
    if (!checked.membership.peers.some(peer => peer.owner === value.sender.owner && peer.device === value.sender.device) ||
        value.envelope.epoch !== checked.membership.epoch || value.envelope.room !== await cipherMembershipRoom(checked.membership, { network, genesis, owner, device, ed25519, curve25519 }) ||
        value.content_digest !== await accountDigest(accountBytes({ sender: value.sender, envelope: value.envelope, text: value.text }))) throw new Error('cipher_archive_receipt_mismatch');
    return value;
  }
  private async unseal(key: string, sealed: ArchiveMessage) {
    if (!sealed || Object.keys(sealed).sort().join(',') !== 'ciphertext,dialogId,messageId,nonce,userId,version' ||
        typeof sealed.ciphertext !== 'string' || sealed.ciphertext.length > 524288) throw new Error('cipher_archive_record_corrupt');
    const raw = await decryptArchive(this.root, this.own.owner, this.context, key, sealed);
    const value: Stored = JSON.parse(decoder.decode(raw));
    if (decoder.decode(accountBytes(value)) !== decoder.decode(raw)) throw new Error('cipher_archive_encoding_corrupt');
    return this.validate(value, key);
  }
  async receive(cipher: AuthorizedCipher, source: Source, scope: string,
    sender: { owner: string; device: string }, envelope: GroupEnvelope, authorization?: CipherScopeProof) {
    this.active();
    sender = { owner: sender.owner, device: sender.device }; envelope = JSON.parse(JSON.stringify(envelope));
    // Megolm's fixed event ID allows this exact receive to be repeated after
    // decrypt-before-commit failure. Pairwise Olm has no such guarantee here.
    const result = authorization ? await cipher.decryptHistorical(source, scope, sender, envelope, authorization) : await cipher.decrypt(source, scope, sender, envelope);
    this.active();
    const key = await this.key(source, scope, result.id);
    const content_digest = await accountDigest(accountBytes({ sender, envelope, text: result.text }));
    const value: Stored = { domain: 'sfera-mesh-cipher-archive-message-v1', source, scope,
      id: result.id, sender, text: result.text, envelope, authorization: result.authorization,
      recipient_device: this.own.device, content_digest };
    await this.validate(value, key);
    const raw = accountBytes(value);
    if (raw.length > 262128) throw new Error('cipher_archive_message_too_large');
    const sealed = await encryptArchive(this.root, this.own.owner, this.context, key, raw);
    await this.insert('messages', key, sealed);
    const saved = await this.read(source, scope, result.id);
    if (!saved || saved.content_digest !== content_digest) throw new Error('cipher_archive_message_fork');
    this.active();
    return { id: saved.id, text: saved.text };
  }
  async read(source: Source, scope: string, id: string) {
    this.active();
    const key = await this.key(source, scope, id), sealed = await this.get('messages', key);
    const value = sealed ? await this.unseal(key, sealed) : null;
    if (await this.get('config', 'deleted:' + key)) return null;
    this.active();
    return value ? { ...value, historical_only: true as const, current_acl_verified: false as const,
      consensus_history_complete: false as const,
      local_outgoing_intent: value.sender.owner === this.own.owner && value.sender.device === value.recipient_device } : null;
  }
  async rememberOutgoing(cipher: AuthorizedCipher, scope: string, envelope: GroupEnvelope, text: string, savedAuthorization?: CipherScopeProof, source: Source = 'dm') {
    this.active(); envelope = JSON.parse(JSON.stringify(envelope));
    const authorization = await cipher.outgoingAuthorization(source, scope, envelope, savedAuthorization);
    const sender = { owner: this.own.owner, device: this.own.device }, id = envelope.message_id;
    const content_digest = await accountDigest(accountBytes({ sender, envelope, text }));
    const value: Stored = { domain: 'sfera-mesh-cipher-archive-message-v1', source, scope, id,
      sender, text, envelope, authorization, recipient_device: this.own.device, content_digest };
    const key = await this.key(source, scope, id);
    await this.validate(value, key);
    const raw = accountBytes(value);
    if (raw.length > 262128) throw new Error('cipher_archive_message_too_large');
    await this.insert('messages', key, await encryptArchive(this.root, this.own.owner, this.context, key, raw));
    const saved = await this.read(source, scope, id);
    if (!saved || saved.content_digest !== content_digest) throw new Error('cipher_archive_message_fork');
    return saved;
  }
  /** Local terminal deletion after a verified selected-server SQL statement.
   * It does not manufacture a BFT deletion checkpoint or a portable receipt. */
  async removeLocal(source: Source, scope: string, id: string) {
    this.active();
    const key = await this.key(source, scope, id), name = 'deleted:' + key;
    const sealed = await encryptArchive(this.root, this.own.owner, this.context, name,
      accountBytes(['sfera-local-archive-deletion-v1', source, scope, id]));
    this.active();
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction(['messages', 'config'], 'readwrite', { durability: 'strict' }), config = tx.objectStore('config');
      this.guardKey(tx);
      const existing = config.get(name);
      existing.onsuccess = () => {
        if (existing.result) { tx.objectStore('messages').delete(key); return; }
        const count = config.count();
        count.onsuccess = () => {
          if (count.result >= ARCHIVE_DELETION_LIMIT + 128) { tx.abort(); return; }
          config.put(sealed, name); tx.objectStore('messages').delete(key);
        };
      };
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(new Error('cipher_archive_deletion_commit_failed'));
    });
    this.active();
  }
  /** Fresh selected-entry attestation. Publisher comes from the trusted recovery
   * configuration, never from the received document. Terminal marks survive
   * restore into this database; a fresh database still needs a current sync.
   */
  async verifyDeletionPage(value: unknown, source: Source, scope: string, publisher: string, nonce: string) {
    this.active();
    const page = await verifyArchiveDeletionPage(value, this.pin, {
      genesis: this.own.genesis, user: this.user, owner: this.own.owner, publisher, source, scope,
    }, nonce);
    this.active(); return page;
  }
  async applyDeletions(value: unknown, source: Source, scope: string, publisher: string, nonce: string) {
    this.active();
    const receipt = await verifyArchiveDeletion(value, this.pin, {
      genesis: this.own.genesis, user: this.user, owner: this.own.owner, publisher, source, scope,
    }, nonce);
    const checkpointKey = 'checkpoint:' + await this.key(source, scope, scope);
    const deletedIds = new Set(receipt.body.deleted);
    const previous = await this.get('config', checkpointKey);
    if (previous) {
      const old = JSON.parse(decoder.decode(await decryptArchive(this.root, this.own.owner, this.context, checkpointKey, previous)));
      if (receipt.body.publisher !== old.body.publisher || receipt.body.version < old.body.version ||
          (receipt.body.version === old.body.version && receipt.body.root !== old.body.root) ||
          !old.body.deleted.every((id: string) => deletedIds.has(id))) throw new Error('cipher_archive_deletion_rollback');
    }
    const keys = await Promise.all(receipt.body.deleted.map(id => this.key(source, scope, id)));
    const sealed = await encryptArchive(this.root, this.own.owner, this.context, checkpointKey, accountBytes(receipt));
    const marker = await this.deletionMarker(checkpointKey, receipt);
    const keySet = new Set(keys);
    this.active();
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction(['messages', 'config'], 'readwrite');
      this.guardKey(tx);
      const config = tx.objectStore('config'), messages = tx.objectStore('messages');
      const current = config.get(checkpointKey);
      current.onsuccess = () => {
        // Cryptography runs before the transaction. Compare-and-swap prevents a
        // competing tab from replacing a newer checkpoint during that await.
        if (JSON.stringify(current.result) !== JSON.stringify(previous)) { tx.abort(); return; }
        const names = new Set<string>([checkpointKey, ...keys.map(key => 'deleted:' + key)]);
        let size = accountBytes({ key: checkpointKey, sealed }).length + 4096;
        let checkpoints = 1, completed = 0;
        for (const store of ['messages', 'config']) {
          const cursor = tx.objectStore(store).openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (row) {
              if (typeof row.key !== 'string') { tx.abort(); return; }
              if (store === 'config') names.add(row.key);
              if ((store === 'messages' && !keySet.has(row.key)) ||
                  (store === 'config' && row.key.startsWith('checkpoint:') && row.key !== checkpointKey)) {
                size += accountBytes({ key: row.key, sealed: row.value }).length + 1;
                if (store === 'config') checkpoints++;
              }
              if (names.size > ARCHIVE_DELETION_LIMIT + 129 || checkpoints > 128 || size > 16 * 1048576) { tx.abort(); return; }
              row.continue();
            } else if (++completed === 2) {
              if ([...names].filter(name => name.startsWith('deleted:')).length > ARCHIVE_DELETION_LIMIT) { tx.abort(); return; }
              config.put(sealed, checkpointKey);
              for (const key of keys) { config.put(marker, 'deleted:' + key); messages.delete(key); }
            }
          };
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new Error('cipher_archive_deletion_commit_failed'));
    });
    this.active();
    return { deleted: keys.length, root: receipt.body.root, version: receipt.body.version };
  }
  private deletionMarker(checkpointKey: string, receipt: ArchiveDeletion) {
    // Markers are only presence guards. Keep one compact encrypted reference
    // rather than duplicating a potentially large signed bundle for every ID.
    return encryptArchive(this.root, this.own.owner, this.context, checkpointKey + ':marker',
      accountBytes(['sfera-mesh-terminal-marker-v2', receipt.body.root, receipt.body.version]));
  }
  private snapshot() {
    this.active();
    return new Promise<{ rows: Row[]; checkpoints: Row[] }>((resolve, reject) => {
      const tx = this.db.transaction(['messages', 'config'], 'readonly');
      const rows: Row[] = [], checkpoints: Row[] = []; let size = 0;
      for (const store of ['messages', 'config']) {
        const cursor = tx.objectStore(store).openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) return;
          if (typeof item.key !== 'string') { tx.abort(); return; }
          if (store === 'messages' || item.key.startsWith('checkpoint:')) {
            const target = store === 'messages' ? rows : checkpoints;
            const row = { key: item.key, sealed: item.value };
            size += accountBytes(row).length;
            if (target.length >= (store === 'messages' ? LIMIT : 128) || size > 16 * 1048576) { tx.abort(); return; }
            target.push(row);
          }
          item.continue();
        };
      }
      tx.oncomplete = () => resolve({ rows, checkpoints });
      tx.onerror = tx.onabort = () => reject(new Error('cipher_archive_export_limit_or_failure'));
    });
  }
  private async checkpoint(row: Row) {
    const raw = await decryptArchive(this.root, this.own.owner, this.context, row.key, row.sealed);
    const receipt: ArchiveDeletion = JSON.parse(decoder.decode(raw));
    if (decoder.decode(accountBytes(receipt)) !== decoder.decode(raw)) throw new Error('cipher_archive_checkpoint_corrupt');
    const body = receipt?.body;
    // Historical signature verification preserves known deletions without
    // claiming that an exported receipt is a fresh statement about current ACL.
    await verifyArchiveDeletion(receipt, this.pin, { genesis: this.own.genesis,
      user: this.user, owner: this.own.owner, publisher: body?.publisher, source: body?.source, scope: body?.scope },
    body?.nonce, body?.issued_at);
    if (row.key !== 'checkpoint:' + await this.key(body.source, body.scope, body.scope)) throw new Error('cipher_archive_checkpoint_corrupt');
    return receipt;
  }
  private newer(a: ArchiveDeletion, b: ArchiveDeletion) {
    if (a.body.publisher !== b.body.publisher || (a.body.version === b.body.version && a.body.root !== b.body.root)) throw new Error('cipher_archive_deletion_rollback');
    const [older, newer] = a.body.version <= b.body.version ? [a, b] : [b, a];
    const deleted = new Set(newer.body.deleted);
    if (!older.body.deleted.every(id => deleted.has(id))) throw new Error('cipher_archive_deletion_rollback');
    return newer === a ? a : b;
  }
  async export(): Promise<Exported> {
    const { rows, checkpoints } = await this.snapshot();
    for (const row of rows) await this.unseal(row.key, row.sealed);
    for (const row of checkpoints) await this.checkpoint(row);
    this.active();
    const archive: Exported = { domain: 'sfera-mesh-cipher-archive-export-v2', context: this.context, rows, checkpoints };
    if (accountBytes(archive).length > 16 * 1048576) throw new Error('cipher_archive_export_limit_or_failure');
    return archive;
  }
  private async parseExport(value: unknown) {
    this.active();
    const archive = JSON.parse(JSON.stringify(value)) as { domain: string; context: string; rows: Row[]; checkpoints?: Row[] };
    const v2 = archive?.domain === 'sfera-mesh-cipher-archive-export-v2';
    if (!archive || Object.keys(archive).sort().join(',') !== (v2 ? 'checkpoints,context,domain,rows' : 'context,domain,rows') ||
        (!v2 && archive.domain !== 'sfera-mesh-cipher-archive-export-v1') || archive.context !== this.context ||
        !Array.isArray(archive.rows) || archive.rows.length > LIMIT || accountBytes(archive).length > 16 * 1048576) throw new Error('invalid_cipher_archive_export');
    if (v2 && (!Array.isArray(archive.checkpoints) || archive.checkpoints.length > 128)) throw new Error('invalid_cipher_archive_export');
    const checkpoints = archive.checkpoints ?? [];
    const seen = new Set<string>();
    const scopes = new Map<string, { source: Source; scope: string }>();
    for (const row of archive.rows) {
      if (!row || Object.keys(row).sort().join(',') !== 'key,sealed' || typeof row.key !== 'string' || seen.has(row.key)) throw new Error('invalid_cipher_archive_export');
      const body = await this.unseal(row.key, row.sealed); seen.add(row.key);
      scopes.set(body.source + body.scope, { source: body.source, scope: body.scope });
    }
    for (const row of checkpoints) {
      if (!row || Object.keys(row).sort().join(',') !== 'key,sealed' || typeof row.key !== 'string' || seen.has(row.key)) throw new Error('invalid_cipher_archive_export');
      const receipt = await this.checkpoint(row); seen.add(row.key);
      scopes.set(receipt.body.source + receipt.body.scope, { source: receipt.body.source, scope: receipt.body.scope });
    }
    if (scopes.size > 128) throw new Error('invalid_cipher_archive_export');
    return { rows: archive.rows, checkpoints, scopes: [...scopes.values()] };
  }
  async exportScopes(value?: unknown) {
    const parsed = await this.parseExport(value === undefined ? await this.export() : value);
    return parsed.scopes;
  }
  async inspectCipherExport(value: unknown) {
    const parsed = await this.parseExport(value), wires = [];
    for (const row of parsed.rows) {
      const saved = await this.unseal(row.key, row.sealed), body = JSON.parse(saved.text);
      if (saved.source === 'guild') {
        const wire = parseGuildCipherMessage({ domain: 'sfera-guild-cipher-message-v1', guild: body.guild,
          scope: saved.scope, id: saved.id, sender: body.sender, envelope: saved.envelope }, body.guild, saved.scope);
        openGuildCipherBody(wire, saved.text, saved.authorization); wires.push(wire);
      } else {
        const wire = parseDmCipherMessage({ domain: 'sfera-dm-cipher-message-v1', scope: saved.scope,
          id: saved.id, sender: body.sender, envelope: saved.envelope }, saved.scope);
        openDmCipherBody(wire, saved.text, saved.authorization); wires.push(wire);
      }
    }
    this.active(); return wires;
  }
  async inspectDmExport(value: unknown) {
    const wires = await this.inspectCipherExport(value);
    return wires.map(wire => {
      if (wire.domain !== 'sfera-dm-cipher-message-v1') throw new Error('dm_archive_source_mismatch');
      return wire;
    });
  }
  /** Rewrap authenticated history for another device of the same owner.
   * Entry/user boundaries stay intact: crossing them requires an explicit
   * federation mapping, never a rewrite of the original signed proof.
   * No SDK or ratchet state is copied. Callers must still check live status
   * before restore, just as with an ordinary archive backup.
   */
  async rewrapFrom(source: CipherArchive, value: unknown): Promise<Exported> {
    this.active(); source.active();
    if (this.own.owner !== source.own.owner || this.own.network !== source.own.network ||
        this.own.genesis !== source.own.genesis || this.pin.nodeId !== source.pin.nodeId ||
        this.pin.publicKey !== source.pin.publicKey || this.user !== source.user) throw new Error('cipher_archive_transfer_context');
    const parsed = await source.parseExport(value);
    const rows: Row[] = [], checkpoints: Row[] = [];
    for (const row of parsed.rows) {
      const saved = await source.unseal(row.key, row.sealed);
      const key = await this.key(saved.source, saved.scope, saved.id);
      await this.validate(saved, key);
      rows.push({ key, sealed: await encryptArchive(this.root, this.own.owner, this.context, key, accountBytes(saved)) });
    }
    for (const row of parsed.checkpoints) {
      const receipt = await source.checkpoint(row);
      const key = 'checkpoint:' + await this.key(receipt.body.source, receipt.body.scope, receipt.body.scope);
      checkpoints.push({ key, sealed: await encryptArchive(this.root, this.own.owner, this.context, key, accountBytes(receipt)) });
    }
    const result: Exported = { domain: 'sfera-mesh-cipher-archive-export-v2', context: this.context, rows, checkpoints };
    await this.parseExport(result);
    this.active(); source.active(); return result;
  }
  async messages(source: Source, scope: string) {
    await this.key(source, scope, scope);
    const { rows } = await this.snapshot();
    const messages = [];
    for (const row of rows) {
      const value = await this.unseal(row.key, row.sealed);
      if (value.source === source && value.scope === scope && !await this.get('config', 'deleted:' + row.key)) {
        messages.push({ id: value.id, text: value.text, sender: value.sender });
      }
    }
    this.active(); return messages;
  }
  /** Low-level historical import. The UI must first obtain fresh receipts for
   * every imported scope. Restoring a backup alone never establishes freshness.
   */
  async restore(value: unknown, options: { currentCheckpointsRequired?: boolean } = {}) {
    const archive = await this.parseExport(value);
    const snapshot = await this.snapshot();
    const checkpoints = new Map(snapshot.checkpoints.map(row => [row.key, row]));
    if (options.currentCheckpointsRequired) {
      for (const scope of archive.scopes) {
        if (!checkpoints.has('checkpoint:' + await this.key(scope.source, scope.scope, scope.scope))) throw new Error('cipher_archive_current_checkpoint_required');
      }
    }
    for (const incoming of archive.checkpoints) {
      const existing = checkpoints.get(incoming.key);
      if (!existing) checkpoints.set(incoming.key, incoming);
      else {
        const old = await this.checkpoint(existing), next = await this.checkpoint(incoming);
        if (options.currentCheckpointsRequired && next.body.version > old.body.version) throw new Error('cipher_archive_deletion_rollback');
        if (this.newer(old, next) === next) checkpoints.set(incoming.key, incoming);
      }
    }
    if (checkpoints.size > 128) throw new Error('cipher_archive_checkpoint_limit');
    const deleted = new Map<string, ArchiveMessage>();
    for (const row of checkpoints.values()) {
      const receipt = await this.checkpoint(row);
      const marker = await this.deletionMarker(row.key, receipt);
      for (const id of receipt.body.deleted) deleted.set(await this.key(receipt.body.source, receipt.body.scope, id), marker);
    }
    if (deleted.size > ARCHIVE_DELETION_LIMIT) throw new Error('cipher_archive_checkpoint_limit');
    if (accountBytes({ domain: 'sfera-mesh-cipher-archive-export-v2', context: this.context,
      rows: archive.rows.filter(row => !deleted.has(row.key)), checkpoints: [...checkpoints.values()] }).length > 16 * 1048576) throw new Error('cipher_archive_export_limit_or_failure');
    this.active();
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction(['messages', 'config'], 'readwrite'), store = tx.objectStore('messages');
      this.guardKey(tx);
      const count = store.count();
      count.onsuccess = () => {
        if (count.result !== 0) { tx.abort(); return; }
        const config = tx.objectStore('config');
        const cursor = config.openCursor(); const current: Row[] = [];
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (item) { if (typeof item.key === 'string' && item.key.startsWith('checkpoint:')) current.push({ key: item.key, sealed: item.value }); item.continue(); return; }
          if (JSON.stringify(current) !== JSON.stringify(snapshot.checkpoints)) { tx.abort(); return; }
          for (const row of checkpoints.values()) config.put(row.sealed, row.key);
          for (const [key, sealed] of deleted) config.put(sealed, 'deleted:' + key);
          for (const row of archive.rows) {
            if (deleted.has(row.key)) continue;
            const marker = config.get('deleted:' + row.key);
            marker.onsuccess = () => { if (marker.result === undefined) store.add(row.sealed, row.key); };
          }
        };
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new Error('cipher_archive_restore_requires_empty_store'));
    });
    this.active();
  }
  /** Atomically re-encrypt the complete local store, then close this instance.
   * Save the wrapped replacement key before calling; reopen with it afterwards.
   * Stale writers compare the persisted key marker and abort their transactions.
   */
  async rotateRoot(replacement: Uint8Array) {
    this.active(); const nextRoot = new Uint8Array(replacement);
    try {
      if (nextRoot.length !== 32 || await accountDigest(nextRoot) === await accountDigest(this.root)) throw new Error('invalid_archive_replacement_key');
      const before = await new Promise<{ messages: Row[]; config: Row[] }>((resolve, reject) => {
        const result = { messages: [] as Row[], config: [] as Row[] };
        const tx = this.db.transaction(['messages', 'config'], 'readonly'); let size = 0;
        for (const store of ['messages', 'config'] as const) {
          const cursor = tx.objectStore(store).openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result; if (!row) return;
            if (typeof row.key !== 'string') { tx.abort(); return; }
            const value = { key: row.key, sealed: row.value }; size += accountBytes(value).length;
            if (size > 32 * 1048576 || result[store].length >= (store === 'messages' ? LIMIT : ARCHIVE_DELETION_LIMIT + 129)) { tx.abort(); return; }
            result[store].push(value); row.continue();
          };
        }
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(new Error('cipher_archive_rotation_snapshot_failed'));
      });
      const after = { messages: [] as Row[], config: [] as Row[] };
      for (const store of ['messages', 'config'] as const) for (const row of before[store]) {
        this.active();
        if (store === 'messages') await this.unseal(row.key, row.sealed);
        else if (row.key.startsWith('checkpoint:')) await this.checkpoint(row);
        else if (row.key !== 'key' && !/^(deleted|history):[0-9a-f]{64}$/.test(row.key)) throw new Error('cipher_archive_rotation_unknown_metadata');
        const messageId = row.sealed?.messageId;
        if (store === 'messages' ? messageId !== row.key : row.key.startsWith('deleted:')
          ? messageId !== row.key && !/^checkpoint:[0-9a-f]{64}:marker$/.test(messageId)
          : messageId !== row.key) throw new Error('cipher_archive_rotation_metadata_context');
        const raw = await decryptArchive(this.root, this.own.owner, this.context, messageId, row.sealed);
        try {
          const sealed = await encryptArchive(nextRoot, this.own.owner, this.context, messageId, raw);
          const checked = await decryptArchive(nextRoot, this.own.owner, this.context, messageId, sealed);
          try { if (await accountDigest(raw) !== await accountDigest(checked)) throw new Error('cipher_archive_rotation_verification_failed'); }
          finally { checked.fill(0); }
          after[store].push({ key: row.key, sealed });
        } finally { raw.fill(0); }
      }
      this.active();
      await new Promise<void>((resolve, reject) => {
        const tx = this.db.transaction(['messages', 'config'], 'readwrite', { durability: 'strict' });
        this.guardKey(tx); const seen = { messages: [] as Row[], config: [] as Row[] }; let done = 0;
        for (const store of ['messages', 'config'] as const) {
          const cursor = tx.objectStore(store).openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (row) { seen[store].push({ key: String(row.key), sealed: row.value }); row.continue(); return; }
            if (++done !== 2) return;
            if (JSON.stringify(seen) !== JSON.stringify(before) || this.closed) { tx.abort(); return; }
            for (const name of ['messages', 'config'] as const) for (const row of after[name]) tx.objectStore(name).put(row.sealed, row.key);
          };
        }
        tx.oncomplete = () => { this.close(); resolve(); };
        tx.onabort = tx.onerror = () => reject(new Error('cipher_archive_rotation_conflict_or_failure'));
      });
    } finally { nextRoot.fill(0); }
  }
  close() {
    for (const archive of this.histories) archive.close(); this.histories.clear();
    if (this.closed) return;
    this.closed = true; this.root.fill(0); this.db.close();
  }
}
