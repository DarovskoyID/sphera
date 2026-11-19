/** A durable intent exists; callers must retry its UUID instead of composing again. */
export class DmCipherQueuedError extends Error {
  readonly messageId: string;
  constructor(id: string, cause: unknown) { super('dm_cipher_intent_saved', { cause }); this.messageId = id; }
}
