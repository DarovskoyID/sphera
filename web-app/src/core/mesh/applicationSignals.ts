import { accountBytes } from './account';
import { applicationUserId } from './applicationProfiles';

export type ApplicationSignalIdentity = { network: string; genesis: string; owner: string; device: string; devicePublic: string };
export type ApplicationSignalPacket = { body: { domain: 'sfera-mesh-application-signal-v1'; network: string;
  genesis: string; sender: string; device: string; recipient: string; issued_at: number; expires_at: number;
  nonce: string; signal_utf8: string }; signature: string };
const hex = (bytes: Uint8Array) => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const types = new Set(['offer','answer','candidate','call-end','call-rejected','call-resume','call-resumed','video-toggle','demo-toggle']);

/** Signs with the already unlocked non-exportable device key, never an owner root. */
export async function signApplicationSignal(identity: ApplicationSignalIdentity, key: CryptoKey,
  recipient: string, signal: Record<string, unknown>, now = Math.floor(Date.now() / 1000)): Promise<ApplicationSignalPacket> {
  identity = { ...identity };
  if (![identity.genesis,identity.owner,identity.device,identity.devicePublic,recipient].every(value => /^[0-9a-f]{64}$/.test(value))
      || identity.owner === recipient || !Number.isSafeInteger(now) || now < 1
      || !signal || !types.has(signal.type as string)) throw new Error('invalid_application_signal');
  // Snapshot before awaits: caller edits cannot change the signed offer/ICE data.
  const frozen = JSON.parse(JSON.stringify(signal)) as Record<string, unknown>;
  const sender = await applicationUserId(identity.network,identity.owner);
  const target = await applicationUserId(identity.network,recipient);
  if (frozen.to !== target || (frozen.from !== undefined && frozen.from !== sender)) throw new Error('application_signal_identity_mismatch');
  if (frozen.type === 'offer' || frozen.type === 'answer') {
    const sdp = frozen.sdp as Record<string, unknown> | null;
    if (!sdp || sdp.type !== frozen.type || typeof sdp.sdp !== 'string') throw new Error('application_signal_sdp');
  }
  if (frozen.type === 'candidate' && (!frozen.candidate || typeof frozen.candidate !== 'object' || Array.isArray(frozen.candidate))) throw new Error('application_signal_candidate');
  const bytes = accountBytes(frozen);
  if (bytes.length > 65536) throw new Error('application_signal_capacity');
  const body: ApplicationSignalPacket['body'] = { domain: 'sfera-mesh-application-signal-v1', network: identity.network,
    genesis: identity.genesis, sender: identity.owner, device: identity.device, recipient,
    issued_at: now, expires_at: now + 30, nonce: hex(crypto.getRandomValues(new Uint8Array(32))), signal_utf8: hex(bytes) };
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519',key,new Uint8Array(accountBytes(body)).buffer));
  const publicBytes = Uint8Array.from(identity.devicePublic.match(/../g)!, pair => parseInt(pair,16));
  const publicKey = await crypto.subtle.importKey('raw',publicBytes.buffer,'Ed25519',false,['verify']);
  if (!await crypto.subtle.verify('Ed25519',publicKey,new Uint8Array(signature).buffer,new Uint8Array(accountBytes(body)).buffer)) throw new Error('application_signal_key_mismatch');
  return { body, signature: hex(signature) };
}
