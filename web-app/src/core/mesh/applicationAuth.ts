/** Application login proofs. Encrypted credentials stay local to this browser. */
import { accountBytes, accountDigest, meshUserId, signIdentityStatement, type AccountRecord } from './account';
import { verifyControlledAccount, type AccountControlHead } from './accountControls';
import { meshDeviceId } from './devices';
import { unlockVault, wrapArchiveRoot, type Vault } from './vault';

export type ApplicationKeys = {
  version: 1; network: string; genesis: string; entry: string; server: string;
  applicationUser: string; ownerPublic: string; devicePublic: string;
  ownerVault: Vault | null; deviceVault: Vault;
  ownerControl?: { record: AccountRecord; history: AccountControlHead[] };
};
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const hex = (bytes: Uint8Array) => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const buffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;
export function applicationKeys(value: unknown, server: string): ApplicationKeys {
  const keys = value as ApplicationKeys;
  if (!keys || !['applicationUser,devicePublic,deviceVault,entry,genesis,network,ownerPublic,ownerVault,server,version', 'applicationUser,devicePublic,deviceVault,entry,genesis,network,ownerControl,ownerPublic,ownerVault,server,version'].includes(Object.keys(keys).sort().join(','))
    || keys.version !== 1 || !/^[A-Za-z0-9._-]{1,128}$/.test(keys.network)
    || ![keys.genesis, keys.entry, keys.ownerPublic, keys.devicePublic].every(digest)
    || keys.ownerPublic === keys.devicePublic
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(keys.applicationUser)) throw new Error('invalid_application_keys');
  const selected = new URL(server), pinned = new URL(keys.server);
  if (selected.origin !== pinned.origin || pinned.href !== pinned.origin + '/' || pinned.username || pinned.password
    || (pinned.protocol !== 'https:' && !(pinned.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(pinned.hostname)))) throw new Error('application_server_mismatch');
  return JSON.parse(JSON.stringify(keys));
}
export async function ownerController(keys: ApplicationKeys) {
  if (!keys.ownerControl) return keys.ownerPublic;
  const checked = await verifyControlledAccount(keys.ownerControl.record, keys.ownerControl.history, keys.network, keys.genesis, await meshUserId(keys.ownerPublic));
  if (checked.record.body.public_key !== keys.ownerPublic || !keys.ownerVault || await accountDigest(accountBytes(keys.ownerVault)) !== checked.record.body.vault_digest) throw new Error('application_owner_control_mismatch');
  return checked.controllerPublic;
}
/** Rewrap the same device seed, so one password still opens both local vaults. */
export async function replaceOwnerCredentials(value: ApplicationKeys, record: AccountRecord, history: AccountControlHead[], vault: Vault, devicePassword: string, newPassword: string) {
  const keys = applicationKeys(value, value.server);
  const next = { ...keys, ownerVault: vault, ownerControl: { record, history } };
  await ownerController(next);
  const root = await unlockVault(keys.deviceVault, await meshUserId(keys.devicePublic), devicePassword);
  try {
    const statement = accountBytes(['sfera-mesh-device-credential-check-v1', keys.devicePublic]);
    const signature = await signIdentityStatement(root, statement);
    const pub = await crypto.subtle.importKey('raw', Uint8Array.from(keys.devicePublic.match(/../g)!, x => parseInt(x, 16)).buffer, 'Ed25519', false, ['verify']);
    if (!await crypto.subtle.verify('Ed25519', pub, new Uint8Array(signature).buffer, new Uint8Array(statement).buffer)) throw new Error('application_device_key_mismatch');
    next.deviceVault = await wrapArchiveRoot(root, await meshUserId(keys.devicePublic), newPassword);
    return next;
  } finally { root.fill(0); }
}
export async function answerApplicationChallenge(keys: ApplicationKeys, password: string,
  challenge: Record<string, unknown>, purpose: 'bind' | 'login', loginJti?: string, now = Math.floor(Date.now() / 1000)) {
  const body = JSON.parse(JSON.stringify(challenge));
  const fields = 'application_user,challenge,device,device_public,domain,entry,expires_at,genesis,history_hash,history_version,issued_at,login_jti,network,owner';
  if (Object.keys(body).sort().join(',') !== fields || body.domain !== `sfera-mesh-application-${purpose}-v1`
    || body.network !== keys.network || body.genesis !== keys.genesis || body.entry !== keys.entry
    || body.application_user !== keys.applicationUser || body.device_public !== keys.devicePublic
    || body.owner !== await meshUserId(keys.ownerPublic) || body.device !== await meshDeviceId(keys.devicePublic)
    || !digest(body.challenge) || !digest(body.history_hash) || !Number.isSafeInteger(body.history_version) || body.history_version < 1
    || !Number.isSafeInteger(body.issued_at) || !Number.isSafeInteger(body.expires_at)
    || body.issued_at > now + 5 || body.issued_at < now - 60 || body.expires_at <= now || body.expires_at > body.issued_at + 60
    || typeof body.login_jti !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.login_jti)
    || (purpose === 'bind' && (!loginJti || body.login_jti !== loginJti))) throw new Error('application_challenge_mismatch');
  // Device vaults use their account-derived ID for wrapping, independently of
  // the protocol's device ID. No key material is transmitted to the server.
  if (purpose === 'bind' && !keys.ownerVault) throw new Error('owner_approval_required');
  const ownerRoot = purpose === 'bind' ? await unlockVault(keys.ownerVault!, body.owner, password) : undefined;
  let deviceRoot: Uint8Array | undefined;
  try {
    deviceRoot = await unlockVault(keys.deviceVault, await meshUserId(keys.devicePublic), password);
    const encoded = accountBytes(body);
    const ownerSignature = ownerRoot ? await signIdentityStatement(ownerRoot, encoded) : undefined;
    const deviceSignature = await signIdentityStatement(deviceRoot, encoded);
    const controller = purpose === 'bind' ? await ownerController(keys) : keys.ownerPublic;
    for (const [publicHex, signature] of [[controller, ownerSignature], [keys.devicePublic, deviceSignature]] as const) {
      if (!signature) continue;
      const raw = Uint8Array.from(publicHex.match(/../g)!, value => parseInt(value, 16));
      const publicKey = await crypto.subtle.importKey('raw', buffer(raw), 'Ed25519', false, ['verify']);
      if (!await crypto.subtle.verify('Ed25519', publicKey, buffer(signature), buffer(encoded))) throw new Error('application_key_mismatch');
    }
    return { challenge: body.challenge as string, owner_signature: ownerSignature ? hex(ownerSignature) : '', device_signature: hex(deviceSignature) };
  } finally { ownerRoot?.fill(0); deviceRoot?.fill(0); }
}
