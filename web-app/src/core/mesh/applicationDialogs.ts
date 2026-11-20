import { accountBytes, accountDigest, meshUserId, signIdentityStatement } from './account';
import { meshDeviceId } from './devices';
import type { ApplicationSignalIdentity } from './applicationSignals';

type DialogBase = { network: string; genesis: string; creator: string; control_epoch: number; members: [string, string] };
export type ApplicationDialogBody = DialogBase & ({ domain: 'sfera-mesh-application-dialog-v1' }
  | { domain: 'sfera-mesh-application-dialog-device-v1'; creator_device: string; devices_version: number });
export type ApplicationDialogRecord = { body: ApplicationDialogBody; signature: string };
const hex32 = /^[0-9a-f]{64}$/;
const hex = (bytes: Uint8Array) => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');

export async function applicationDialogId(network: string, members: readonly string[]) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(network) || members.length !== 2
      || !members.every(owner => hex32.test(owner)) || members[0] >= members[1]) throw new Error('invalid_application_dialog_identity');
  return accountDigest(new TextEncoder().encode(`sfera-mesh-application-dialog-v1\0${network}\0${members[0]}\0${members[1]}`));
}

export function applicationConversationId(identity: string) {
  if (!hex32.test(identity)) throw new Error('invalid_application_dialog_identity');
  const bytes = Uint8Array.from(identity.slice(0, 32).match(/../g)!, pair => parseInt(pair, 16));
  bytes[6] = (bytes[6] & 15) | 128; bytes[8] = (bytes[8] & 63) | 128;
  const id = hex(bytes);
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

export async function initialApplicationDialog(root: Uint8Array, publicKey: string, network: string,
  genesis: string, peerOwner: string): Promise<ApplicationDialogRecord> {
  if (!hex32.test(genesis) || !hex32.test(peerOwner)) throw new Error('invalid_application_dialog');
  const creator = await meshUserId(publicKey);
  const members = [creator, peerOwner].sort() as [string, string];
  await applicationDialogId(network, members);
  const body: ApplicationDialogBody = { domain: 'sfera-mesh-application-dialog-v1', network, genesis, creator, control_epoch: 0, members };
  const signature = await signIdentityStatement(root, accountBytes(body));
  const rawPublic = Uint8Array.from(publicKey.match(/../g)!, pair => parseInt(pair, 16));
  const key = await crypto.subtle.importKey('raw', rawPublic.buffer, 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, new Uint8Array(signature).buffer, new Uint8Array(accountBytes(body)).buffer)) throw new Error('application_owner_key_mismatch');
  return { body, signature: hex(signature) };
}

/** Normal device action: creating a DM does not require the owner's root. */
export async function signDeviceApplicationDialog(identity: ApplicationSignalIdentity, key: CryptoKey,
  peerOwner: string, controlEpoch: number, deviceHistoryVersion: number): Promise<ApplicationDialogRecord> {
  identity = { ...identity };
  if (![identity.genesis,identity.owner,identity.device,identity.devicePublic,peerOwner].every(value => hex32.test(value))
      || !Number.isSafeInteger(controlEpoch) || controlEpoch < 0 || controlEpoch > 16
      || !Number.isSafeInteger(deviceHistoryVersion) || deviceHistoryVersion < 1 || deviceHistoryVersion > 256
      || await meshDeviceId(identity.devicePublic) !== identity.device) throw new Error('invalid_application_dialog_device');
  const members = [identity.owner,peerOwner].sort() as [string,string];
  await applicationDialogId(identity.network,members);
  const body: ApplicationDialogBody = { domain: 'sfera-mesh-application-dialog-device-v1', network: identity.network,
    genesis: identity.genesis, creator: identity.owner, control_epoch: controlEpoch, creator_device: identity.device,
    devices_version: deviceHistoryVersion, members };
  const bytes = new Uint8Array(accountBytes(body));
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519',key,bytes.buffer));
  const rawPublic = Uint8Array.from(identity.devicePublic.match(/../g)!, pair => parseInt(pair,16));
  const publicKey = await crypto.subtle.importKey('raw',rawPublic.buffer,'Ed25519',false,['verify']);
  if (!await crypto.subtle.verify('Ed25519',publicKey,new Uint8Array(signature).buffer,bytes.buffer)) throw new Error('application_dialog_key_mismatch');
  return { body,signature:hex(signature) };
}
