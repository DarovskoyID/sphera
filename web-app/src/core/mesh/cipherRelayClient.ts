/** Scoped relay channel. The caller supplies an authenticated request function
 * bound to its selected server and a guard that invalidates logout/server changes.
 * A channel must not be switched while a queued SDK operation is in progress. */
import { verifyCipherScope, type CipherScopeBody } from './cipherPolicy';
import { entryProbeNonce, type TrustedEntryPoint } from './entryPoint';
import type { CipherPeer, CipherRelay, PairwiseEnvelope } from './pairwiseCipher';

export type CipherKeyPacket = { id: string; sender: { owner: string; device: string }; content: PairwiseEnvelope };
type Options = {
  pin: TrustedEntryPoint; user: string; scope: string; source?: 'dm' | 'guild';
  identity: () => CipherPeer;
  post: (path: string, body: unknown) => Promise<unknown>;
  review: (body: CipherScopeBody) => Promise<boolean>;
  guard: () => void;
};
function object(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) throw new Error('invalid_cipher_relay_response');
}
export class CipherRelayClient {
  private readonly options: Options;
  constructor(options: Options) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.scope)) throw new Error('invalid_cipher_relay_scope');
    if (options.source !== undefined && !['dm', 'guild'].includes(options.source)) throw new Error('invalid_cipher_relay_source');
    this.options = { ...options, pin: { ...options.pin } };
  }
  private async execute(request: { id: string; type: number; body: string }) {
    const frozen = { ...request }, options = this.options;
    options.guard();
    const nonce = entryProbeNonce();
    const source = options.source ?? 'dm';
    const scope = { source, scope: options.scope, nonce };
    const proof = await options.post('/api/auth/mesh/cipher/scope/', scope);
    options.guard();
    const checked = await verifyCipherScope(proof, options.pin, options.identity(), options.user, source, options.scope, nonce);
    if (typeof options.review !== 'function' || !await options.review(JSON.parse(JSON.stringify(checked.body)))) throw new Error('cipher_roster_approval_required');
    options.guard();
    if (checked.body.expires_at <= Math.floor(Date.now() / 1000)) throw new Error('cipher_scope_expired');
    const result = await options.post('/api/auth/mesh/cipher/relay/', { source, scope: options.scope,
      roster: checked.body.roster, epoch: checked.body.epoch, request: frozen });
    options.guard();
    if (checked.body.expires_at <= Math.floor(Date.now() / 1000)) throw new Error('cipher_scope_expired');
    const text = JSON.stringify(result);
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > 1048576) throw new Error('invalid_cipher_relay_response');
    return JSON.parse(text) as unknown;
  }
  readonly relay: CipherRelay = async request => {
    if (![0, 1, 2, 3].includes(request.type)) throw new Error('unsupported_pairwise_relay_operation');
    return JSON.stringify(await this.execute(request));
  };
  async pending(): Promise<CipherKeyPacket[]> {
    const result = await this.execute({ id: entryProbeNonce(), type: 4, body: '{}' });
    object(result, ['messages']);
    if (!Array.isArray(result.messages) || result.messages.length > 16) throw new Error('invalid_cipher_relay_response');
    const ids = new Set<string>();
    return result.messages.map(value => {
      object(value, ['id', 'sender', 'content']); object(value.sender, ['owner', 'device']);
      if (typeof value.id !== 'string' || !/^[0-9a-f]{64}$/.test(value.id) || ids.has(value.id) ||
          ![value.sender.owner, value.sender.device].every(part => typeof part === 'string' && /^[0-9a-f]{64}$/.test(part))) throw new Error('invalid_cipher_relay_packet');
      ids.add(value.id);
      if (!value.content || typeof value.content !== 'object' || Array.isArray(value.content)) throw new Error('invalid_cipher_relay_packet');
      const content = value.content as Record<string, unknown>;
      const fields = ['algorithm', 'sender_key', 'ciphertext'];
      if ('key_receipt' in content) {
        fields.push('key_receipt');
        object(content.key_receipt, ['room', 'epoch', 'message_id', 'sender_device', 'content']);
        const receipt = content.key_receipt;
        if (typeof receipt.room !== 'string' || !/^![0-9a-f]{64}:[0-9a-f]{64}\.sphere$/.test(receipt.room) ||
            !Number.isSafeInteger(receipt.epoch) || (receipt.epoch as number) < 1 || receipt.sender_device !== value.sender.device ||
            typeof receipt.message_id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(receipt.message_id)) throw new Error('invalid_cipher_relay_packet');
        object(receipt.content, ['algorithm', 'ciphertext', 'device_id', 'sender_key', 'session_id']);
        if (receipt.content.algorithm !== 'm.megolm.v1.aes-sha2' || receipt.content.sender_key !== content.sender_key ||
            receipt.content.device_id !== value.sender.device || typeof receipt.content.session_id !== 'string' ||
            !/^[A-Za-z0-9+/]{43}$/.test(receipt.content.session_id) || typeof receipt.content.ciphertext !== 'string' ||
            !/^[A-Za-z0-9+/]{1,8192}$/.test(receipt.content.ciphertext)) throw new Error('invalid_cipher_relay_packet');
      }
      if ('org.matrix.msgid' in content) {
        fields.push('org.matrix.msgid');
        if (typeof content['org.matrix.msgid'] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(content['org.matrix.msgid'])) throw new Error('invalid_cipher_relay_packet');
      }
      object(content, fields);
      if (content.algorithm !== 'm.olm.v1.curve25519-aes-sha2' || typeof content.sender_key !== 'string' ||
          !/^[A-Za-z0-9+/]{43}$/.test(content.sender_key) || !content.ciphertext || typeof content.ciphertext !== 'object' ||
          Array.isArray(content.ciphertext)) throw new Error('invalid_cipher_relay_packet');
      return value as unknown as CipherKeyPacket;
    });
  }
  /** Call only after repeatable proof of the key in the persistent SDK store.
   * This adapter deliberately never acknowledges on mere receipt/decryption. */
  async acknowledge(ids: string[]) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 16 || new Set(ids).size !== ids.length ||
        ids.some(id => typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id))) throw new Error('invalid_cipher_relay_ack');
    const result = await this.execute({ id: entryProbeNonce(), type: 5, body: JSON.stringify({ ids: [...ids] }) });
    object(result, []);
  }
}
