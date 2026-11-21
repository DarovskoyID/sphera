/** The selected entry attests its current application ACL. Device admission is
 * checked against fresh consensus on that entry; these are distinct authorities.
 */
import { accountBytes, accountDigest, signIdentityStatement } from './account';
import { meshDeviceId } from './devices';
import { entryProbeNonce, validateTrustedEntryPoints, type TrustedEntryPoint } from './entryPoint';
import { applicationUserId } from './applicationProfiles';
import { applicationDialogId, applicationConversationId } from './applicationDialogs';
import { cipherUserId, cipherMembershipRoom, PairwiseCipher, type CipherMembership, type CipherPeer,
  type GroupEnvelope, type PairwiseEnvelope } from './pairwiseCipher';

export type CipherCertificate = { body: CipherPeer & {
  domain: 'sfera-mesh-cipher-device-v1'; device_public: string;
}; signature: string };
type CipherScopeBase = {
  network: string; genesis: string; entry: string;
  source: 'dm' | 'guild'; scope: string; epoch: number; roster: string; members: string[];
  owners: { user: string; owner: string }[];
  certificates: CipherCertificate[]; nonce: string; issued_at: number; expires_at: number;
};
export type CipherScopeBody = CipherScopeBase & ({domain:'sfera-mesh-cipher-scope-v1';membership_authority:'selected_application'}
  | {domain:'sfera-mesh-cipher-scope-v2';membership_authority:'consensus_dialog';dialog:string;device_versions:{owner:string;version:number}[]});
export type CipherScopeProof = { body: CipherScopeBody; signature: string };
const hex = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const buffer = (value: Uint8Array): ArrayBuffer => new Uint8Array(value).buffer;
const bytes = (value: string) => Uint8Array.from(value.match(/../g)!, part => parseInt(part, 16));
function schema(value: unknown, fields: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== fields.sort().join(',')) throw new Error('invalid_cipher_authorization_schema');
}
async function signed(publicKey: string, signature: string, body: unknown) {
  if (!hex.test(publicKey) || typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature)) throw new Error('invalid_cipher_authorization_signature');
  const key = await crypto.subtle.importKey('raw', buffer(bytes(publicKey)), 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, buffer(bytes(signature)), buffer(accountBytes(body)))) throw new Error('invalid_cipher_authorization_signature');
}
export async function verifyCipherCertificate(value: CipherCertificate, network: string, genesis: string): Promise<CipherPeer> {
  const certificate: CipherCertificate = JSON.parse(JSON.stringify(value));
  if (accountBytes(certificate).length > 4096) throw new Error('invalid_cipher_certificate');
  schema(certificate, ['body', 'signature']);
  const body = certificate.body;
  schema(body, ['domain', 'network', 'genesis', 'owner', 'device', 'device_public', 'ed25519', 'curve25519']);
  cipherUserId(body);
  if (body.domain !== 'sfera-mesh-cipher-device-v1' || body.network !== network || body.genesis !== genesis ||
      typeof body.device_public !== 'string' || !hex.test(body.device_public) ||
      await meshDeviceId(body.device_public) !== body.device) throw new Error('cipher_certificate_context_mismatch');
  for (const key of [body.ed25519, body.curve25519]) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{43}$/.test(key) || btoa(atob(key + '=')).replace(/=+$/, '') !== key) throw new Error('invalid_cipher_certificate_key');
  }
  await signed(body.device_public, certificate.signature, body);
  const { owner, device, ed25519, curve25519 } = body;
  return { network, genesis, owner, device, ed25519, curve25519 };
}
export async function signCipherCertificate(peer: CipherPeer, devicePublic: string, deviceRoot: Uint8Array | CryptoKey): Promise<CipherCertificate> {
  const { network, genesis, owner, device, ed25519, curve25519 } = peer;
  const body: CipherCertificate['body'] = { domain: 'sfera-mesh-cipher-device-v1', network, genesis, owner, device, ed25519, curve25519, device_public: devicePublic };
  const signature = Array.from(deviceRoot instanceof Uint8Array ? await signIdentityStatement(deviceRoot, accountBytes(body)) : new Uint8Array(await crypto.subtle.sign('Ed25519',deviceRoot,new Uint8Array(accountBytes(body)).buffer)), byte => byte.toString(16).padStart(2, '0')).join('');
  const result = { body, signature };
  await verifyCipherCertificate(result, network, genesis);
  return result;
}

export async function verifyCipherScope(value: unknown, pin: TrustedEntryPoint, own: CipherPeer,
  user: string, source: 'dm' | 'guild', scope: string, nonce: string, now = Math.floor(Date.now() / 1000)) {
  pin = { ...pin };
  own = { network: own.network, genesis: own.genesis, owner: own.owner, device: own.device,
    ed25519: own.ed25519, curve25519: own.curve25519 };
  cipherUserId(own);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid_cipher_scope_time');
  const proof: CipherScopeProof = JSON.parse(JSON.stringify(value));
  if (accountBytes(proof).length > 131072) throw new Error('cipher_scope_proof_too_large');
  schema(proof, ['body', 'signature']);
  const body = proof.body;
  schema(body, ['domain', 'network', 'genesis', 'entry', 'source', 'scope', 'epoch', 'roster', 'members',
    'certificates', 'owners', 'nonce', 'issued_at', 'expires_at', 'membership_authority',
    ...(body.domain==='sfera-mesh-cipher-scope-v2'?['dialog','device_versions']:[])]);
  const { network, nodeId, publicKey, url, label } = pin;
  await validateTrustedEntryPoints([{ network, nodeId, publicKey, url, label }]);
  if (!((body.domain === 'sfera-mesh-cipher-scope-v1' && body.membership_authority === 'selected_application')
      || (body.domain === 'sfera-mesh-cipher-scope-v2' && body.membership_authority === 'consensus_dialog')) ||
      body.network !== pin.network || body.network !== own.network || body.genesis !== own.genesis ||
      body.entry !== pin.nodeId || !['dm', 'guild'].includes(source) || body.source !== source || !uuid.test(scope) || body.scope !== scope ||
      !hex.test(nonce) || body.nonce !== nonce || !Number.isSafeInteger(body.epoch) || body.epoch < 1 || body.epoch > 2147483647 ||
      !Number.isSafeInteger(body.issued_at) || !Number.isSafeInteger(body.expires_at) || body.expires_at !== body.issued_at + 15 ||
      body.issued_at > now + 5 || body.issued_at < now - 15 || body.expires_at <= now ||
      !Array.isArray(body.members) || body.members.length < 1 || body.members.length > 64 ||
      !body.members.every(member => typeof member === 'string' && uuid.test(member)) || !body.members.includes(user) ||
      JSON.stringify(body.members) !== JSON.stringify([...new Set(body.members)].sort()) ||
      !Array.isArray(body.owners) || body.owners.length !== body.members.length ||
      !Array.isArray(body.certificates) || body.certificates.length < 2 || body.certificates.length > 64) throw new Error('cipher_scope_context_mismatch');
  await signed(pin.publicKey, proof.signature, body);
  const peers: CipherPeer[] = [];
  for (const certificate of body.certificates) peers.push(await verifyCipherCertificate(certificate, own.network, own.genesis));
  for (let index = 0; index < body.owners.length; index++) {
    const binding = body.owners[index];
    schema(binding, ['user', 'owner']);
    if (binding.user !== body.members[index] || typeof binding.owner !== 'string' || !hex.test(binding.owner) ||
        !peers.some(peer => peer.owner === binding.owner)) throw new Error('cipher_scope_owner_mismatch');
  }
  const owners = new Set(body.owners.map(item => item.owner));
  if (owners.size !== body.owners.length || peers.some(peer => !owners.has(peer.owner)) ||
      !body.owners.some(item => item.user === user && item.owner === own.owner)) throw new Error('cipher_scope_owner_mismatch');
  const names = peers.map(peer => peer.owner + ':' + peer.device);
  if (JSON.stringify(names) !== JSON.stringify([...new Set(names)].sort()) ||
      !peers.some(peer => (['network', 'genesis', 'owner', 'device', 'ed25519', 'curve25519'] as const).every(field => peer[field] === own[field])) ||
      new Set(peers.map(peer => peer.ed25519)).size !== peers.length || new Set(peers.map(peer => peer.curve25519)).size !== peers.length ||
      body.roster !== await accountDigest(accountBytes({ members: body.members, owners: body.owners, certificates: body.certificates }))) throw new Error('cipher_scope_roster_mismatch');
  let identity: unknown = ['sfera-mesh-cipher-scope-id-v1',own.network,own.genesis,pin.nodeId,source,scope];
  if (body.domain==='sfera-mesh-cipher-scope-v2') {
    if (source!=='dm' || body.members.length!==2 || !hex.test(body.dialog)
        || body.scope!==applicationConversationId(body.dialog)
        || body.dialog!==await applicationDialogId(own.network,body.owners.map(binding=>binding.owner).sort())
        || !Array.isArray(body.device_versions) || body.device_versions.length!==2) throw new Error('distributed_cipher_dialog_mismatch');
    for (const binding of body.owners) {
      if (binding.user!==await applicationUserId(own.network,binding.owner)) throw new Error('distributed_cipher_identity_mismatch');
    }
    const orderedOwners=body.owners.map(binding=>binding.owner).sort();let epoch=1;
    for (let index=0;index<2;index++) {
      const checkpoint=body.device_versions[index];schema(checkpoint,['owner','version']);
      if (checkpoint.owner!==orderedOwners[index] || !Number.isSafeInteger(checkpoint.version) || checkpoint.version<1 || checkpoint.version>256) throw new Error('distributed_cipher_history_mismatch');
      epoch+=checkpoint.version;
    }
    if (body.epoch!==epoch) throw new Error('distributed_cipher_epoch_mismatch');
    identity=['sfera-mesh-distributed-cipher-scope-id-v1',own.network,own.genesis,'dm',body.dialog];
  }
  // Legacy rooms remain entry-scoped. Distributed DMs use the explicit shared
  // descriptor, while the selected entry still signs each fresh authorization.
  const digest = await accountDigest(accountBytes(identity));
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  return { membership: { scope: id, epoch: body.epoch, peers } satisfies CipherMembership, body, proof };
}

export class AuthorizedCipher {
  private cipher: PairwiseCipher;
  private pin: TrustedEntryPoint;
  private user: string;
  private provider: (request: { source: 'dm' | 'guild'; scope: string; nonce: string }) => Promise<unknown>;
  private guard: () => void;
  private review: (body: CipherScopeBody) => Promise<boolean>;
  constructor(cipher: PairwiseCipher, pin: TrustedEntryPoint, user: string,
    provider: AuthorizedCipher['provider'], guard: () => void, review: AuthorizedCipher['review']) {
    this.cipher = cipher; this.pin = { ...pin }; this.user = user; this.provider = provider; this.guard = guard;
    this.review = review;
  }
  private async load(source: 'dm' | 'guild', scope: string) {
    this.guard();
    const nonce = entryProbeNonce();
    const proof = await this.provider({ source, scope, nonce });
    this.guard();
    const checked = await verifyCipherScope(proof, this.pin, this.cipher.publicIdentity(), this.user, source, scope, nonce);
    // A server's ACL signature alone must not silently authorize new readers.
    // Product callers must review/pin the exact roster or verify a user-signed
    // membership grant. There is deliberately no permissive default.
    if (typeof this.review !== 'function' || !await this.review(JSON.parse(JSON.stringify(checked.body)))) throw new Error('cipher_roster_approval_required');
    this.current(checked.body);
    return checked;
  }
  private current(body: CipherScopeBody) {
    this.guard();
    if (body.expires_at <= Math.floor(Date.now() / 1000)) throw new Error('cipher_scope_expired');
  }
  private async refreshAfter(checked:Awaited<ReturnType<AuthorizedCipher['load']>>,source:'dm'|'guild',scope:string) {
    if(checked.body.expires_at>Math.floor(Date.now()/1000)){this.current(checked.body);return checked;}
    const fresh=await this.load(source,scope);
    if(fresh.body.domain!==checked.body.domain || fresh.body.roster!==checked.body.roster ||
      await accountDigest(accountBytes(fresh.membership))!==await accountDigest(accountBytes(checked.membership)))throw new Error('cipher_scope_changed_during_operation');
    return fresh;
  }
  async encrypt(source: 'dm' | 'guild', scope: string, messageId: string, text: string) {
    return (await this.encryptAuthorized(source, scope, messageId, text)).envelope;
  }
  async encryptAuthorized(source: 'dm' | 'guild', scope: string, messageId: string, text: string) {
    let checked=await this.load(source,scope);this.current(checked.body);
    const envelope=await this.cipher.encryptGroup(checked.membership,messageId,text);
    checked=await this.refreshAfter(checked,source,scope);
    return {envelope,authorization:checked.proof};
  }
  async decrypt(source: 'dm' | 'guild', scope: string, sender: { owner: string; device: string }, envelope: GroupEnvelope) {
    let checked=await this.load(source,scope);
    const peer=checked.membership.peers.find(item=>item.owner===sender.owner && item.device===sender.device);
    if(!peer)throw new Error('cipher_sender_not_member');this.current(checked.body);
    const result=await this.cipher.decryptGroup(peer,checked.membership,envelope);
    checked=await this.refreshAfter(checked,source,scope);return {...result,authorization:checked.proof};
  }
  /** Historical read requires the original signed roster and an already held
   * key. Product callers separately gate it with fresh selected-SQL status. */
  async decryptHistorical(source: 'dm' | 'guild', scope: string, sender: { owner: string; device: string }, envelope: GroupEnvelope, authorization: CipherScopeProof) {
    this.guard();
    const checked = await verifyCipherScope(authorization, this.pin, this.cipher.publicIdentity(), this.user,
      source, scope, authorization.body.nonce, authorization.body.issued_at);
    const peer = checked.membership.peers.find(item => item.owner === sender.owner && item.device === sender.device);
    if (!peer) throw new Error('cipher_historical_sender_not_member');
    const result = await this.cipher.decryptHistoricalGroup(peer, checked.membership, envelope);
    this.guard(); return { ...result, authorization: checked.proof };
  }
  async receiveKey(source: 'dm' | 'guild', scope: string, sender: { owner: string; device: string }, envelope: PairwiseEnvelope) {
    const checked=await this.load(source,scope);
    const peer=checked.membership.peers.find(item=>item.owner===sender.owner && item.device===sender.device);
    if(!peer)throw new Error('cipher_sender_not_member');this.current(checked.body);
    await this.cipher.receiveGroupKey(peer,checked.membership,envelope);await this.refreshAfter(checked,source,scope);
  }

  /** Context for a locally journaled outgoing intent; not a self-decryption proof. */
  async outgoingAuthorization(source: 'dm' | 'guild', scope: string, envelope: GroupEnvelope, saved?: CipherScopeProof) {
    const own = this.cipher.publicIdentity();
    const { membership, body, proof } = saved
      ? await verifyCipherScope(saved, this.pin, own, this.user, source, scope, saved.body.nonce, saved.body.issued_at)
      : await this.load(source, scope);
    if (envelope.sender_device !== own.device || envelope.epoch !== membership.epoch ||
        envelope.content.device_id !== own.device || envelope.content.sender_key !== own.curve25519 ||
        envelope.room !== await cipherMembershipRoom(membership, own)) throw new Error('cipher_outgoing_archive_context_mismatch');
    if (!saved) this.current(body);
    this.guard(); return proof;
  }

  assertPersistentKeyStore() { this.guard(); this.cipher.assertPersistentKeyStore(); }
}
