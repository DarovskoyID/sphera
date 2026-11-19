/** Acknowledge only after the exact packet's Megolm receipt proves its key is
 * committed in the persistent SDK store. Rechecking the receipt after a crash
 * is repeatable; re-consuming the Olm packet is not required. */
import type { AuthorizedCipher } from './cipherPolicy';
import type { CipherRelayClient } from './cipherRelayClient';

async function receivePendingKeys(policy: AuthorizedCipher, relay: CipherRelayClient, scope: string, source: 'dm' | 'guild') {
  policy.assertPersistentKeyStore();
  const packets = await relay.pending();
  let received = 0;
  for (const packet of packets) {
    if (!packet.content.key_receipt) throw new Error('repeatable_group_key_receipt_required');
    policy.assertPersistentKeyStore();
    await policy.receiveKey(source, scope, packet.sender, packet.content);
    policy.assertPersistentKeyStore();
    await relay.acknowledge([packet.id]);
    received++;
  }
  return received;
}

export const receivePendingDmKeys = (policy: AuthorizedCipher, relay: CipherRelayClient, scope: string) => receivePendingKeys(policy, relay, scope, 'dm');
export const receivePendingGuildKeys = (policy: AuthorizedCipher, relay: CipherRelayClient, scope: string) => receivePendingKeys(policy, relay, scope, 'guild');
