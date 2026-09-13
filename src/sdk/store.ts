import { useSyncExternalStore } from 'react';

/**
 * Minimal external store for module state. Module state must not live in the
 * core AppContext, and a store (unlike a provider) survives remounts.
 */
export interface ModuleStore<S> {
  get(): S;
  set(patch: Partial<S> | ((prev: S) => Partial<S>)): void;
  reset(): void;
  subscribe(listener: () => void): () => void;
}

export function createModuleStore<S extends object>(initial: S): ModuleStore<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      listeners.forEach(l => l());
    },
    reset() {
      state = initial;
      listeners.forEach(l => l());
    },
    subscribe(l) {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
  };
}

export function useModuleStore<S extends object, T>(store: ModuleStore<S>, select: (s: S) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}
