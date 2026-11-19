/** Wire boundary for personal-chat text. All displayed metadata is authenticated
 * inside Megolm; transport fields alone must never establish sender identity. */
import { AuthorizedCipher } from './cipherPolicy';
import type { CipherScopeProof } from './cipherPolicy';
import { type CipherIdentity, type GroupEnvelope, cipherUserId } from './pairwiseCipher';

type Sender = { user: string; owner: string; device: string };
export type DmCipherMessage = {
  domain: 'sfera-dm-cipher-message-v1'; scope: string; id: string;
  sender: Sender; envelope: GroupEnvelope;
};
export type DmCipherText = { text: string; replyTo: string | null };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;
const domain = 'sfera-dm-cipher-message-v1';
function record(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) throw new Error('invalid_dm_cipher_schema');
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error('invalid_dm_cipher_id');
}
function sender(value: unknown): asserts value is Sender {
  record(value, ['user', 'owner', 'device']); identifier(value.user);
  if (![value.owner, value.device].every(key => typeof key === 'string' && hex.test(key))) throw new Error('invalid_dm_cipher_sender');
}
function payload(value: unknown): asserts value is DmCipherText {
  record(value, ['text', 'replyTo']);
  if (typeof value.text !== 'string' || !value.text.trim() || new TextEncoder().encode(value.text).length > 32768) throw new Error('invalid_dm_cipher_text');
  if (value.replyTo !== null) identifier(value.replyTo);
}
export function validateCipherText(value: unknown): DmCipherText {
  payload(value); return { text: value.text, replyTo: value.replyTo };
}
export function parseDmCipherMessage(value: unknown, scope: string): DmCipherMessage {
  identifier(scope);
  // Snapshot caller-owned objects before any asynchronous authorization step.
  const raw = JSON.stringify(value);
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 131072) throw new Error('invalid_dm_cipher_size');
  const copy = JSON.parse(raw);
  record(copy, ['domain', 'scope', 'id', 'sender', 'envelope']);
  if (copy.domain !== domain || copy.scope !== scope) throw new Error('dm_cipher_context_mismatch');
  identifier(copy.id); sender(copy.sender);
  record(copy.envelope, ['room', 'epoch', 'message_id', 'sender_device', 'content']);
  const envelope = copy.envelope;
  if (envelope.message_id !== copy.id || envelope.sender_device !== copy.sender.device ||
      typeof envelope.room !== 'string' || envelope.room.length > 256 ||
      !Number.isSafeInteger(envelope.epoch) || (envelope.epoch as number) < 1) throw new Error('dm_cipher_envelope_mismatch');
  record(envelope.content, ['algorithm', 'ciphertext', 'device_id', 'sender_key', 'session_id']);
  const content = envelope.content;
  if (content.algorithm !== 'm.megolm.v1.aes-sha2' ||
      !['ciphertext', 'device_id', 'sender_key', 'session_id'].every(key => typeof content[key] === 'string' && (content[key] as string).length > 0)) throw new Error('invalid_dm_cipher_content');
  return copy as unknown as DmCipherMessage;
}

export function openDmCipherBody(wire: DmCipherMessage, text: string, authorization: CipherScopeProof) {
  const body = JSON.parse(text);
  record(body, ['domain', 'scope', 'id', 'sender', 'payload']); sender(body.sender); payload(body.payload);
  const authenticatedSender = body.sender;
  const owner = authorization.body.owners.find(item => item.user === wire.sender.user);
  if (body.domain !== domain || body.scope !== wire.scope || body.id !== wire.id || !owner || owner.owner !== wire.sender.owner ||
      (['user', 'owner', 'device'] as const).some(key => authenticatedSender[key] !== wire.sender[key])) throw new Error('dm_cipher_authenticated_context_mismatch');
  return { ...body.payload, id: wire.id, sender: { ...wire.sender } };
}

export class DmCipherMessages {
  private readonly own: Sender;
  private readonly policy: AuthorizedCipher;
  constructor(policy: AuthorizedCipher, identity: CipherIdentity, user: string) {
    this.policy = policy;
    cipherUserId(identity); identifier(user);
    this.own = { user, owner: identity.owner, device: identity.device };
  }
  async seal(scope: string, id: string, value: DmCipherText): Promise<DmCipherMessage> {
    return (await this.sealAuthorized(scope, id, value)).wire;
  }
  async sealAuthorized(scope: string, id: string, value: DmCipherText) {
    identifier(scope); identifier(id); payload(value);
    const body = { domain, scope, id, sender: { ...this.own }, payload: { ...value } };
    const text = JSON.stringify(body);
    if (new TextEncoder().encode(text).length > 32768) throw new Error('dm_cipher_payload_too_large');
    const { envelope, authorization } = await this.policy.encryptAuthorized('dm', scope, id, text);
    return { wire: parseDmCipherMessage({ domain, scope, id, sender: body.sender, envelope }, scope), authorization };
  }
  async open(scope: string, value: unknown): Promise<DmCipherText & { id: string; sender: Sender }> {
    const wire = parseDmCipherMessage(value, scope);
    const decrypted = await this.policy.decrypt('dm', scope, wire.sender, wire.envelope);
    if (decrypted.id !== wire.id) throw new Error('dm_cipher_authenticated_context_mismatch');
    return openDmCipherBody(wire, decrypted.text, decrypted.authorization);
  }
}
