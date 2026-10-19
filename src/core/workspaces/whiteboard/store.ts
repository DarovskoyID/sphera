import { createModuleStore, reportError } from '@sfera/sdk';
import { api, type Conn } from './api';
import type { BoardBrief } from './types';

export const store = createModuleStore<{ loaded: boolean; boards: BoardBrief[] }>({ loaded: false, boards: [] });

let conn: Conn | null = null;

export function connect(next: Conn | null) {
  const changed = conn?.token !== next?.token || conn?.serverIP !== next?.serverIP;
  conn = next;
  if (!next) { store.reset(); return; }
  if (changed) void refresh();
}

export async function refresh() {
  if (!conn) return;
  try {
    store.set({ loaded: true, boards: await api.boards(conn) });
  } catch (e) {
    store.set({ loaded: true });
    reportError(e);
  }
}
