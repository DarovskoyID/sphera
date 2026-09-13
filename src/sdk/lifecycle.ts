export type LifecycleEvent = 'login' | 'logout' | 'callStart' | 'deafen' | 'undeafen' | 'mute' | 'unmute';
type Fn = () => void | Promise<void>;

const hooks = new Map<LifecycleEvent, Set<Fn>>();

export function onLifecycle(event: LifecycleEvent, fn: Fn): () => void {
  let set = hooks.get(event);
  if (!set) hooks.set(event, (set = new Set()));
  set.add(fn);
  return () => { set!.delete(fn); };
}

export async function runLifecycle(event: LifecycleEvent) {
  for (const fn of hooks.get(event) ?? []) {
    try { await fn(); } catch (e) { console.error(`[lifecycle] ${event} hook failed`, e); }
  }
}
