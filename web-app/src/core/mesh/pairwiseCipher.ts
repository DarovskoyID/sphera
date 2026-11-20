/** Pairwise Olm adapter. Relay transports only SDK key documents and ciphertext.
 * Peer pins must be obtained through verified enrollment or an explicit trusted
 * fingerprint check. A key-query response never establishes peer trust.
 */
import type { OlmMachine, Device } from '@matrix-org/matrix-sdk-crypto-wasm';
import { CipherCheckpoints } from './cipherCheckpoints';
import { acquireCipherStoreLock } from './cipherStoreLock';
import { accountBytes, accountDigest } from './account';
import { validateApplicationKeyBody, type ApplicationKeyBody, type ApplicationKeyRecord } from './applicationKeys';
import type { CipherProfileGuard } from './cipherProfileGuard';

type SDK = typeof import('@matrix-org/matrix-sdk-crypto-wasm');
type OutgoingRequest = Awaited<ReturnType<OlmMachine['outgoingRequests']>>[number];
export type CipherIdentity = { network: string; genesis: string; owner: string; device: string };
export type CipherPeer = CipherIdentity & { ed25519: string; curve25519: string };
export type CipherRelay = (request: { id: string; type: number; body: string }) => Promise<string>;
export type PairwiseEnvelope = { algorithm: 'm.olm.v1.curve25519-aes-sha2'; sender_key: string; ciphertext: Record<string, unknown>; key_receipt?: GroupEnvelope };
export type CipherMembership = { scope: string; epoch: number; peers: CipherPeer[] };
export type GroupEnvelope = { room: string; epoch: number; message_id: string; sender_device: string; content: Record<string, unknown> };
const hex = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();
export function cipherUserId(identity: CipherIdentity) {
  if (!identity || !/^[A-Za-z0-9._-]{1,128}$/.test(identity.network) ||
      ![identity.genesis, identity.owner, identity.device].every(value => typeof value === 'string' && hex.test(value))) throw new Error('invalid_cipher_identity');
  return `@${identity.owner}:${identity.genesis}.sphere`;
}
function publicPin(value: string) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}$/.test(value)) throw new Error('invalid_cipher_public_pin');
}
function samePeer(left: CipherPeer, right: CipherPeer) {
  return (['network', 'genesis', 'owner', 'device', 'ed25519', 'curve25519'] as const).every(field => left[field] === right[field]);
}

export async function cipherMembershipRoom(membership: CipherMembership, own: CipherPeer) {
  own = { ...own };
  cipherUserId(own);
  if (!membership || !uuid.test(membership.scope) || !Number.isSafeInteger(membership.epoch) || membership.epoch < 1 ||
      !Array.isArray(membership.peers) || membership.peers.length < 2 || membership.peers.length > 64) throw new Error('invalid_group_membership');
  const seen = new Set<string>();
  let includesSelf = false;
  const peers = membership.peers.map(peer => {
    const user = cipherUserId(peer);
    publicPin(peer.ed25519); publicPin(peer.curve25519);
    if (peer.network !== own.network || peer.genesis !== own.genesis || seen.has(`${user}/${peer.device}`)) throw new Error('invalid_group_membership');
    seen.add(`${user}/${peer.device}`);
    if (peer.owner === own.owner && peer.device === own.device) {
      if (peer.ed25519 !== own.ed25519 || peer.curve25519 !== own.curve25519) throw new Error('group_self_key_mismatch');
      includesSelf = true;
    }
    return [user, peer.device, peer.ed25519, peer.curve25519];
  }).sort((a, b) => a.join(':') < b.join(':') ? -1 : a.join(':') > b.join(':') ? 1 : 0);
  if (!includesSelf) throw new Error('group_device_not_member');
  const bytes = encoder.encode(JSON.stringify(['sfera-mesh-group-context-v1', own.network, own.genesis,
    membership.scope, membership.epoch, peers]));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
  const room = `!${digest}:${own.genesis}.sphere`;
  return room;
}

export class PairwiseCipher {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private disposed = false;
  private memberships = new Map<string, { epoch: number; room: string }>();
  private preparedKeys = new Map<string, { digest: string; body: string }>();
  private checkpoints?: CipherCheckpoints;
  private releaseStore?: () => Promise<void>;
  private closing?: Promise<void>;
  private profileGuard?: CipherProfileGuard;
  private sdk: SDK;
  private machine: OlmMachine;
  private identity: CipherIdentity;
  private relay: CipherRelay;
  private constructor(sdk: SDK, machine: OlmMachine, identity: CipherIdentity, relay: CipherRelay) {
    this.sdk = sdk; this.machine = machine; this.identity = identity; this.relay = relay;
  }

  static async open(identity: CipherIdentity, relay: CipherRelay,
    storage: { mode: 'memory' } | { mode: 'persistent'; passphrase: string; profileGuard?: CipherProfileGuard }) {
    const frozen: CipherIdentity = { network: identity.network, genesis: identity.genesis, owner: identity.owner, device: identity.device };
    const user = cipherUserId(frozen);
    if (storage.mode === 'persistent' && (typeof storage.passphrase !== 'string' || storage.passphrase.length < 32)) throw new Error('encrypted_cipher_store_required');
    const sdk = await import('@matrix-org/matrix-sdk-crypto-wasm');
    await sdk.initAsync();
    const store = storage.mode === 'persistent' ? `sphere-e2ee-v1:${frozen.network}:${frozen.genesis}:${frozen.owner}:${frozen.device}` : undefined;
    const release = store ? await acquireCipherStoreLock(store) : undefined;
    let machine: OlmMachine | undefined;
    let checkpoints: CipherCheckpoints | undefined;
    try {
      if (storage.mode === 'persistent') await storage.profileGuard?.beforeInitialize();
      machine = await sdk.OlmMachine.initialize(new sdk.UserId(user), new sdk.DeviceId(frozen.device),
        store, storage.mode === 'persistent' ? storage.passphrase : undefined);
      // All recipients come from the explicitly reviewed mesh roster. Missing
      // receipt probes must not start Matrix gossip or forward keys implicitly.
      machine.roomKeyRequestsEnabled = false;
      machine.roomKeyForwardingEnabled = false;
      const client = new PairwiseCipher(sdk, machine, frozen, relay);
      client.releaseStore = release;
      if (storage.mode === 'persistent') client.profileGuard=storage.profileGuard;
      if (storage.mode === 'persistent') client.checkpoints = checkpoints = await CipherCheckpoints.open(store!, storage.passphrase);
      if (storage.mode === 'persistent') await storage.profileGuard?.afterInitialize();
      return client;
    } catch (error) {
      try { checkpoints?.close(); machine?.close(); } finally { await release?.(); }
      throw error;
    }
  }

  /** Stateless SDK signature; safe when a relay callback already holds run().
   * Queuing another run() here would deadlock SDK outgoing requests. */
  async signApplicationKeyCommand(value: ApplicationKeyBody): Promise<ApplicationKeyRecord> {
    if (this.closed) throw new Error('cipher_closed');
    const body = JSON.parse(JSON.stringify(value)) as ApplicationKeyBody;
    validateApplicationKeyBody(body);
    if ((['network','genesis','owner','device'] as const).some(field=>body[field]!==this.identity[field])) throw new Error('application_key_actor_mismatch');
    if (this.closed) throw new Error('cipher_closed');
    const signatures=await this.machine.sign(new TextDecoder().decode(accountBytes(body)));
    try {
      const signature=JSON.parse(signatures.asJSON())[cipherUserId(this.identity)]?.['ed25519:'+this.identity.device];
      if (this.closed || typeof signature!=='string' || !/^[A-Za-z0-9+/]{86}$/.test(signature)) throw new Error('application_key_sdk_signature_missing');
      return { body, signature };
    } finally { signatures.free(); }
  }

  publicIdentity(): CipherPeer {
    if (this.closed) throw new Error('cipher_closed');
    const keys = this.machine.identityKeys;
    try {
      return { ...this.identity, ed25519: keys.ed25519.toBase64(), curve25519: keys.curve25519.toBase64() };
    } finally { keys.free(); }
  }

  assertPersistentKeyStore() {
    if (this.closed) throw new Error('cipher_closed');
    if (!this.checkpoints) throw new Error('persistent_cipher_store_required_for_ack');
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      if (this.closed) throw new Error('cipher_closed');
      await this.profileGuard?.begin();
      let result: T;
      try { result = await operation(); } catch(error) {
        // A live process can checkpoint the SDK's actual persisted error state.
        // A crash cannot run this path and leaves its reservation unresolved.
        try { await this.profileGuard?.finish(); } catch { this.profileGuard?.fail(); }
        throw error;
      }
      await this.profileGuard?.finish();
      if (this.closed) throw new Error('cipher_closed');
      return result;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async request(request: OutgoingRequest) {
    try {
      if (this.closed) throw new Error('cipher_closed');
      // No plaintext room messages, secret backups or cross-signing uploads
      // can silently become a new relay operation through this adapter.
      if (![this.sdk.RequestType.KeysUpload, this.sdk.RequestType.KeysQuery, this.sdk.RequestType.KeysClaim].includes(request.type)) throw new Error('unsupported_pairwise_relay_operation');
      if (typeof request.id !== 'string' || !request.id || request.id.length > 256) throw new Error('invalid_cipher_request_id');
      const response = await this.relay({ id: request.id, type: request.type, body: request.body });
      if (this.closed || typeof response !== 'string' || encoder.encode(response).length > 1024 * 1024) throw new Error('invalid_cipher_relay_response');
      await this.machine.markRequestAsSent(request.id, request.type, response);
    } finally { request.free(); }
  }

  publishKeys() {
    return this.run(async () => {
      const requests = await this.machine.outgoingRequests();
      for (let index = 0; index < requests.length; index++) {
        try { await this.request(requests[index]); }
        catch (error) { for (const remaining of requests.slice(index + 1)) remaining.free(); throw error; }
      }
    });
  }

  private async trustedDevice(peer: CipherPeer): Promise<Device> {
    if (peer.network !== this.identity.network || peer.genesis !== this.identity.genesis ||
        (peer.owner === this.identity.owner && peer.device === this.identity.device)) throw new Error('cipher_peer_context_mismatch');
    publicPin(peer.ed25519); publicPin(peer.curve25519);
    const user = cipherUserId(peer);
    await this.request(this.machine.queryKeysForUsers([new this.sdk.UserId(user)]));
    const device = await this.machine.getDevice(new this.sdk.UserId(user), new this.sdk.DeviceId(peer.device));
    if (!device) throw new Error('cipher_peer_device_missing');
    const signing = device.getKey(this.sdk.DeviceKeyAlgorithmName.Ed25519);
    const agreement = device.getKey(this.sdk.DeviceKeyAlgorithmName.Curve25519);
    try {
      if (signing?.toBase64() !== peer.ed25519 || agreement?.toBase64() !== peer.curve25519 || device.isDeleted()) throw new Error('cipher_peer_key_changed');
      // This trust comes from the caller's explicit pins, never the relay.
      await device.setLocalTrust(this.sdk.LocalTrust.Verified);
      return device;
    } catch (error) { device.free(); throw error; }
    finally { signing?.free(); agreement?.free(); }
  }

  encrypt(peer: CipherPeer, scope: string, messageId: string, text: string): Promise<PairwiseEnvelope> {
    const pin: CipherPeer = JSON.parse(JSON.stringify(peer));
    if (!uuid.test(scope) || !uuid.test(messageId) || typeof text !== 'string' || encoder.encode(text).length > 32768) return Promise.reject(new Error('invalid_pairwise_message'));
    return this.run(async () => {
      const device = await this.trustedDevice(pin);
      try {
        const claim = await this.machine.getMissingSessions([new this.sdk.UserId(cipherUserId(pin))]);
        if (claim) await this.request(claim);
        const content = { domain: 'sfera-mesh-pairwise-text-v1', network: this.identity.network,
          genesis: this.identity.genesis, scope, message_id: messageId,
          sender_device: this.identity.device, recipient_device: pin.device, text };
        // The WASM call consumes the strategy value.
        return JSON.parse(await device.encryptToDeviceEvent('sfera.mesh.message', content,
          this.sdk.CollectStrategy.onlyTrustedDevices()));
      } finally { device.free(); }
    });
  }

  decrypt(peer: CipherPeer, scope: string, envelope: PairwiseEnvelope): Promise<{ id: string; text: string }> {
    const pin: CipherPeer = JSON.parse(JSON.stringify(peer));
    const cipher = JSON.parse(JSON.stringify(envelope)) as PairwiseEnvelope;
    if (!uuid.test(scope) || encoder.encode(JSON.stringify(cipher)).length > 131000 ||
        cipher.algorithm !== 'm.olm.v1.curve25519-aes-sha2' || cipher.sender_key !== pin.curve25519) return Promise.reject(new Error('invalid_pairwise_envelope'));
    return this.run(async () => {
      const device = await this.trustedDevice(pin);
      device.free();
      const changes = new this.sdk.DeviceLists();
      let events;
      try {
        events = await this.machine.receiveSyncChanges(JSON.stringify([
          { sender: cipherUserId(pin), type: 'm.room.encrypted', content: cipher },
        ]), changes, new Map());
      } finally { changes.free(); }
      try {
        if (events.length !== 1 || events[0].type !== this.sdk.ProcessedToDeviceEventType.Decrypted) throw new Error('pairwise_decryption_failed');
        const event = events[0] as import('@matrix-org/matrix-sdk-crypto-wasm').DecryptedToDeviceEvent;
        const info = event.encryptionInfo;
        try {
          const raw = JSON.parse(event.rawEvent);
          const body = raw.content;
          if (!info.isSenderVerified() || info.senderCurve25519Key !== pin.curve25519 ||
              info.senderDevice?.toString() !== pin.device || raw.sender !== cipherUserId(pin) ||
              raw.type !== 'sfera.mesh.message' || !body ||
              Object.keys(body).sort().join(',') !== 'domain,genesis,message_id,network,recipient_device,scope,sender_device,text' ||
              body.domain !== 'sfera-mesh-pairwise-text-v1' || body.network !== this.identity.network ||
              body.genesis !== this.identity.genesis || body.scope !== scope || body.sender_device !== pin.device ||
              body.recipient_device !== this.identity.device || typeof body.message_id !== 'string' || !uuid.test(body.message_id) ||
              typeof body.text !== 'string' || encoder.encode(body.text).length > 32768) throw new Error('pairwise_message_context_mismatch');
          return { id: body.message_id, text: body.text };
        } finally { info.free(); }
      } finally { for (const event of events) event.free(); }
    });
  }

  private async groupContext(membership: CipherMembership) {
    const room = await cipherMembershipRoom(membership, this.publicIdentity());
    const old = this.memberships.get(membership.scope);
    if (old && (old.epoch > membership.epoch || (old.epoch === membership.epoch && old.room !== room))) throw new Error('group_membership_rollback_or_fork');
    if (this.checkpoints) await this.checkpoints.advance(membership.scope, { epoch: membership.epoch, room });
    this.memberships.set(membership.scope, { epoch: membership.epoch, room });
    return room;
  }

  encryptGroup(membership: CipherMembership, messageId: string, text: string): Promise<GroupEnvelope> {
    const frozen: CipherMembership = JSON.parse(JSON.stringify(membership));
    if (!uuid.test(messageId) || typeof text !== 'string' || encoder.encode(text).length > 32768) return Promise.reject(new Error('invalid_group_message'));
    return this.run(async () => {
      const room = await this.groupContext(frozen);
      const peers = frozen.peers.filter(peer => peer.device !== this.identity.device || peer.owner !== this.identity.owner);
      for (const peer of peers) { const device = await this.trustedDevice(peer); device.free(); }
      const users = [...new Set(peers.map(cipherUserId))];
      const claim = await this.machine.getMissingSessions(users.map(user => new this.sdk.UserId(user)));
      if (claim) await this.request(claim);
      const roomId = new this.sdk.RoomId(room);
      const settings = new this.sdk.EncryptionSettings();
      settings.algorithm = this.sdk.EncryptionAlgorithm.MegolmV1AesSha2;
      settings.rotationPeriodMessages = 100n;
      settings.rotationPeriod = 3600000000n;
      settings.historyVisibility = this.sdk.HistoryVisibility.Joined;
      settings.sharingStrategy = this.sdk.CollectStrategy.onlyTrustedDevices();
      try {
        const requests = await this.machine.shareRoomKey(roomId, users.map(user => new this.sdk.UserId(user)), settings);
        for (let index = 0; index < requests.length; index++) {
          const request = requests[index];
          try {
            const original = JSON.parse(request.body).messages;
            if (request.event_type !== 'm.room.encrypted') {
              // The SDK can generate notices for other, untrusted devices of
              // an included user. They are outside this exact device roster.
              if (request.event_type !== 'm.room_key.withheld' || peers.some(peer => original?.[cipherUserId(peer)]?.[peer.device])) throw new Error('group_key_unavailable_for_member');
              await this.machine.markRequestAsSent(request.id, request.type, '{}');
              continue;
            }
            const digest = await accountDigest(accountBytes([room, frozen.epoch, request.body]));
            let prepared = this.checkpoints ? await this.checkpoints.prepared(request.id) : this.preparedKeys.get(request.id);
            if (prepared && prepared.digest !== digest) throw new Error('cipher_outgoing_context_conflict');
            if (!prepared) {
              const messages: Record<string, Record<string, unknown>> = {};
              // Even a previously verified but now removed device belonging to
              // an included user must not receive this epoch's group key.
              for (const peer of peers) {
                const user = cipherUserId(peer), value = original?.[user]?.[peer.device];
                if (!value) continue;
                const receiptId = crypto.randomUUID();
                const content = JSON.parse(await this.machine.encryptRoomEvent(roomId, 'sfera.mesh.group.key-receipt', JSON.stringify({
                  domain: 'sfera-mesh-group-key-receipt-v1', network: this.identity.network, genesis: this.identity.genesis,
                  scope: frozen.scope, epoch: frozen.epoch, message_id: receiptId, sender_device: this.identity.device,
                  target_owner: peer.owner, target_device: peer.device, ciphertext_digest: await accountDigest(accountBytes(value)),
                })));
                (messages[user] ??= {})[peer.device] = { ...value,
                  key_receipt: { room, epoch: frozen.epoch, message_id: receiptId, sender_device: this.identity.device, content } };
              }
              prepared = { digest, body: JSON.stringify({ messages }) };
              if (encoder.encode(prepared.body).length > 262144) throw new Error('cipher_outgoing_too_large');
              if (this.checkpoints) await this.checkpoints.prepare(request.id, prepared);
              else {
                if (this.preparedKeys.size >= 128) throw new Error('cipher_outgoing_capacity');
                this.preparedKeys.set(request.id, prepared);
              }
            }
            const response = await this.relay({ id: request.id, type: request.type, body: prepared.body });
            if (this.closed || typeof response !== 'string' || response.length > 1048576) throw new Error('invalid_cipher_relay_response');
            await this.machine.markRequestAsSent(request.id, request.type, response);
            if (this.checkpoints) await this.checkpoints.forgetPrepared(request.id);
            else this.preparedKeys.delete(request.id);
          } catch (error) { for (const pending of requests.slice(index + 1)) pending.free(); throw error; }
          finally { request.free(); }
        }
        const content = JSON.parse(await this.machine.encryptRoomEvent(roomId, 'sfera.mesh.group.message', JSON.stringify({
          domain: 'sfera-mesh-group-text-v1', network: this.identity.network, genesis: this.identity.genesis,
          scope: frozen.scope, epoch: frozen.epoch, message_id: messageId, sender_device: this.identity.device, text,
        })));
        return { room, epoch: frozen.epoch, message_id: messageId, sender_device: this.identity.device, content };
      } finally { roomId.free(); settings.free(); }
    });
  }

  private async hasKeyReceipt(pin: CipherPeer, membership: CipherMembership, cipher: PairwiseEnvelope, room: string) {
    const receipt = cipher.key_receipt;
    if (!receipt || Object.keys(receipt).sort().join(',') !== 'content,epoch,message_id,room,sender_device' ||
        receipt.room !== room || receipt.epoch !== membership.epoch || !uuid.test(receipt.message_id) ||
        receipt.sender_device !== pin.device || !receipt.content || typeof receipt.content.session_id !== 'string') throw new Error('invalid_group_key_receipt');
    const { key_receipt: _receipt, ...wire } = cipher;
    const expected = { domain: 'sfera-mesh-group-key-receipt-v1', network: this.identity.network, genesis: this.identity.genesis,
      scope: membership.scope, epoch: membership.epoch, message_id: receipt.message_id, sender_device: pin.device,
      target_owner: this.identity.owner, target_device: this.identity.device, ciphertext_digest: await accountDigest(accountBytes(wire)) };
    const roomId = new this.sdk.RoomId(room);
    const settings = new this.sdk.DecryptionSettings(this.sdk.TrustRequirement.Untrusted);
    let event;
    try {
      try {
        event = await this.machine.decryptRoomEvent(JSON.stringify({ type: 'm.room.encrypted', sender: cipherUserId(pin),
          event_id: '$' + receipt.message_id, origin_server_ts: 0, content: receipt.content }), roomId, settings);
      } catch { return false; }
      const raw = JSON.parse(event.event);
      if (event.senderCurve25519Key !== pin.curve25519 || event.senderClaimedEd25519Key !== pin.ed25519 ||
          raw.type !== 'sfera.mesh.group.key-receipt' || await accountDigest(accountBytes(raw.content)) !== await accountDigest(accountBytes(expected))) throw new Error('group_key_receipt_context_mismatch');
      return true;
    } finally { event?.free(); roomId.free(); settings.free(); }
  }

  receiveGroupKey(peer: CipherPeer, membership: CipherMembership, envelope: PairwiseEnvelope) {
    const pin: CipherPeer = JSON.parse(JSON.stringify(peer));
    const frozen: CipherMembership = JSON.parse(JSON.stringify(membership));
    const cipher: PairwiseEnvelope = JSON.parse(JSON.stringify(envelope));
    return this.run(async () => {
      const room = await this.groupContext(frozen);
      if (!frozen.peers.some(item => samePeer(item, pin)) ||
          cipher.algorithm !== 'm.olm.v1.curve25519-aes-sha2' || cipher.sender_key !== pin.curve25519 ||
          encoder.encode(JSON.stringify(cipher)).length > 131000) throw new Error('invalid_group_key_sender');
      const device = await this.trustedDevice(pin); device.free();
      // Megolm re-decryption of the same event is repeatable after a crash.
      // A successful receipt proves the exact packet's key is already in this
      // SDK store, without trying to consume the Olm ciphertext a second time.
      if (cipher.key_receipt && await this.hasKeyReceipt(pin, frozen, cipher, room)) return;
      const { key_receipt: _receipt, ...wire } = cipher;
      const changes = new this.sdk.DeviceLists();
      let events;
      try {
        events = await this.machine.receiveSyncChanges(JSON.stringify([
          { sender: cipherUserId(pin), type: 'm.room.encrypted', content: wire },
        ]), changes, new Map());
      } finally { changes.free(); }
      try {
        if (events.length !== 1 || events[0].type !== this.sdk.ProcessedToDeviceEventType.Decrypted) throw new Error('group_key_decryption_failed');
        const event = events[0] as import('@matrix-org/matrix-sdk-crypto-wasm').DecryptedToDeviceEvent;
        const info = event.encryptionInfo;
        try {
          const raw = JSON.parse(event.rawEvent);
          // The SDK deliberately defers device verification on m.room_key.
          // Require the pinned Olm sender here; decryptGroup additionally binds
          // the resulting session's claimed signing key before exposing text.
          if (raw.type !== 'm.room_key' || raw.content?.room_id !== room ||
              (cipher.key_receipt && raw.content?.session_id !== cipher.key_receipt.content.session_id) ||
              raw.sender !== cipherUserId(pin) || info.senderCurve25519Key !== pin.curve25519) throw new Error('group_key_context_mismatch');
        } finally { info.free(); }
      } finally { for (const event of events) event.free(); }
      if (cipher.key_receipt && !await this.hasKeyReceipt(pin, frozen, cipher, room)) throw new Error('group_key_receipt_unavailable');
    });
  }

  decryptGroup(peer: CipherPeer, membership: CipherMembership, envelope: GroupEnvelope): Promise<{ id: string; text: string }> {
    return this.decryptGroupEnvelope(peer, membership, envelope, false);
  }
  /** Read only: uses an already held historical key without advancing or
   * lowering the current membership checkpoint, and never shares room keys. */
  decryptHistoricalGroup(peer: CipherPeer, membership: CipherMembership, envelope: GroupEnvelope) {
    return this.decryptGroupEnvelope(peer, membership, envelope, true);
  }
  private decryptGroupEnvelope(peer: CipherPeer, membership: CipherMembership, envelope: GroupEnvelope, historical: boolean): Promise<{ id: string; text: string }> {
    const pin: CipherPeer = JSON.parse(JSON.stringify(peer));
    const frozen: CipherMembership = JSON.parse(JSON.stringify(membership));
    const cipher: GroupEnvelope = JSON.parse(JSON.stringify(envelope));
    return this.run(async () => {
      const room = historical ? await cipherMembershipRoom(frozen, this.publicIdentity()) : await this.groupContext(frozen);
      if (!frozen.peers.some(item => samePeer(item, pin)) || cipher.room !== room ||
          cipher.epoch !== frozen.epoch || !uuid.test(cipher.message_id) || cipher.sender_device !== pin.device ||
          encoder.encode(JSON.stringify(cipher)).length > 131000) throw new Error('invalid_group_envelope');
      const device = await this.trustedDevice(pin); device.free();
      const roomId = new this.sdk.RoomId(room);
      // Explicit key pins below provide device trust without inventing Matrix
      // cross-signing authorities for the mesh identity namespace.
      const settings = new this.sdk.DecryptionSettings(this.sdk.TrustRequirement.Untrusted);
      let event;
      try {
        event = await this.machine.decryptRoomEvent(JSON.stringify({ type: 'm.room.encrypted',
          sender: cipherUserId(pin), event_id: '$' + cipher.message_id, origin_server_ts: 0, content: cipher.content }), roomId, settings);
        const raw = JSON.parse(event.event), body = raw.content;
        if (event.senderCurve25519Key !== pin.curve25519 || event.senderClaimedEd25519Key !== pin.ed25519 ||
            raw.type !== 'sfera.mesh.group.message' || !body ||
            Object.keys(body).sort().join(',') !== 'domain,epoch,genesis,message_id,network,scope,sender_device,text' ||
            body.domain !== 'sfera-mesh-group-text-v1' || body.network !== this.identity.network || body.genesis !== this.identity.genesis ||
            body.scope !== frozen.scope || body.epoch !== frozen.epoch || body.message_id !== cipher.message_id ||
            body.sender_device !== pin.device || typeof body.text !== 'string' || encoder.encode(body.text).length > 32768) throw new Error('group_message_context_mismatch');
        return { id: body.message_id, text: body.text };
      } catch (error) {
        if (historical && error instanceof this.sdk.MegolmDecryptionError &&
            [this.sdk.DecryptionErrorCode.MissingRoomKey, this.sdk.DecryptionErrorCode.UnknownMessageIndex].includes(error.code)) {
          error.free(); throw new Error('cipher_historical_key_unavailable');
        }
        throw error;
      } finally { event?.free(); roomId.free(); settings.free(); }
    });
  }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.queue.then(async () => {
      if (!this.disposed) {
        this.disposed = true;
        try { this.preparedKeys.clear(); this.checkpoints?.close(); this.machine.close(); } finally { await this.releaseStore?.(); }
      }
    });
    return this.closing;
  }
}
