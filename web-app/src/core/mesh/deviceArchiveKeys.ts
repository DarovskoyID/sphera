/** Separate random archive roots for one admitted device/application context. */
import { accountBytes, accountDigest } from './account';
import { meshDeviceId } from './devices';
import { unlockVault, wrapArchiveRoot, type Vault } from './vault';
export type DeviceArchiveContext = { network: string; genesis: string; owner: string; device: string;
  device_public: string; entry: string; user: string };
export type DeviceArchiveKeyFile = { body: DeviceArchiveContext & { domain: 'sfera-mesh-device-archive-key-v1';
  epoch: number; previous: string; key_id: string; vault: Vault }; signature: string };
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
async function wrappingId(body: DeviceArchiveKeyFile['body']) {
  return accountDigest(accountBytes([body.domain, body.network, body.genesis, body.owner, body.device,
    body.device_public, body.entry, body.user, body.epoch, body.previous, body.key_id]));
}
export async function verifyDeviceArchiveKeyFile(value: unknown, expected: DeviceArchiveContext) {
  const file = JSON.parse(JSON.stringify(value)) as DeviceArchiveKeyFile;
  if (!file || Object.keys(file).sort().join(',') !== 'body,signature' || !file.body ||
    Object.keys(file.body).sort().join(',') !== 'device,device_public,domain,entry,epoch,genesis,key_id,network,owner,previous,user,vault' ||
    file.body.domain !== 'sfera-mesh-device-archive-key-v1' || !/^[A-Za-z0-9._-]{1,128}$/.test(expected.network) ||
    ![file.body.genesis, file.body.owner, file.body.device, file.body.device_public, file.body.entry, file.body.key_id, file.body.previous].every(hash) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(file.body.user) ||
    !Number.isSafeInteger(file.body.epoch) || file.body.epoch < 1 || (file.body.epoch === 1 && file.body.previous !== '0'.repeat(64)) ||
    typeof file.signature !== 'string' || !/^[0-9a-f]{128}$/.test(file.signature) || accountBytes(file).length > 8192) throw new Error('invalid_device_archive_key');
  for (const name of ['network', 'genesis', 'owner', 'device', 'device_public', 'entry', 'user'] as const) {
    if (file.body[name] !== expected[name]) throw new Error('device_archive_key_context');
  }
  if (await meshDeviceId(file.body.device_public) !== file.body.device) throw new Error('device_archive_key_signer');
  const publicKey = await crypto.subtle.importKey('raw', Uint8Array.from(file.body.device_public.match(/../g)!, x => parseInt(x, 16)).buffer, 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', publicKey, Uint8Array.from(file.signature.match(/../g)!, x => parseInt(x, 16)).buffer,
    new Uint8Array(accountBytes(file.body)).buffer)) throw new Error('device_archive_key_signature');
  if (file.body.vault?.userId !== await wrappingId(file.body)) throw new Error('device_archive_key_wrapping_context');
  return file;
}
export async function prepareDeviceArchiveKey(context: DeviceArchiveContext, password: string,
  sign: (bytes: Uint8Array) => Promise<Uint8Array>, previous?: DeviceArchiveKeyFile) {
  context = { ...context };
  const root = crypto.getRandomValues(new Uint8Array(32));
  try {
    const prior = previous ? await verifyDeviceArchiveKeyFile(previous, context) : undefined;
    if (prior?.body.epoch === Number.MAX_SAFE_INTEGER) throw new Error('device_archive_epoch_exhausted');
    const body: DeviceArchiveKeyFile['body'] = { ...context, domain: 'sfera-mesh-device-archive-key-v1',
      epoch: prior ? prior.body.epoch + 1 : 1, previous: prior ? await accountDigest(accountBytes(prior)) : '0'.repeat(64),
      key_id: await accountDigest(root), vault: null as unknown as Vault };
    body.vault = await wrapArchiveRoot(root, await wrappingId(body), password);
    const signature = Array.from(await sign(accountBytes(body)), x => x.toString(16).padStart(2, '0')).join('');
    return await verifyDeviceArchiveKeyFile({ body, signature }, context);
  } finally { root.fill(0); }
}
export async function openDeviceArchiveKey(value: unknown, password: string, context: DeviceArchiveContext) {
  const file = await verifyDeviceArchiveKeyFile(value, context);
  const root = await unlockVault(file.body.vault, await wrappingId(file.body), password);
  try {
    if (await accountDigest(root) !== file.body.key_id) throw new Error('device_archive_key_root_mismatch');
    return { file, root };
  } catch (error) { root.fill(0); throw error; }
}
