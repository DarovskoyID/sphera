import { createModuleStore, reportError } from '@sfera/sdk';
import { api, type Conn } from './api';
import type { DocBrief } from './types';

export const store = createModuleStore<{ loaded: boolean; docs: DocBrief[] }>({ loaded: false, docs: [] });

let conn: Conn | null = null;

export const need = () => {
  if (!conn) throw new Error('office: not connected');
  return conn;
};

export function connect(next: Conn | null) {
  const changed = conn?.token !== next?.token || conn?.serverIP !== next?.serverIP;
  conn = next;
  if (!next) { store.reset(); return; }
  if (changed) void refresh();
}

export async function refresh() {
  if (!conn) return;
  try {
    store.set({ loaded: true, docs: await api.docs(conn) });
  } catch (e) {
    store.set({ loaded: true });
    reportError(e);
  }
}

export function forget(id: string) {
  store.set(s => ({ docs: s.docs.filter(d => d.id !== id) }));
}
