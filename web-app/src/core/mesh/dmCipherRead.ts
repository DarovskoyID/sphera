/** A signed device assertion, not evidence that a human read the screen. */
import { accountBytes, accountDigest } from './account';
import { verifyCipherScope, type CipherScopeProof } from './cipherPolicy';
import type { DmCipherMessage } from './dmCipherMessage';
import type { TrustedEntryPoint } from './entryPoint';
export async function verifyDmReadReceipt(value: unknown, wire: DmCipherMessage, proof: CipherScopeProof, pin: TrustedEntryPoint) {
  const receipt = JSON.parse(JSON.stringify(value));
  const exact = (object: unknown, fields: string[]) => {
    if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).sort().join(',') !== fields.sort().join(',')) throw new Error('invalid_cipher_read_receipt');
  };
  exact(receipt, ['body', 'signature']);
  if (accountBytes(receipt).length > 4096) throw new Error('invalid_cipher_read_receipt');
  const body = receipt.body;
  exact(body, ['domain', 'network', 'genesis', 'entry', 'user', 'owner', 'device', 'scope', 'message_id', 'cipher_digest', 'nonce', 'issued_at', 'expires_at']);
  const sender = proof.body.certificates.find(item => item.body.owner === wire.sender.owner && item.body.device === wire.sender.device)?.body;
  if (!sender) throw new Error('cipher_read_sender_unknown');
  const verified = await verifyCipherScope(proof, pin, sender, wire.sender.user, 'dm', wire.scope, proof.body.nonce, proof.body.issued_at);
  const certificate = verified.body.certificates.find(item => item.body.owner === body.owner && item.body.device === body.device)?.body;
  if (!certificate || !verified.body.owners.some(item => item.user === body.user && item.owner === body.owner) ||
      body.user === wire.sender.user || body.domain !== 'sfera-dm-cipher-read-v1' || body.network !== pin.network ||
      body.genesis !== proof.body.genesis || body.entry !== pin.nodeId || body.scope !== wire.scope || body.message_id !== wire.id ||
      body.cipher_digest !== await accountDigest(accountBytes(wire)) || !/^[0-9a-f]{64}$/.test(body.nonce) ||
      !Number.isSafeInteger(body.issued_at) || body.issued_at < 0 || body.issued_at > Math.floor(Date.now() / 1000) + 5 ||
      body.expires_at !== body.issued_at + 60 || typeof receipt.signature !== 'string' || !/^[0-9a-f]{128}$/.test(receipt.signature)) throw new Error('cipher_read_context_mismatch');
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(certificate.device_public.match(/../g)!, value => parseInt(value, 16)), 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, Uint8Array.from(receipt.signature.match(/../g)!, (value: string) => parseInt(value, 16)), new Uint8Array(accountBytes(body)))) throw new Error('cipher_read_signature_mismatch');
  return { user: body.user as string, device: body.device as string, issuedAt: body.issued_at as number };
}
