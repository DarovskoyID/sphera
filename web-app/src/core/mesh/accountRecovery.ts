/** Local recovery candidates. Callers must obtain the exact checkpoint from an
 * independently verified current directory and publish candidates atomically.
 * An embedded signature alone never establishes freshness.
 */
import { accountBytes, accountDigest, accountRecord, openMeshAccount, signIdentityStatement, verifyAccount, type AccountRecord } from './account';
import { verifyControlledAccount, type AccountControlHead } from './accountControls';
import { unlockVault, wrapArchiveRoot, type Vault } from './vault';

export type AccountCheckpoint = { version: number; digest: string };
export type RecoveryPackage = {
  domain: 'sfera-mesh-account-recovery-v1'; network: string; genesis: string;
  record: AccountRecord; vault: Vault;
  history?: AccountControlHead[];
};
export type AccountControlContext = { genesis: string; history: AccountControlHead[] };
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function context(network: string, genesis: string) {
  if (typeof network !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(network) || !hash(genesis)) throw new Error('invalid_recovery_context');
}
/** Exact current head, not merely an ancestor that this record happens to extend. */
export async function requireCurrentAccount(record: AccountRecord, network: string, owner: string, checkpoint: AccountCheckpoint, control?: AccountControlContext) {
  const frozen = copy(record), head = copy(checkpoint);
  if (!head || Object.keys(head).sort().join(',') !== 'digest,version' || !Number.isSafeInteger(head.version) || head.version < 1 || !hash(head.digest)) throw new Error('invalid_account_checkpoint');
  const digest = control ? (await verifyControlledAccount(frozen, control.history, network, control.genesis, owner)).digest : await verifyAccount(frozen, network, owner);
  if (head.version !== frozen.body.version || head.digest !== digest) throw new Error('account_checkpoint_rollback_or_fork');
  return frozen;
}
async function openCurrent(record: AccountRecord, encoded: Uint8Array, password: string, network: string, owner: string, control?: AccountControlContext) {
  if (!control) return openMeshAccount(record, encoded, password, network, owner);
  await verifyControlledAccount(record, control.history, network, control.genesis, owner);
  if (encoded.length > 4096 || await accountDigest(encoded) !== record.body.vault_digest) throw new Error('vault_digest_mismatch');
  const root = await unlockVault(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded)), owner, password);
  try { await checkRoot(root, record); return root; } catch (error) { root.fill(0); throw error; }
}
async function checkRoot(root: Uint8Array, record: AccountRecord) {
  const signature = Array.from(await signIdentityStatement(root, accountBytes(record.body)), x => x.toString(16).padStart(2, '0')).join('');
  if (signature !== record.signature) throw new Error('account_root_mismatch');
}
async function nextRecord(root: Uint8Array, current: AccountRecord, vault: Vault, network: string, owner: string, control?: AccountControlContext) {
  if (!control) return accountRecord(root, current.body.public_key, network, vault, current.body.dialogs_digest, nextVersion(current), await accountDigest(accountBytes(current)));
  await checkRoot(root, current);
  const body = { ...current.body, version: nextVersion(current), previous: await accountDigest(accountBytes(current)), vault_digest: await accountDigest(accountBytes(vault)) };
  const record = { body, signature: Array.from(await signIdentityStatement(root, accountBytes(body)), x => x.toString(16).padStart(2, '0')).join('') };
  await verifyControlledAccount(record, control.history, network, control.genesis, owner);
  return { record, vaultBytes: accountBytes(vault) };
}
function nextVersion(record: AccountRecord) {
  if (record.body.version >= Number.MAX_SAFE_INTEGER) throw new Error('account_version_exhausted');
  return record.body.version + 1;
}
/** A recovery secret is random entropy, never a user-selected password. */
function secret(value: string) {
  if (!hash(value)) throw new Error('invalid_recovery_secret');
  return value;
}
function recoveryUser(network: string, genesis: string, owner: string) {
  // Binding inside AES-GCM prevents replacing the outer network/genesis label.
  return accountDigest(accountBytes(['sfera-mesh-account-recovery-v1', network, genesis, owner]));
}
export async function prepareAccountRecovery(record: AccountRecord, vaultBytes: Uint8Array, password: string,
  network: string, genesis: string, owner: string, checkpoint: AccountCheckpoint, control?: AccountControlContext) {
  context(network, genesis);
  const encoded = new Uint8Array(vaultBytes);
  const current = await requireCurrentAccount(record, network, owner, checkpoint, control);
  const root = await openCurrent(current, encoded, password, network, owner, control);
  const entropy = crypto.getRandomValues(new Uint8Array(32));
  try {
    const recoverySecret = Array.from(entropy, byte => byte.toString(16).padStart(2, '0')).join('');
    const vault = await wrapArchiveRoot(root, await recoveryUser(network, genesis, owner), recoverySecret);
    const recovery: RecoveryPackage = { domain: 'sfera-mesh-account-recovery-v1', network, genesis, record: current, vault };
    if (control) recovery.history = copy(control.history);
    return { recovery, recoverySecret };
  } finally { root.fill(0); entropy.fill(0); encoded.fill(0); }
}
export async function recoverAccount(value: RecoveryPackage, recoverySecret: string, newPassword: string,
  network: string, genesis: string, owner: string, checkpoint: AccountCheckpoint, control?: AccountControlContext) {
  context(network, genesis); secret(recoverySecret);
  const recovery = copy(value);
  if (!recovery || !['domain,genesis,network,record,vault', 'domain,genesis,history,network,record,vault'].includes(Object.keys(recovery).sort().join(',')) ||
    recovery.domain !== 'sfera-mesh-account-recovery-v1' || recovery.network !== network || recovery.genesis !== genesis ||
    accountBytes(recovery).length > 98304) throw new Error('invalid_account_recovery');
  if (recovery.history && (!control || await accountDigest(accountBytes(recovery.history)) !== await accountDigest(accountBytes(control.history)))) throw new Error('recovery_controller_mismatch');
  const current = await requireCurrentAccount(recovery.record, network, owner, checkpoint, control);
  const root = await unlockVault(recovery.vault, await recoveryUser(network, genesis, owner), recoverySecret);
  try {
    const vault = await wrapArchiveRoot(root, owner, newPassword);
    await checkRoot(root, current);
    return { vault, ...await nextRecord(root, current, vault, network, owner, control) };
  } finally { root.fill(0); }
}
export async function prepareAccountPasswordChange(record: AccountRecord, vaultBytes: Uint8Array,
  oldPassword: string, newPassword: string, network: string, owner: string, checkpoint: AccountCheckpoint, control?: AccountControlContext) {
  const encoded = new Uint8Array(vaultBytes);
  const current = await requireCurrentAccount(record, network, owner, checkpoint, control);
  const root = await openCurrent(current, encoded, oldPassword, network, owner, control);
  try {
    const vault = await wrapArchiveRoot(root, owner, newPassword);
    return { vault, ...await nextRecord(root, current, vault, network, owner, control) };
  } finally { root.fill(0); encoded.fill(0); }
}
