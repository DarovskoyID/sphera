/** Guild and channel are authenticated inside Megolm, separately from DM. */
import { AuthorizedCipher, type CipherScopeProof } from './cipherPolicy';
import { parseDmCipherMessage, openDmCipherBody, validateCipherText, type DmCipherMessage, type DmCipherText } from './dmCipherMessage';
import { cipherUserId, type CipherIdentity } from './pairwiseCipher';

export type GuildCipherMessage = Omit<DmCipherMessage, 'domain'> & {
  domain: 'sfera-guild-cipher-message-v1'; guild: string;
};
const domain = 'sfera-guild-cipher-message-v1';
function identifier(value: string) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) throw new Error('invalid_guild_cipher_id');
}
export function parseGuildCipherMessage(value: unknown, guild: string, scope: string): GuildCipherMessage {
  identifier(guild); identifier(scope);
  const raw = JSON.stringify(value);
  if (!raw || new TextEncoder().encode(raw).length > 131072) throw new Error('invalid_guild_cipher_size');
  const copy = JSON.parse(raw);
  if (copy?.domain !== domain || copy.guild !== guild) throw new Error('guild_cipher_context_mismatch');
  const { guild: checkedGuild, ...rest } = copy;
  const checked = parseDmCipherMessage({ ...rest, domain: 'sfera-dm-cipher-message-v1' }, scope);
  return { ...checked, domain, guild: checkedGuild };
}
export function openGuildCipherBody(wire: GuildCipherMessage, text: string, proof: CipherScopeProof) {
  const body = JSON.parse(text);
  if (body?.domain !== domain || body.guild !== wire.guild || proof.body.source !== 'guild' || proof.body.scope !== wire.scope) throw new Error('guild_cipher_authenticated_context_mismatch');
  const { guild: _guild, ...rest } = body;
  // Reuse the strict payload/sender checks without accepting a DM wire as Guild.
  return openDmCipherBody({ ...wire, domain: 'sfera-dm-cipher-message-v1' },
    JSON.stringify({ ...rest, domain: 'sfera-dm-cipher-message-v1' }), proof);
}
export class GuildCipherMessages {
  private own: DmCipherMessage['sender'];
  private policy: AuthorizedCipher;
  constructor(policy: AuthorizedCipher, identity: CipherIdentity, user: string) {
    cipherUserId(identity); identifier(user);
    this.policy = policy; this.own = { user, owner: identity.owner, device: identity.device };
  }
  async seal(guild: string, scope: string, id: string, payload: DmCipherText) {
    identifier(guild); identifier(scope); identifier(id);
    const body = { domain, guild, scope, id, sender: { ...this.own }, payload: validateCipherText(payload) };
    // Validate all payload fields before SDK/key-sharing side effects.
    const text = JSON.stringify(body);
    if (new TextEncoder().encode(text).length > 32768) throw new Error('guild_cipher_payload_too_large');
    const draft = { domain, guild, scope, id, sender: body.sender };
    const { envelope, authorization } = await this.policy.encryptAuthorized('guild', scope, id, text);
    return { wire: parseGuildCipherMessage({ ...draft, envelope }, guild, scope), authorization };
  }
  async open(guild: string, scope: string, value: unknown) {
    const wire = parseGuildCipherMessage(value, guild, scope);
    const opened = await this.policy.decrypt('guild', scope, wire.sender, wire.envelope);
    if (opened.id !== wire.id) throw new Error('guild_cipher_authenticated_context_mismatch');
    return openGuildCipherBody(wire, opened.text, opened.authorization);
  }
}
