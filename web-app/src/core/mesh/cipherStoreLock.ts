/** Hold one persistent crypto machine per device across browser tabs/workers. */
export async function acquireCipherStoreLock(name: string): Promise<() => Promise<void>> {
  if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('cipher_store_lock_unavailable');
  let acquired!: (release: () => Promise<void>) => void;
  let failed!: (reason: unknown) => void;
  const ready = new Promise<() => Promise<void>>((resolve, reject) => { acquired = resolve; failed = reject; });
  let unlock!: () => void;
  const held = new Promise<void>(resolve => { unlock = resolve; });
  const running = navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw new Error('cipher_store_already_open');
    acquired(async () => { unlock(); await running; });
    await held;
  });
  void running.catch(failed);
  return ready;
}
