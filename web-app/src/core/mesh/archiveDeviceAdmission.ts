import { accountBytes } from './account';
import { entryProbeNonce, type TrustedEntryPoint } from './entryPoint';
import { meshDeviceId } from './devices';
import type { CipherIdentity } from './pairwiseCipher';

/** The archive key file's self-signature alone cannot assert its owner's ID.
 * The source entry must confirm that its signer was admitted to this owner.
 * Historical admission remains valid for reading after device revocation.
 */
export async function confirmArchiveDevice(post: (path: string, body: unknown) => Promise<unknown>,
  pin: TrustedEntryPoint, own: CipherIdentity, user: string, device: string, publicKey: string) {
  if (!/^[0-9a-f]{64}$/.test(device) || !/^[0-9a-f]{64}$/.test(publicKey) || await meshDeviceId(publicKey) !== device) throw new Error('archive_device_context');
  const nonce = entryProbeNonce(), value = await post('/api/auth/mesh/cipher/archive-device/', { device, device_public: publicKey, nonce });
  const document = JSON.parse(JSON.stringify(value)), body = document?.body, now = Math.floor(Date.now() / 1000);
  if (!document || Object.keys(document).sort().join(',') !== 'body,signature' || !body ||
      Object.keys(body).sort().join(',') !== 'archive_device,archive_device_public,authority,device,domain,entry,expires_at,genesis,issued_at,network,nonce,owner,user' ||
      body.domain !== 'sfera-mesh-archive-device-v1' || body.authority !== 'selected_entry_verified_directory' ||
      body.network !== own.network || body.network !== pin.network || body.genesis !== own.genesis || body.entry !== pin.nodeId ||
      body.owner !== own.owner || body.device !== own.device || body.user !== user || body.archive_device !== device || body.archive_device_public !== publicKey ||
      body.nonce !== nonce || !Number.isSafeInteger(body.issued_at) || !Number.isSafeInteger(body.expires_at) ||
      body.issued_at > now + 5 || body.issued_at < now - 15 || body.expires_at !== body.issued_at + 15 || body.expires_at <= now ||
      typeof document.signature !== 'string' || !/^[0-9a-f]{128}$/.test(document.signature)) throw new Error('archive_device_admission_rejected');
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(pin.publicKey.match(/../g)!, x => parseInt(x, 16)).buffer, 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, Uint8Array.from(document.signature.match(/../g)!, (x: string) => parseInt(x, 16)).buffer,
    new Uint8Array(accountBytes(body)).buffer)) throw new Error('archive_device_admission_signature');
  return body.expires_at as number;
}
