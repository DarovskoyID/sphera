/** Signed laboratory device history. No login scopes or message keys are granted. */
import { accountBytes, accountDigest, meshUserId, signIdentityStatement } from './account';

const ZERO = '0'.repeat(64);
const hex = (bytes: Uint8Array) => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const buffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;
function fromHex(value: string, length: number) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${length * 2}}$`).test(value)) throw new Error('invalid_device_encoding');
  return Uint8Array.from(value.match(/../g)!, part => parseInt(part, 16));
}
function fields(value: object, expected: string[]) {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== expected.sort().join(',')) throw new Error('invalid_device_schema');
}
export type DeviceBody = {
  domain: 'sfera-mesh-device-event-lab-v1'; network: string; user_id: string;
  version: number; previous: string; operation: 'enroll' | 'revoke'; device_id: string; device_public: string;
};
export type DeviceEvent = { body: DeviceBody; owner_signature: string; device_signature: string };
export type DeviceCheckpoint = { version: number; digest: string };

export async function meshDeviceId(publicKey: string) {
  const publicBytes = fromHex(publicKey, 32), prefix = new TextEncoder().encode('sfera-mesh-device-v1\0');
  const data = new Uint8Array(prefix.length + publicBytes.length);
  data.set(prefix); data.set(publicBytes, prefix.length);
  return accountDigest(data);
}
async function signature(publicKey: string, encoded: string, body: DeviceBody) {
  const key = await crypto.subtle.importKey('raw', buffer(fromHex(publicKey, 32)), 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, buffer(fromHex(encoded, 64)), buffer(accountBytes(body)))) throw new Error('invalid_device_signature');
}
export async function verifyDeviceEvent(event: DeviceEvent, network: string, ownerPublic: string, expectedOwner?: string) {
  // Copy before the first await: caller mutation cannot race signature checks.
  const frozen: DeviceEvent = JSON.parse(JSON.stringify(event));
  fields(frozen, ['body', 'owner_signature', 'device_signature']);
  const body = frozen.body;
  fields(body, ['domain', 'network', 'user_id', 'version', 'previous', 'operation', 'device_id', 'device_public']);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(network) || body.domain !== 'sfera-mesh-device-event-lab-v1' || body.network !== network || !Number.isSafeInteger(body.version) || body.version < 1 || body.version > 256 || !['enroll', 'revoke'].includes(body.operation) || accountBytes(frozen).length > 2048) throw new Error('invalid_device_context');
  fromHex(body.previous, 32); fromHex(body.user_id, 32); fromHex(body.device_id, 32);
  if (body.device_public === ownerPublic || body.user_id !== (expectedOwner ?? await meshUserId(ownerPublic)) || body.device_id !== await meshDeviceId(body.device_public)) throw new Error('device_key_mismatch');
  await signature(ownerPublic, frozen.owner_signature, body);
  if (body.operation === 'enroll') await signature(body.device_public, frozen.device_signature, body);
  else if (frozen.device_signature !== '') throw new Error('unexpected_device_signature');
  return { event: frozen, digest: await accountDigest(accountBytes(frozen)) };
}
export async function signDeviceEvent(ownerRoot: Uint8Array, ownerPublic: string, body: DeviceBody, deviceRoot?: Uint8Array) {
  const frozen: DeviceBody = JSON.parse(JSON.stringify(body));
  if (frozen.operation === 'enroll' && !deviceRoot) throw new Error('device_possession_required');
  const event: DeviceEvent = {
    body: frozen,
    owner_signature: hex(await signIdentityStatement(ownerRoot, accountBytes(frozen))),
    device_signature: frozen.operation === 'enroll' ? hex(await signIdentityStatement(deviceRoot!, accountBytes(frozen))) : '',
  };
  return (await verifyDeviceEvent(event, frozen.network, ownerPublic)).event;
}
export async function verifyDeviceHistory(events: DeviceEvent[], network: string, ownerPublic: string, checkpoint?: DeviceCheckpoint) {
  if (!Array.isArray(events) || events.length > 256) throw new Error('device_history_limit');
  const frozen: DeviceEvent[] = JSON.parse(JSON.stringify(events));
  checkpoint = checkpoint ? { ...checkpoint } : undefined;
  if (typeof network !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(network)) throw new Error('invalid_device_context');
  fromHex(ownerPublic, 32);
  if (checkpoint && (!Number.isSafeInteger(checkpoint.version) || checkpoint.version < 0 || checkpoint.version > 256)) throw new Error('invalid_device_checkpoint');
  if (checkpoint) fromHex(checkpoint.digest, 32);
  let version = 0, digest = ZERO;
  const history = new Map<number, string>([[0, ZERO]]);
  const devices: Record<string, { publicKey: string; active: boolean }> = {};
  for (const event of frozen) {
    const checked = await verifyDeviceEvent(event, network, ownerPublic);
    const body = checked.event.body;
    if (body.version !== version + 1 || body.previous !== digest) throw new Error('device_chain_gap_or_fork');
    const old = devices[body.device_id];
    if (body.operation === 'enroll') {
      if (old || Object.keys(devices).length >= 64) throw new Error('device_already_seen_or_limit');
      devices[body.device_id] = { publicKey: body.device_public, active: true };
    } else {
      if (!old?.active) throw new Error('device_not_active');
      old.active = false;
    }
    version = body.version; digest = checked.digest;
    history.set(version, digest);
  }
  if (checkpoint && history.get(checkpoint.version) !== checkpoint.digest) throw new Error('device_checkpoint_rollback_or_fork');
  return { version, digest, devices, confirmedByConsensus: false as const };
}
