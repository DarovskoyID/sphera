/** Correlate an acknowledgement only with this user's matching send intent. */
export function findOptimisticChatMessage<T extends { id: string; author: { id: string }; content: string; publication_state?: string }>(
  messages: readonly T[], incoming: T, nonce: unknown, selfId: string,
): number {
  if (String(incoming.author.id) !== String(selfId)) return -1;
  if (typeof nonce === 'string' && nonce.length > 0) {
    return messages.findIndex(message => message.id === `optimistic-${nonce}`);
  }
  // Confirmed mesh messages without our nonce may originate on another device
  // or in the scheduler. They must not consume another outstanding send.
  if (incoming.publication_state === 'confirmed') return -1;
  return messages.findIndex(message => String(message.id).startsWith('optimistic-') && message.content === incoming.content);
}
