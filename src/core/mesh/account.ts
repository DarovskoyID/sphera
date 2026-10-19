/** Local account identity and signed directory records. No login session or network calls.
 * Root entropy is an Ed25519 seed; archive keys are domain-separated through HKDF.
 */
import { wrapArchiveRoot, unlockVault, type Vault } from './vault';

const encoder = new TextEncoder();
const prefix = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const hex = (value: Uint8Array) => Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
const buffer = (value: Uint8Array): ArrayBuffer => new Uint8Array(value).buffer;
function fromHex(value: string, length: number) {
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]+$/.test(value)) throw new Error('invalid_account_encoding');
  return Uint8Array.from(value.match(/../g)!, part => parseInt(part, 16));
}
function networkId(value: string) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(value)) throw new Error('invalid_account_network');
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])]));
  return value;
}
export const accountBytes = (value: unknown) => encoder.encode(JSON.stringify(sorted(value)));
export async function accountDigest(bytes: Uint8Array) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer(bytes))));
}
export async function meshUserId(publicKey: string) {
  const publicBytes = fromHex(publicKey, 32), domain = encoder.encode('sfera-mesh-user-v1\0');
  const data = new Uint8Array(domain.length + publicBytes.length);
  data.set(domain); data.set(publicBytes, domain.length);
  return accountDigest(data);
}
export type AccountBody = { domain: 'sfera-mesh-account-v1'; network: string; user_id: string; public_key: string; version: number; previous: string; vault_digest: string; dialogs_digest: string };
export type AccountRecord = { body: AccountBody; signature: string };
async function privateKey(root: Uint8Array) {
  if (root.length !== 32) throw new Error('invalid_identity_root');
  const pkcs8 = new Uint8Array(48); pkcs8.set(prefix); pkcs8.set(root, 16);
  try { return await crypto.subtle.importKey('pkcs8', buffer(pkcs8), 'Ed25519', false, ['sign']); }
  finally { pkcs8.fill(0); }
}
export async function verifyAccount(record: AccountRecord, network: string, expectedUser?: string) {
  networkId(network);
  if (!record || Object.keys(record).sort().join(',') !== 'body,signature') throw new Error('invalid_account_record');
  const body = record.body;
  if (!body || Object.keys(body).sort().join(',') !== 'dialogs_digest,domain,network,previous,public_key,user_id,vault_digest,version' || body.domain !== 'sfera-mesh-account-v1' || body.network !== network || !Number.isSafeInteger(body.version) || body.version < 1 || (body.version === 1 && body.previous !== '0'.repeat(64))) throw new Error('invalid_account_body');
  for (const value of [body.user_id, body.public_key, body.previous, body.vault_digest, body.dialogs_digest]) fromHex(value, 32);
  if ((expectedUser !== undefined && expectedUser !== body.user_id) || await meshUserId(body.public_key) !== body.user_id) throw new Error('account_identity_mismatch');
  const publicKey = await crypto.subtle.importKey('raw', buffer(fromHex(body.public_key, 32)), 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', publicKey, buffer(fromHex(record.signature, 64)), buffer(accountBytes(body)))) throw new Error('invalid_account_signature');
  return accountDigest(accountBytes(record));
}
export async function signAccount(root: Uint8Array, body: AccountBody): Promise<AccountRecord> {
  const key = await privateKey(root);
  const signature = hex(new Uint8Array(await crypto.subtle.sign('Ed25519', key, buffer(accountBytes(body)))));
  const record = { body, signature };
  await verifyAccount(record, body.network, body.user_id); // Root must match advertised identity.
  return record;
}
export async function accountRecord(root: Uint8Array, publicKey: string, network: string, vault: Vault, dialogsDigest: string, version = 1, previous = '0'.repeat(64)) {
  networkId(network);
  const identity = await meshUserId(publicKey);
  if (vault.userId !== identity) throw new Error('vault_identity_mismatch');
  const vaultBytes = accountBytes(vault);
  const body: AccountBody = { domain: 'sfera-mesh-account-v1', network, user_id: identity, public_key: publicKey, version, previous, vault_digest: await accountDigest(vaultBytes), dialogs_digest: dialogsDigest };
  return { record: await signAccount(root, body), vaultBytes };
}
export async function createMeshAccount(password: string, network: string, dialogsDigest: string) {
  networkId(network); fromHex(dialogsDigest, 32);
  // Unsupported WebCrypto Ed25519 rejects here; never fall back to server key generation.
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  const encoded = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  if (encoded.length !== 48 || hex(encoded.subarray(0, 16)) !== hex(prefix)) { encoded.fill(0); throw new Error('unsupported_identity_encoding'); }
  const root = encoded.slice(16); encoded.fill(0);
  try {
    const publicKey = hex(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
    const identity = await meshUserId(publicKey);
    const vault = await wrapArchiveRoot(root, identity, password);
    return { root, vault, publicKey, userId: identity, ...await accountRecord(root, publicKey, network, vault, dialogsDigest) };
  } catch (error) { root.fill(0); throw error; }
}
export async function openMeshAccount(record: AccountRecord, vaultBytes: Uint8Array, password: string, network: string, expectedUser: string) {
  await verifyAccount(record, network, expectedUser);
  if (vaultBytes.length > 4096 || await accountDigest(vaultBytes) !== record.body.vault_digest) throw new Error('vault_digest_mismatch');
  const vault = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(vaultBytes)) as Vault;
  const root = await unlockVault(vault, expectedUser, password);
  try { await signAccount(root, record.body); return root; }
  catch (error) { root.fill(0); throw error; }
}
