/** Stable identity + dual-signed succession of its controlling root.
 * Fresh checkpoints must come from the checked directory, not an imported file.
 */
import { accountBytes, accountDigest, meshUserId, signIdentityStatement, verifyAccount, type AccountRecord } from './account';
import { unlockVault, wrapArchiveRoot } from './vault';
export type AccountControlBody = { domain: 'sfera-mesh-account-control-v1'; network: string; genesis: string;
  owner: string; epoch: number; previous: string; old_public: string; new_public: string;
  account_version: number; account_digest: string; devices_version: number; devices_digest: string; replacement_digest: string };
export type AccountControl = { body: AccountControlBody; old_signature: string; new_signature: string };
export type AccountControlHead = { record: AccountControl; digest: string };
export type RootCheckpoint = { accountVersion: number; accountDigest: string; controlDigest: string; devicesVersion: number; devicesDigest: string };
const ZERO = '0'.repeat(64), hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const hex = (bytes: Uint8Array) => Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
async function verify(publicKey: string, signature: string, body: unknown) {
  if (!hash(publicKey) || typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature)) throw new Error('invalid_root_control_signature');
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(publicKey.match(/../g)!, x => parseInt(x, 16)).buffer, 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, Uint8Array.from(signature.match(/../g)!, x => parseInt(x, 16)).buffer,
    new Uint8Array(accountBytes(body)).buffer)) throw new Error('invalid_root_control_signature');
}
export async function verifyControlledAccount(value: AccountRecord, valueHistory: AccountControlHead[], network: string, genesis: string, owner: string) {
  const record = copy(value), history = copy(valueHistory);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(network) || !hash(genesis) || !hash(owner) || !Array.isArray(history) || history.length > 16 || accountBytes(history).length > 65536) throw new Error('invalid_root_control_history');
  if (!history.length) return { record, history, digest: await verifyAccount(record, network, owner), controllerPublic: record.body.public_key, controlDigest: ZERO };
  const b = record?.body;
  if (!record || Object.keys(record).sort().join(',') !== 'body,signature' || !b ||
    Object.keys(b).sort().join(',') !== 'dialogs_digest,domain,network,previous,public_key,user_id,vault_digest,version' ||
    b.domain !== 'sfera-mesh-account-v1' || b.network !== network || b.user_id !== owner || !Number.isSafeInteger(b.version) || b.version < 1 ||
    ![b.public_key, b.previous, b.vault_digest, b.dialogs_digest].every(hash) || await meshUserId(b.public_key) !== owner || accountBytes(record).length > 16384) throw new Error('invalid_controlled_account');
  const digest = await accountDigest(accountBytes(record));
  let publicKey = b.public_key, previous = ZERO, accountVersion = 0, devicesVersion = 0;
  const seen = new Set([publicKey]);
  for (let index = 0; index < history.length; index++) {
    const head = history[index], control = head?.record, body = control?.body;
    if (!head || Object.keys(head).sort().join(',') !== 'digest,record' || !control || Object.keys(control).sort().join(',') !== 'body,new_signature,old_signature' || !body ||
      Object.keys(body).sort().join(',') !== 'account_digest,account_version,devices_digest,devices_version,domain,epoch,genesis,network,new_public,old_public,owner,previous,replacement_digest' ||
      body.domain !== 'sfera-mesh-account-control-v1' || body.network !== network || body.genesis !== genesis || body.owner !== owner || body.epoch !== index + 1 ||
      body.previous !== previous || body.old_public !== publicKey || ![body.new_public, body.previous, body.account_digest, body.devices_digest, body.replacement_digest, head.digest].every(hash) ||
      seen.has(body.new_public) || !Number.isSafeInteger(body.account_version) || body.account_version <= accountVersion || body.account_version >= b.version ||
      !Number.isSafeInteger(body.devices_version) || body.devices_version < devicesVersion || body.devices_version > 256 ||
      (body.devices_version === 0 && body.devices_digest !== ZERO) || (body.account_version + 1 === b.version && body.replacement_digest !== digest)) throw new Error('root_control_gap_or_fork');
    await verify(body.old_public, control.old_signature, body); await verify(body.new_public, control.new_signature, body);
    if (await accountDigest(accountBytes(control)) !== head.digest) throw new Error('root_control_digest_mismatch');
    publicKey = body.new_public; previous = head.digest; accountVersion = body.account_version; devicesVersion = body.devices_version; seen.add(publicKey);
  }
  await verify(publicKey, record.signature, b);
  return { record, history, digest, controllerPublic: publicKey, controlDigest: previous };
}
export async function prepareRootControl(value: AccountRecord, vaultBytes: Uint8Array, oldPassword: string, newPassword: string,
  network: string, genesis: string, owner: string, valueHistory: AccountControlHead[], valueCheckpoint: RootCheckpoint) {
  const encoded = new Uint8Array(vaultBytes), checkpoint = copy(valueCheckpoint);
  let oldRoot: Uint8Array | undefined, nextRoot: Uint8Array | undefined;
  try {
    const current = await verifyControlledAccount(value, valueHistory, network, genesis, owner);
    if (!checkpoint || Object.keys(checkpoint).sort().join(',') !== 'accountDigest,accountVersion,controlDigest,devicesDigest,devicesVersion' ||
      checkpoint.accountVersion !== current.record.body.version || checkpoint.accountDigest !== current.digest || checkpoint.controlDigest !== current.controlDigest ||
      !Number.isSafeInteger(checkpoint.devicesVersion) || checkpoint.devicesVersion < 0 || checkpoint.devicesVersion > 256 || !hash(checkpoint.devicesDigest) ||
      checkpoint.devicesVersion === 0 && checkpoint.devicesDigest !== ZERO) throw new Error('root_checkpoint_rollback_or_fork');
    if (current.history.length >= 16 || current.record.body.version === Number.MAX_SAFE_INTEGER || await accountDigest(encoded) !== current.record.body.vault_digest || encoded.length > 4096) throw new Error('root_rotation_limit_or_vault_mismatch');
    oldRoot = await unlockVault(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded)), owner, oldPassword);
    const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
    try { if (pkcs8.length !== 48 || hex(pkcs8.subarray(0, 16)) !== '302e020100300506032b657004220420') throw new Error('unsupported_root_encoding'); nextRoot = pkcs8.slice(16); }
    finally { pkcs8.fill(0); }
    const newPublic = hex(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
    const vault = await wrapArchiveRoot(nextRoot, owner, newPassword);
    const body = { ...current.record.body, version: current.record.body.version + 1, previous: current.digest, vault_digest: await accountDigest(accountBytes(vault)) };
    const account: AccountRecord = { body, signature: hex(await signIdentityStatement(nextRoot, accountBytes(body))) };
    const controlBody: AccountControlBody = { domain: 'sfera-mesh-account-control-v1', network, genesis, owner,
      epoch: current.history.length + 1, previous: current.controlDigest, old_public: current.controllerPublic, new_public: newPublic,
      account_version: current.record.body.version, account_digest: current.digest, devices_version: checkpoint.devicesVersion,
      devices_digest: checkpoint.devicesDigest, replacement_digest: await accountDigest(accountBytes(account)) };
    const control: AccountControl = { body: controlBody, old_signature: hex(await signIdentityStatement(oldRoot, accountBytes(controlBody))), new_signature: hex(await signIdentityStatement(nextRoot, accountBytes(controlBody))) };
    const history = [...current.history, { record: control, digest: await accountDigest(accountBytes(control)) }];
    await verifyControlledAccount(account, history, network, genesis, owner);
    return { update: { body: { domain: 'sfera-mesh-account-control-update-v1' as const, network, genesis }, control, account }, vault, history };
  } finally { encoded.fill(0); oldRoot?.fill(0); nextRoot?.fill(0); }
}
