import {applicationDeviceAccess} from './applicationActions';
import { GuildCipherSession } from './guildCipherSession';
import { signApplicationSignal } from './applicationSignals';
import { signDeviceApplicationDialog } from './applicationDialogs';
import type { GuildCipherMessage } from './guildCipherMessage';
/** Unlock only the device vault. Identity roots never leave this function. */
import { applicationKeys, type ApplicationKeys } from './applicationAuth';
import { accountBytes, accountDigest, meshUserId } from './account';
import { meshDeviceId } from './devices';
import { unlockVault } from './vault';
import { signCipherCertificate, type CipherScopeBody } from './cipherPolicy';
import { DmCipherCoordinator } from './dmCipherCoordinator';
import { DmCipherOutbox } from './dmCipherOutbox';
import type { DmCipherText } from './dmCipherMessage';
import type { TrustedEntryPoint } from './entryPoint';
import { CipherArchive } from './cipherArchive';
import { parseDmCipherMessage } from './dmCipherMessage';
import { entryProbeNonce } from './entryPoint';
import { verifyDmReadReceipt } from './dmCipherRead';
import { openDeviceArchiveKey, prepareDeviceArchiveKey, type DeviceArchiveContext, type DeviceArchiveKeyFile } from './deviceArchiveKeys';

type Options = {
  distributed?:boolean; guard: () => boolean; token: () => string;
  review: (body: CipherScopeBody) => Promise<boolean>; transport?: typeof fetch;
  archiveKey?: { file: unknown; password: string }; profileGuard?: boolean };
export { DmCipherQueuedError } from './cipherQueuedError';
import { DmCipherQueuedError } from './cipherQueuedError';
function claim(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || token.length > 32768) throw new Error('dm_cipher_mesh_login_required');
  try { return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))); }
  catch { throw new Error('dm_cipher_mesh_login_required'); }
}
async function derive(root: Uint8Array, context: unknown, purpose: string) {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(root).buffer, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256',
    salt: new TextEncoder().encode(purpose), info: new Uint8Array(accountBytes(context)).buffer }, key, 256));
}
export class DmCipherSession {
  readonly coordinator: DmCipherCoordinator;
  readonly outbox: DmCipherOutbox;
  readonly archive: CipherArchive;
  readonly guild: GuildCipherSession;
  private readKey?: CryptoKey;
  private pin: TrustedEntryPoint;
  private user: string;
  private current: () => boolean;
  private archiveContext!: DeviceArchiveContext;
  private archiveDescriptor?: DeviceArchiveKeyFile;
  private readonly distributed: boolean;
  private constructor(coordinator: DmCipherCoordinator, outbox: DmCipherOutbox, archive: CipherArchive,
    guildOutbox: DmCipherOutbox<GuildCipherMessage>, readKey: CryptoKey, pin: TrustedEntryPoint, user: string, current: () => boolean, distributed: boolean) {
    this.distributed = distributed;
    this.coordinator = coordinator; this.outbox = outbox; this.archive = archive;
    this.guild = new GuildCipherSession(coordinator, guildOutbox, archive);
    this.readKey = readKey; this.pin = pin; this.user = user; this.current = current;
  }
  static async unlock(keys: ApplicationKeys, pin: TrustedEntryPoint, user: string, password: string, options: Options) {
    const archiveCredential = options.archiveKey ? { file: JSON.parse(JSON.stringify(options.archiveKey.file)), password: options.archiveKey.password } : undefined;
    // Neither coordinator/outbox options nor their long-lived guards retain
    // the archive password after this unlock operation finishes.
    options = { distributed:options.distributed,guard: options.guard, token: options.token, review: options.review, transport: options.transport, profileGuard: options.profileGuard };
    keys = applicationKeys(keys, pin.url); pin = { ...pin };
    const own = { network: keys.network, genesis: keys.genesis,
      owner: await meshUserId(keys.ownerPublic), device: await meshDeviceId(keys.devicePublic) };
    const current = () => {
      if (!options.guard()) throw new Error('dm_cipher_context_changed_or_closed');
      // This is a context check; the server still authenticates the JWT.
      const jwt = claim(options.token()), session = jwt.mesh_session as Record<string, unknown> | undefined;
      if (jwt.user_id !== user || !Number.isSafeInteger(jwt.exp) || (jwt.exp as number) <= Date.now() / 1000 ||
          !session || session.owner !== own.owner || session.device !== own.device ||
          session.genesis !== own.genesis || session.entry !== pin.nodeId) throw new Error('dm_cipher_mesh_login_required');
      return true;
    };
    if (keys.applicationUser !== user || keys.entry !== pin.nodeId || keys.network !== pin.network) throw new Error('dm_cipher_key_context_mismatch');
    current();
    let deviceRoot: Uint8Array | undefined, sdkKey: Uint8Array | undefined, outboxRoot: Uint8Array | undefined;
    let coordinator: DmCipherCoordinator | undefined, outbox: DmCipherOutbox | undefined, archive: CipherArchive | undefined;
    let archiveRoot: Uint8Array | undefined, guildOutboxRoot: Uint8Array | undefined;
    let guildOutbox: DmCipherOutbox<GuildCipherMessage> | undefined;
    const archiveContext: DeviceArchiveContext = { ...own, device_public: keys.devicePublic, entry: pin.nodeId, user };
    let archiveDescriptor: DeviceArchiveKeyFile | undefined;
    try {
      const cached=password?undefined:applicationDeviceAccess(pin.url,options.token());
      if(!cached)deviceRoot = await unlockVault(keys.deviceVault, await meshUserId(keys.devicePublic), password);
      const encoded = new Uint8Array(48);
      encoded.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]); if(deviceRoot)encoded.set(deviceRoot,16);
      let readKey: CryptoKey;
      try { readKey=cached?.signer ?? await crypto.subtle.importKey('pkcs8',encoded,'Ed25519',false,['sign']); } finally { encoded.fill(0); }
      current();
      const deriveDevice=(purpose:string)=>cached?cached.derive(own,purpose):derive(deviceRoot!,own,purpose);
      sdkKey = await deriveDevice('sfera-dm-device-sdk-key-v1');
      outboxRoot = await deriveDevice('sfera-dm-device-outbox-key-v1');
      if (archiveCredential) {
        const openedKey = await openDeviceArchiveKey(archiveCredential.file, archiveCredential.password, archiveContext);
        archiveRoot = openedKey.root; archiveDescriptor = openedKey.file;
      } else archiveRoot = await deriveDevice('sfera-dm-device-archive-key-v1');
      guildOutboxRoot = await deriveDevice('sfera-guild-device-outbox-key-v1');
      const guarded = { ...options, guard: current, profile: {signer:readKey,devicePublic:keys.devicePublic,enabled:options.profileGuard===true} };
      coordinator = await DmCipherCoordinator.open(own, pin, user,
        Array.from(sdkKey, byte => byte.toString(16).padStart(2, '0')).join(''), guarded);
      const certificate = await signCipherCertificate(coordinator.publicIdentity(), keys.devicePublic, cached?.signer??deviceRoot!);
      await coordinator.registerDevice(certificate);
      current();
      const opened = coordinator;
      outbox = await DmCipherOutbox.open(own, pin, user, outboxRoot, { ...guarded,
        publishDistributed:(scope,cipher,queuedAt)=>opened.publishMessage(scope,cipher,queuedAt),
        sealAuthorized: (scope, id, payload) => opened.sealAuthorized(scope, id, payload),
        seal: (scope, id, payload) => opened.seal(scope, id, payload) });
      guildOutbox = await DmCipherOutbox.open<GuildCipherMessage>(own, pin, user, guildOutboxRoot, { ...guarded, source: 'guild',
        sealAuthorized: (scope, id, payload, guild) => opened.sealGuild(guild!, scope, id, payload),
        seal: async (scope, id, payload, guild) => (await opened.sealGuild(guild!, scope, id, payload)).wire });
      archive = await CipherArchive.open(own, pin, user, archiveRoot, { deviceLocal: true });
      current();
      current();
      const session = new DmCipherSession(coordinator, outbox, archive, guildOutbox, readKey, pin, user, current, options.distributed === true);
      session.archiveContext = archiveContext; session.archiveDescriptor = archiveDescriptor;
      return session;
    } catch (error) {
      archive?.close(); await Promise.all([outbox?.close(), guildOutbox?.close(), coordinator?.close()]); throw error;
    } finally { deviceRoot?.fill(0); sdkKey?.fill(0); outboxRoot?.fill(0); archiveRoot?.fill(0); guildOutboxRoot?.fill(0); }
  }
  async prepare(scope: string) { await this.coordinator.publishKeys(scope); }
  async signSignal(recipientOwner: string, signal: Record<string, unknown>) {
    this.current();
    if (!this.readKey) throw new Error('cipher_session_closed');
    const context = this.archiveContext;
    const packet = await signApplicationSignal({ network: context.network, genesis: context.genesis,
      owner: context.owner, device: context.device, devicePublic: context.device_public }, this.readKey, recipientOwner, signal);
    this.current();
    return packet;
  }
  async createDialog(peerOwner: string, controlEpoch: number, deviceHistoryVersion: number) {
    this.current();
    if (!this.readKey) throw new Error('cipher_session_closed');
    const context = this.archiveContext;
    const record = await signDeviceApplicationDialog({network:context.network,genesis:context.genesis,
      owner:context.owner,device:context.device,devicePublic:context.device_public},this.readKey,peerOwner,controlEpoch,deviceHistoryVersion);
    this.current();
    return record;
  }
  async send(scope: string, payload: DmCipherText) {
    const intent = await this.outbox.create(scope, payload);
    try { await this.prepare(scope); const sent = await this.outbox.send(intent.id); await this.archiveAccepted(sent.id); return sent; }
    catch (error) { throw new DmCipherQueuedError(intent.id, error); }
  }
  async receive(scope: string) {
    if (!this.distributed) await this.prepare(scope);
    const received = await this.coordinator.receiveKeys(scope);
    if (this.distributed && received > 0) await this.prepare(scope);
    return received;
  }
  async archiveAccepted(id: string) {
    const record = (await this.outbox.list()).find(row => row.id === id);
    if (!record || record.state !== 'accepted' || !record.wire) return;
    const checked = await this.coordinator.messageStatus(record.scope, [record.wire]);
    const [status] = checked.messages;
    if (status.state === 'deleted') { await this.erase(record.scope, status.id, status.digest); return; }
    if (status.state !== 'present') throw new Error('cipher_archive_current_status_unavailable');
    const cached = await this.archive.read('dm', record.scope, id);
    const saved = cached ? await this.coordinator.openArchived(record.scope, record.wire, this.archive)
      : await this.coordinator.archiveOutgoing(record.scope, record.wire, record.payload, this.archive, record.authorization);
    if (saved.text !== record.payload.text || saved.replyTo !== record.payload.replyTo) throw new Error('cipher_archive_message_fork');
    if (checked.expiresAt <= Date.now() / 1000) throw new Error('dm_cipher_status_expired');
    // Archive has committed and verified its exact content before queue removal.
    await this.outbox.forget(id);
  }
  async retry(id: string) {
    const record = (await this.outbox.list()).find(row => row.id === id);
    if (!record) throw new Error('dm_outbox_message_missing');
    // Only a draft needs fresh key preparation. Exact prepared retries and
    // archival of accepted messages must not acquire a different roster.
    if (record.state === 'draft') await this.prepare(record.scope);
    const sent = await this.outbox.send(id); await this.archiveAccepted(id); return sent;
  }
  private async erase(scope: string, id: string, digest: string) {
    await this.archive.removeLocal('dm', scope, id);
    await this.outbox.rejectDeleted(id, digest); await this.outbox.forget(id);
  }
  async openMessages(scope: string, values: unknown[]) {
    const wires = values.map(value => parseDmCipherMessage(value, scope));
    let checked = await this.coordinator.messageStatus(scope, wires);
    let statuses = checked.messages;
    const results: Array<{ id: string; text: string | null; sender: { user: string }; deleted: boolean }> = [];
    for (let i = 0; i < wires.length; i++) {
      const wire = wires[i], status = statuses[i];
      if (checked.expiresAt <= Date.now() / 1000) throw new Error('dm_cipher_status_expired');
      if (status.state === 'deleted') {
        await this.erase(scope, status.id, status.digest);
        results.push({ id: status.id, text: null, sender: wire.sender, deleted: true }); continue;
      }
      if (status.state !== 'present') throw new Error('cipher_archive_current_status_unavailable');
      const local = (await this.outbox.list()).find(record => record.id === wire.id && record.wire);
      if (local) {
        if (await accountDigest(accountBytes(local.wire)) !== status.digest) throw new Error('cipher_archive_message_fork');
        if (local.state === 'accepted') await this.archiveAccepted(local.id);
        else if (!await this.archive.read('dm', scope, wire.id)) await this.coordinator.archiveOutgoing(scope, wire, local.payload, this.archive, local.authorization);
      }
      const opened = await this.coordinator.openArchived(scope, wire, this.archive);
      results.push({ ...opened, deleted: false });
    }
    if(checked.expiresAt<=Date.now()/1000){
      checked=await this.coordinator.messageStatus(scope,wires);
      for(const result of results){const fresh=checked.messages.find(m=>m.id===result.id);
        if(!fresh || (result.deleted?fresh.state!=='deleted':fresh.state!=='present'))throw new Error('dm_cipher_status_changed_during_open');}
    }
    return results;
  }
  async drain(scope: string, limit = 8) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) throw new Error('invalid_dm_drain_limit');
    const records = (await this.outbox.list()).filter(record => record.scope === scope && record.state === 'accepted').slice(0, limit);
    for (const record of records) await this.archiveAccepted(record.id);
  }
  async verifyRead(scope: string, value: unknown, receipt: unknown) {
    this.current(); this.coordinator.publicIdentity();
    const wire = parseDmCipherMessage(value, scope), saved = await this.archive.read('dm', scope, wire.id);
    if (!saved || await accountDigest(accountBytes(saved.envelope)) !== await accountDigest(accountBytes(wire.envelope))) throw new Error('cipher_read_requires_archived_message');
    const result = await verifyDmReadReceipt(receipt, wire, saved.authorization, this.pin);
    this.current(); this.coordinator.publicIdentity(); return result;
  }
  async exportArchive() {
    this.current(); this.coordinator.publicIdentity();
    const backup = await this.archive.export();
    this.current(); this.coordinator.publicIdentity(); return backup;
  }
  async prepareArchiveKey(password: string) {
    this.current(); this.coordinator.publicIdentity(); const key = this.readKey;
    if (!key) throw new Error('dm_cipher_context_changed_or_closed');
    const file = await prepareDeviceArchiveKey(this.archiveContext, password, async bytes => {
      this.current(); this.coordinator.publicIdentity();
      return new Uint8Array(await crypto.subtle.sign('Ed25519', key, new Uint8Array(bytes).buffer));
    }, this.archiveDescriptor);
    this.current(); this.coordinator.publicIdentity(); return file;
  }
  /** The supplied file must already have been saved and read back by the UI.
   * All DM/Guild references are closed after commit; reopen with this key file.
   */
  async rotateArchiveKey(value: unknown, password: string) {
    this.current(); this.coordinator.publicIdentity();
    const opened = await openDeviceArchiveKey(value, password, this.archiveContext);
    try {
      const previous = this.archiveDescriptor ? await accountDigest(accountBytes(this.archiveDescriptor)) : '0'.repeat(64);
      const epoch = this.archiveDescriptor ? this.archiveDescriptor.body.epoch + 1 : 1;
      if (opened.file.body.epoch !== epoch || opened.file.body.previous !== previous) throw new Error('device_archive_key_chain_conflict');
      this.current(); this.coordinator.publicIdentity();
      await this.archive.rotateRoot(opened.root);
      await this.close();
      return { epoch };
    } finally { opened.root.fill(0); }
  }
  async importArchive(value: unknown) {
    this.current(); this.coordinator.publicIdentity();
    const snapshot = JSON.parse(JSON.stringify(value));
    if ((await this.archive.export()).rows.length) throw new Error('cipher_archive_restore_requires_empty_store');
    const wires = await this.archive.inspectCipherExport(snapshot);
    let expires = Infinity;
    const dmScopes = new Map<string, Array<Extract<typeof wires[number], { domain: 'sfera-dm-cipher-message-v1' }>>>();
    const guildScopes = new Map<string, { guild: string; scope: string; messages: GuildCipherMessage[] }>();
    for (const wire of wires) {
      if (wire.domain === 'sfera-dm-cipher-message-v1') dmScopes.set(wire.scope, [...(dmScopes.get(wire.scope) ?? []), wire]);
      else {
        const key = wire.guild + ':' + wire.scope, group = guildScopes.get(key) ?? { guild: wire.guild, scope: wire.scope, messages: [] };
        group.messages.push(wire); guildScopes.set(key, group);
      }
    }
    for (const [scope, messages] of dmScopes) {
      for (let offset = 0; offset < messages.length; offset += 16) {
        const batch = messages.slice(offset, offset + 16), checked = await this.coordinator.messageStatus(scope, batch);
        expires = Math.min(expires, checked.expiresAt);
        for (const status of checked.messages) {
          if (checked.expiresAt <= Date.now() / 1000) throw new Error('dm_cipher_status_expired');
          if (status.state === 'unknown') throw new Error('cipher_archive_current_status_unavailable');
          if (status.state === 'deleted') await this.erase(scope, status.id, status.digest);
        }
      }
    }
    for (const { guild, scope, messages } of guildScopes.values()) {
      for (let offset = 0; offset < messages.length; offset += 16) {
        const checked = await this.coordinator.guildMessageStatus(guild, scope, messages.slice(offset, offset + 16));
        expires = Math.min(expires, checked.expiresAt);
        for (const status of checked.messages) {
          if (checked.expiresAt <= Date.now() / 1000) throw new Error('guild_cipher_status_expired');
          if (status.state === 'unknown') throw new Error('cipher_archive_current_status_unavailable');
          if (status.state === 'deleted') {
            await this.archive.removeLocal('guild', scope, status.id);
            await this.guild.outbox.rejectDeleted(status.id, status.digest); await this.guild.outbox.forget(status.id);
          }
        }
      }
    }
    this.current(); this.coordinator.publicIdentity();
    if (expires <= Date.now() / 1000) throw new Error('cipher_archive_status_expired');
    await this.archive.restore(snapshot);
    this.current(); this.coordinator.publicIdentity();
    return { restored: (await this.archive.export()).rows.length };
  }
  /** An old device need not remain admitted: its separately saved archive key
   * proves possession of the historical cache, while this live new-device
   * session checks present ACL and deletions before the atomic import.
   */
  async importDeviceArchive(value: unknown, keyFile: unknown, password: string) {
    this.current(); this.coordinator.publicIdentity();
    const document = JSON.parse(JSON.stringify(keyFile)) as DeviceArchiveKeyFile;
    const body = document?.body, own = this.archiveContext;
    if (!body || body.network !== own.network || body.genesis !== own.genesis ||
        body.owner !== own.owner || body.entry !== own.entry || body.user !== own.user) throw new Error('cipher_archive_transfer_context');
    await this.coordinator.confirmArchiveDevice(body.device, body.device_public);
    const context: DeviceArchiveContext = { network: own.network, genesis: own.genesis, owner: own.owner,
      device: body.device, device_public: body.device_public, entry: own.entry, user: own.user };
    const opened = await openDeviceArchiveKey(document, password, context);
    let source: CipherArchive | undefined;
    try {
      this.current();
      source = await CipherArchive.open(context, this.pin, this.user, opened.root, { deviceLocal: true });
      const converted = await this.archive.rewrapFrom(source, value);
      this.current();
      return await this.importArchive(converted);
    } finally { source?.close(); opened.root.fill(0); }
  }
  async confirmRead(scope: string, value: unknown) {
    this.current(); const key = this.readKey;
    const wire = parseDmCipherMessage(value, scope);
    if (!key || wire.sender.user === this.user || !await this.archive.read('dm', scope, wire.id)) throw new Error('cipher_read_requires_archived_message');
    const [opened] = await this.openMessages(scope, [wire]);
    if (opened.deleted) throw new Error('cipher_message_deleted');
    const own = this.coordinator.publicIdentity(), now = Math.floor(Date.now() / 1000);
    const body = { domain: 'sfera-dm-cipher-read-v1', network: own.network, genesis: own.genesis, entry: this.pin.nodeId,
      user: this.user, owner: own.owner, device: own.device, scope, message_id: wire.id,
      cipher_digest: await accountDigest(accountBytes(wire)), nonce: entryProbeNonce(), issued_at: now, expires_at: now + 60 };
    const signature = Array.from(new Uint8Array(await crypto.subtle.sign('Ed25519', key, new Uint8Array(accountBytes(body)))), byte => byte.toString(16).padStart(2, '0')).join('');
    this.current();
    const response = await this.coordinator.acknowledgeRead(scope, { body, signature }) as { id: string; read_at: string; receipt: unknown };
    if (!response || Object.keys(response).sort().join(',') !== 'id,read_at,receipt' || response.id !== wire.id ||
        typeof response.read_at !== 'string' || !Number.isFinite(Date.parse(response.read_at))) throw new Error('invalid_cipher_read_response');
    await this.verifyRead(scope, wire, response.receipt);
    return response;
  }
  async close() { this.readKey = undefined; this.archive.close(); await Promise.all([this.outbox.close(), this.guild.outbox.close(), this.coordinator.close()]); }
}
