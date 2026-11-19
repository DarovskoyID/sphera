import { accountBytes, accountDigest } from './account';
import { validateTrustedEntryPoints, type TrustedEntryPoint } from './entryPoint';
import { cipherMembershipRoom, type CipherPeer } from './pairwiseCipher';
import { parseGuildCipherMessage, type GuildCipherMessage } from './guildCipherMessage';
import { verifyCipherScope, type CipherScopeProof } from './cipherPolicy';
export type GuildCipherStatus = { id: string; digest: string; state: 'present' | 'deleted' | 'unknown'; authorization: CipherScopeProof | null };

export async function verifyGuildCipherStatus(value: unknown, pin: TrustedEntryPoint, own: CipherPeer,
  user: string, guild: string, scope: string, nonce: string, values: GuildCipherMessage[]) {
  pin = { ...pin }; own = { ...own };
  const wires = values.map(wire => parseGuildCipherMessage(wire, guild, scope));
  const document = JSON.parse(JSON.stringify(value));
  const schema = (item: unknown, fields: string[]) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== fields.sort().join(',')) throw new Error('invalid_guild_cipher_status');
  };
  if (accountBytes(document).length > 1048576 || !/^[0-9a-f]{64}$/.test(nonce) ||
      wires.length < 1 || wires.length > 16 || new Set(wires.map(wire => wire.id)).size !== wires.length) throw new Error('invalid_guild_cipher_status');
  schema(document, ['body', 'signature']);
  const body = document.body, now = Math.floor(Date.now() / 1000);
  schema(body, ['domain', 'authority', 'network', 'genesis', 'entry', 'user', 'owner', 'device', 'guild', 'scope', 'nonce', 'issued_at', 'expires_at', 'messages']);
  if (body.domain !== 'sfera-guild-cipher-status-v1' || body.authority !== 'selected_application_sql' ||
      body.network !== pin.network || own.network !== pin.network || body.genesis !== own.genesis || body.entry !== pin.nodeId ||
      body.user !== user || body.owner !== own.owner || body.device !== own.device || body.guild !== guild || body.scope !== scope || body.nonce !== nonce ||
      !Number.isSafeInteger(body.issued_at) || !Number.isSafeInteger(body.expires_at) || body.expires_at !== body.issued_at + 15 ||
      body.expires_at <= now || body.issued_at > now + 5 || body.issued_at < now - 15 || !Array.isArray(body.messages) || body.messages.length !== wires.length ||
      typeof document.signature !== 'string' || !/^[0-9a-f]{128}$/.test(document.signature)) throw new Error('invalid_guild_cipher_status');
  const { network, nodeId, publicKey, url, label } = pin;
  await validateTrustedEntryPoints([{ network, nodeId, publicKey, url, label }]);
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(publicKey.match(/../g)!, part => parseInt(part, 16)), 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, Uint8Array.from(document.signature.match(/../g)!, (part: string) => parseInt(part, 16)),
      new Uint8Array(accountBytes(body)))) throw new Error('invalid_guild_cipher_status_signature');
  for (let i = 0; i < wires.length; i++) {
    const item = body.messages[i]; schema(item, ['id', 'digest', 'state', 'authorization']);
    if (item.id !== wires[i].id || item.digest !== await accountDigest(accountBytes(wires[i])) ||
        !['present', 'deleted', 'unknown'].includes(item.state)) throw new Error('guild_cipher_status_context_mismatch');
    if (item.authorization !== null) {
      if (item.state !== 'present') throw new Error('guild_cipher_status_context_mismatch');
      const proof = item.authorization;
      // A new member without an original certificate can inspect current state,
      // but historical decryption separately requires its own original SDK pin.
      const sender = proof?.body?.certificates?.find((certificate: { body: CipherPeer }) =>
        certificate.body.owner === wires[i].sender.owner && certificate.body.device === wires[i].sender.device);
      if (!sender) throw new Error('guild_cipher_historical_sender_missing');
      const checked = await verifyCipherScope(proof, pin, sender.body, wires[i].sender.user, 'guild', scope, proof.body.nonce, proof.body.issued_at);
      if (wires[i].envelope.epoch !== checked.membership.epoch || wires[i].envelope.content.sender_key !== sender.body.curve25519 ||
          wires[i].envelope.room !== await cipherMembershipRoom(checked.membership, sender.body)) throw new Error('guild_cipher_historical_context_mismatch');
    }
  }
  if (body.expires_at <= Math.floor(Date.now() / 1000)) throw new Error('guild_cipher_status_expired');
  return { messages: body.messages as GuildCipherStatus[], expiresAt: body.expires_at as number };
}
