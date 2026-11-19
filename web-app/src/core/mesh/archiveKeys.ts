/** A password-wrapped random archive key, authenticated by the existing owner.
 * Possession grants no signing, device admission or messaging authority.
 */
import { accountBytes, accountDigest, meshUserId, signIdentityStatement } from './account';
import { unlockVault, wrapArchiveRoot, type Vault } from './vault';
import { verifyControlledAccount, type AccountControlHead } from './accountControls';
import type { AccountRecord } from './account';
export type ArchiveKeyFile = { body: { domain: 'sfera-mesh-personal-archive-key-v1'; network: string;
  genesis: string; owner: string; owner_public: string; epoch: number; previous: string; key_id: string; vault: Vault }; signature: string;
  control?: { record: AccountRecord; history: AccountControlHead[] } };
const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
async function wrappingId(body: ArchiveKeyFile['body']) {
  return accountDigest(accountBytes([body.domain, body.network, body.genesis, body.owner, body.epoch, body.previous, body.key_id]));
}
export async function verifyArchiveKeyFile(value: unknown, network: string, genesis: string, ownerPublic: string) {
  const file = JSON.parse(JSON.stringify(value)) as ArchiveKeyFile;
  if (!file || !['body,signature', 'body,control,signature'].includes(Object.keys(file).sort().join(',')) || !file.body ||
    Object.keys(file.body).sort().join(',') !== 'domain,epoch,genesis,key_id,network,owner,owner_public,previous,vault' ||
    file.body.domain !== 'sfera-mesh-personal-archive-key-v1' || file.body.network !== network || !/^[A-Za-z0-9._-]{1,128}$/.test(network) ||
    !hash(genesis) || file.body.genesis !== genesis || file.body.owner_public !== ownerPublic || !hash(ownerPublic) ||
    !hash(file.body.owner) || !hash(file.body.key_id) || !hash(file.body.previous) ||
    !Number.isSafeInteger(file.body.epoch) || file.body.epoch < 1 || (file.body.epoch === 1 && file.body.previous !== '0'.repeat(64)) ||
    typeof file.signature !== 'string' || !/^[0-9a-f]{128}$/.test(file.signature) || accountBytes(file).length > 98304) throw new Error('invalid_archive_key_file');
  if (file.body.owner !== await meshUserId(ownerPublic)) throw new Error('archive_key_owner_mismatch');
  const signer = file.control ? (await verifyControlledAccount(file.control.record, file.control.history, network, genesis, file.body.owner)).controllerPublic : ownerPublic;
  const publicKey = await crypto.subtle.importKey('raw', Uint8Array.from(signer.match(/../g)!, x => parseInt(x, 16)).buffer, 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', publicKey, Uint8Array.from(file.signature.match(/../g)!, x => parseInt(x, 16)).buffer,
    new Uint8Array(accountBytes(file.body)).buffer)) throw new Error('invalid_archive_key_signature');
  if (file.body.vault?.userId !== await wrappingId(file.body)) throw new Error('archive_key_vault_context');
  return file;
}
export async function createArchiveKeyFile(ownerRoot: Uint8Array, ownerPublic: string, network: string,
  genesis: string, password: string, previous?: ArchiveKeyFile, control?: ArchiveKeyFile['control']) {
  const root = crypto.getRandomValues(new Uint8Array(32));
  const signingRoot = new Uint8Array(ownerRoot);
  try {
    const prior = previous ? await verifyArchiveKeyFile(previous, network, genesis, ownerPublic) : undefined;
    if (prior && prior.body.epoch === Number.MAX_SAFE_INTEGER) throw new Error('archive_key_epoch_exhausted');
    const body: ArchiveKeyFile['body'] = { domain: 'sfera-mesh-personal-archive-key-v1', network, genesis,
      owner: await meshUserId(ownerPublic), owner_public: ownerPublic, epoch: prior ? prior.body.epoch + 1 : 1,
      previous: prior ? await accountDigest(accountBytes(prior)) : '0'.repeat(64), key_id: await accountDigest(root), vault: null as unknown as Vault };
    body.vault = await wrapArchiveRoot(root, await wrappingId(body), password);
    const signature = Array.from(await signIdentityStatement(signingRoot, accountBytes(body)), x => x.toString(16).padStart(2, '0')).join('');
    const file = await verifyArchiveKeyFile({ body, signature, ...(control ? { control } : {}) }, network, genesis, ownerPublic);
    return { file, root };
  } catch (error) { root.fill(0); throw error; }
  finally { signingRoot.fill(0); }
}
export async function openArchiveKeyFile(value: unknown, password: string, network: string, genesis: string, ownerPublic: string) {
  const file = await verifyArchiveKeyFile(value, network, genesis, ownerPublic);
  const root = await unlockVault(file.body.vault, await wrappingId(file.body), password);
  if (await accountDigest(root) !== file.body.key_id) { root.fill(0); throw new Error('archive_key_root_mismatch'); }
  return { file, root };
}
