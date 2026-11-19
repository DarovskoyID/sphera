import { accountBytes, accountDigest } from './account';
import type { CipherPeer } from './pairwiseCipher';
import type { TrustedEntryPoint } from './entryPoint';
import type { DmCipherMessage } from './dmCipherMessage';
export type DmCipherStatus = { id: string; digest: string; state: 'present' | 'deleted' | 'unknown' };
export async function verifyDmCipherStatus(value: unknown, pin: TrustedEntryPoint, own: CipherPeer,
  user: string, scope: string, nonce: string, wires: DmCipherMessage[]) {
  const document = JSON.parse(JSON.stringify(value));
  const schema = (item: unknown, fields: string[]) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== fields.sort().join(',')) throw new Error('invalid_dm_cipher_status');
  };
  if (accountBytes(document).length > 16384) throw new Error('invalid_dm_cipher_status');
  schema(document, ['body', 'signature']);
  const body = document.body, now = Math.floor(Date.now() / 1000);
  schema(body, ['domain', 'authority', 'network', 'genesis', 'entry', 'user', 'owner', 'device', 'scope', 'nonce', 'issued_at', 'expires_at', 'messages']);
  if (body.domain !== 'sfera-dm-cipher-status-v1' || body.authority !== 'selected_application_sql' || body.network !== pin.network ||
      body.genesis !== own.genesis || body.entry !== pin.nodeId || body.user !== user || body.owner !== own.owner || body.device !== own.device ||
      body.scope !== scope || body.nonce !== nonce || !Number.isSafeInteger(body.issued_at) || !Number.isSafeInteger(body.expires_at) ||
      body.expires_at !== body.issued_at + 15 || body.expires_at <= now || body.issued_at > now + 5 || body.issued_at < now - 15 ||
      !Array.isArray(body.messages) || body.messages.length !== wires.length || wires.length < 1 || wires.length > 16 ||
      typeof document.signature !== 'string' || !/^[0-9a-f]{128}$/.test(document.signature)) throw new Error('invalid_dm_cipher_status');
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(pin.publicKey.match(/../g)!, part => parseInt(part, 16)), 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, Uint8Array.from(document.signature.match(/../g)!, (part: string) => parseInt(part, 16)), new Uint8Array(accountBytes(body)))) throw new Error('invalid_dm_cipher_status_signature');
  for (let i = 0; i < wires.length; i++) {
    const item = body.messages[i]; schema(item, ['id', 'digest', 'state']);
    if (item.id !== wires[i].id || item.digest !== await accountDigest(accountBytes(wires[i])) || !['present', 'deleted', 'unknown'].includes(item.state)) throw new Error('dm_cipher_status_context_mismatch');
  }
  if (body.expires_at <= Math.floor(Date.now() / 1000)) throw new Error('dm_cipher_status_expired');
  return { messages: body.messages as DmCipherStatus[], expiresAt: body.expires_at as number };
}
