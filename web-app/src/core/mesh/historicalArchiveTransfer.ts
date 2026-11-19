/** Historical caches keep the source application's identity/ACL namespace.
 * The selected target only owns the local encryption key, never those ACLs.
 */
import { applicationKeys, answerApplicationChallenge } from './applicationAuth';
import { meshUserId } from './account';
import { meshDeviceId } from './devices';
import { entryProbeNonce, verifyEntryProbe, validateTrustedEntryPoints, type TrustedEntryPoint } from './entryPoint';
import { openDeviceArchiveKey, type DeviceArchiveKeyFile, type DeviceArchiveContext } from './deviceArchiveKeys';
import { CipherArchive } from './cipherArchive';
import { verifyDmCipherStatus } from './dmCipherStatus';
import { verifyGuildCipherStatus } from './guildCipherStatus';
import type { CipherIdentity } from './pairwiseCipher';
import { confirmArchiveDevice } from './archiveDeviceAdmission';

type Wire = Awaited<ReturnType<CipherArchive['inspectCipherExport']>>[number];
export class HistoricalArchiveTransfer {
  private token = '';
  private own: CipherIdentity;
  private pin: TrustedEntryPoint;
  private user: string;
  private guard: () => boolean;
  private transport: typeof fetch;
  private closed = false;
  private factor = '';
  private constructor(pin: TrustedEntryPoint, user: string, own: CipherIdentity, guard: () => boolean, transport: typeof fetch) {
    this.pin = pin; this.user = user; this.own = own; this.guard = guard; this.transport = transport;
  }
  private active() { if (this.closed || !this.guard()) throw new Error('historical_transfer_closed'); }
  private async post(path: string, body: unknown, authenticated = false) {
    this.active();
    const transport = this.transport;
    const response = await transport(this.pin.url + path, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
      signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer ' + this.token } : {}) }, body: JSON.stringify(body) });
    if (!response.body) throw new Error('historical_source_unavailable');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length;
      if (size > 1048576) { await reader.cancel(); throw new Error('historical_response_limit'); } chunks.push(next.value); } }
    finally { reader.releaseLock(); }
    this.active();
    const raw = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (response.status === 409 && data.error === 'second_factor_required' && typeof data.challenge === 'string') { this.factor = data.challenge; return null; }
    if (!response.ok) throw new Error('historical_source_rejected'); return data;
  }
  private async probe() {
    const nonce = entryProbeNonce();
    if (await verifyEntryProbe(await this.post('/api/auth/mesh/entry/', { nonce }), this.pin, nonce) !== this.own.genesis) throw new Error('historical_source_genesis');
  }
  private acceptLogin(result: { access: string } | null) {
    this.active(); if (!result) return false;
    if (typeof result.access !== 'string' || result.access.length > 32768) throw new Error('historical_login_rejected');
    const jwt = JSON.parse(atob(result.access.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))), session = jwt.mesh_session;
    if (jwt.user_id !== this.user || !Number.isSafeInteger(jwt.exp) || jwt.exp <= Date.now() / 1000 || !session ||
        Object.keys(session).sort().join(',') !== 'device,entry,genesis,id,owner' || !/^[0-9a-f]{64}$/.test(session.id) ||
        session.owner !== this.own.owner || session.device !== this.own.device || session.genesis !== this.own.genesis || session.entry !== this.pin.nodeId) throw new Error('historical_login_context');
    this.token = result.access; this.factor = ''; return true;
  }
  static async login(pin: TrustedEntryPoint, value: unknown, password: string, target: CipherIdentity, guard: () => boolean, transport = fetch) {
    const { network, nodeId, publicKey, url, label } = pin;
    [pin] = await validateTrustedEntryPoints([{ network, nodeId, publicKey, url, label }]);
    const keys = applicationKeys(value, pin.url);
    const own = { network: keys.network, genesis: keys.genesis, owner: await meshUserId(keys.ownerPublic), device: await meshDeviceId(keys.devicePublic) };
    if (keys.entry !== pin.nodeId || own.network !== pin.network || own.network !== target.network || own.genesis !== target.genesis ||
        own.owner !== target.owner || own.device !== target.device) throw new Error('historical_new_device_context');
    const client = new HistoricalArchiveTransfer(pin, keys.applicationUser, own, guard, transport);
    try {
      await client.probe();
      const challenge = await client.post('/api/auth/mesh/login/challenge/', { owner: own.owner, device: own.device });
      const proof = await answerApplicationChallenge(keys, password, challenge, 'login');
      client.active(); client.acceptLogin(await client.post('/api/auth/mesh/login/', proof)); return client;
    } catch (error) { client.close(); throw error; }
  }
  get needsFactor() { this.active(); return !!this.factor; }
  async secondFactor(code: string) {
    this.active(); if (!this.factor) throw new Error('historical_factor_missing');
    await this.probe(); return this.acceptLogin(await this.post('/api/auth/mesh/login/2fa/', { challenge: this.factor, code }));
  }
  async open(target: CipherArchive) {
    this.active(); if (!this.token) throw new Error('historical_login_required');
    return target.historical(this.pin, this.user);
  }
  private async statuses(archive: CipherArchive, snapshot: unknown) {
    this.active(); if (!this.token) throw new Error('historical_login_required');
    const wires = await archive.inspectCipherExport(snapshot), groups = new Map<string, Wire[]>();
    for (const wire of wires) { const key = JSON.stringify([wire.domain, wire.scope, 'guild' in wire ? wire.guild : null]); groups.set(key, [...(groups.get(key) ?? []), wire]); }
    let expires = Infinity;
    // Status verification only uses owner/device context. Historical SDK keys
    // are checked from each original entry-signed authorization, not copied.
    const own = { ...this.own, ed25519: '', curve25519: '' };
    for (const group of groups.values()) for (let offset = 0; offset < group.length; offset += 16) {
      const batch = group.slice(offset, offset + 16), first = batch[0], nonce = entryProbeNonce(); await this.probe();
      const path = first.domain === 'sfera-dm-cipher-message-v1'
        ? '/api/conversations/' + first.scope + '/messages/cipher/status/'
        : '/api/guilds/' + first.guild + '/channels/' + first.scope + '/messages/cipher/status/';
      const response = await this.post(path, { nonce, messages: batch }, true);
      const checked = first.domain === 'sfera-dm-cipher-message-v1'
        ? await verifyDmCipherStatus(response, this.pin, own, this.user, first.scope, nonce, batch as Extract<Wire, { domain: 'sfera-dm-cipher-message-v1' }>[]) 
        : await verifyGuildCipherStatus(response, this.pin, own, this.user, first.guild, first.scope, nonce, batch as Extract<Wire, { domain: 'sfera-guild-cipher-message-v1' }>[]);
      expires = Math.min(expires, checked.expiresAt);
      for (const status of checked.messages) {
        if (status.state === 'unknown') throw new Error('historical_current_status_unavailable');
        if (status.state === 'deleted') await archive.removeLocal(first.domain === 'sfera-dm-cipher-message-v1' ? 'dm' : 'guild', first.scope, status.id);
      }
    }
    this.active(); if (expires <= Date.now() / 1000) throw new Error('historical_status_expired'); return expires;
  }
  async import(archive: CipherArchive, value: unknown, keyFile: unknown, password: string) {
    this.active();
    const document = JSON.parse(JSON.stringify(keyFile)) as DeviceArchiveKeyFile, body = document?.body;
    if (!body || body.network !== this.own.network || body.genesis !== this.own.genesis || body.owner !== this.own.owner || body.entry !== this.pin.nodeId || body.user !== this.user) throw new Error('historical_archive_context');
    await this.probe();
    await confirmArchiveDevice((path, request) => this.post(path, request, true), this.pin, this.own, this.user, body.device, body.device_public);
    const context: DeviceArchiveContext = { network: body.network, genesis: body.genesis, owner: body.owner, device: body.device, device_public: body.device_public, entry: body.entry, user: body.user };
    const opened = await openDeviceArchiveKey(document, password, context); let source: CipherArchive | undefined;
    try {
      source = await CipherArchive.open(context, this.pin, this.user, opened.root, { deviceLocal: true });
      const converted = await archive.rewrapFrom(source, value);
      const expires = await this.statuses(archive, converted); this.active();
      if (expires <= Date.now() / 1000) throw new Error('historical_status_expired');
      await archive.restore(converted); this.active(); return (await archive.export()).rows.length;
    } finally { source?.close(); opened.root.fill(0); }
  }
  async read(archive: CipherArchive) {
    const snapshot = await archive.export(), expires = await this.statuses(archive, snapshot), results = [];
    const wires = await archive.inspectCipherExport(await archive.export());
    for (const wire of wires) {
      const source = wire.domain === 'sfera-dm-cipher-message-v1' ? 'dm' : 'guild';
      const saved = await archive.read(source, wire.scope, wire.id);
      if (saved) results.push({ id: wire.id, source, scope: wire.scope, text: JSON.parse(saved.text).payload.text as string });
    }
    this.active(); if (expires <= Date.now() / 1000) throw new Error('historical_status_expired'); return results;
  }
  close() { this.closed = true; this.token = ''; this.factor = ''; }
}
