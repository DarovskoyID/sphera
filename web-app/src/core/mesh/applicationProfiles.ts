import { accountBytes, accountDigest, meshUserId, signIdentityStatement } from './account';

export type ApplicationProfileBody = {
  domain: 'sfera-mesh-application-profile-v1'; network: string; genesis: string;
  owner: string; control_epoch: number; version: number; previous: string;
  handle: string; nickname_utf8: string;
};
export type ApplicationProfileRecord = { body: ApplicationProfileBody; signature: string };
const hex = (bytes: Uint8Array) => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const hex32 = /^[0-9a-f]{64}$/;
const raw = (value: string) => Uint8Array.from(value.match(/../g)!, pair => parseInt(pair, 16));

export async function applicationUserId(network: string, owner: string) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(network) || !hex32.test(owner)) throw new Error('invalid_application_identity');
  const prefix = new TextEncoder().encode(`sfera-mesh-application-user-v1\0${network}\0`);
  const input = new Uint8Array(prefix.length + 32); input.set(prefix); input.set(raw(owner), prefix.length);
  const bytes = raw((await accountDigest(input)).slice(0, 32));
  bytes[6] = (bytes[6] & 15) | 128; bytes[8] = (bytes[8] & 63) | 128;
  const id = hex(bytes);
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/** Initial public name registration; the root seed never leaves this device. */
export async function initialApplicationProfile(root: Uint8Array, publicKey: string, network: string,
  genesis: string, handle: string, nickname: string): Promise<ApplicationProfileRecord> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(network) || !hex32.test(genesis) || !/^[a-z][a-z0-9_]{2,31}$/.test(handle)) throw new Error('invalid_application_profile');
  const name = new TextEncoder().encode(nickname);
  if (name.length < 1 || name.length > 160 || Array.from(nickname).length > 50 || /[\u0000-\u001f\u007f-\u009f]/.test(nickname)
      || new TextDecoder('utf-8', { fatal: true }).decode(name) !== nickname) throw new Error('invalid_application_nickname');
  const body: ApplicationProfileBody = { domain: 'sfera-mesh-application-profile-v1', network, genesis,
    owner: await meshUserId(publicKey), control_epoch: 0, version: 1, previous: '0'.repeat(64),
    handle, nickname_utf8: hex(name) };
  const signature = await signIdentityStatement(root, accountBytes(body));
  const key = await crypto.subtle.importKey('raw', raw(publicKey).buffer, 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, new Uint8Array(signature).buffer, new Uint8Array(accountBytes(body)).buffer)) throw new Error('application_owner_key_mismatch');
  return { body, signature: hex(signature) };
}
