import { createModuleStore } from '@sfera/sdk';
import { api, type Conn, type Status } from './api';

export const store = createModuleStore<{ status: Status | null }>({ status: null });

let conn: Conn | null = null;

export function connect(next: Conn | null) {
  const changed = conn?.token !== next?.token || conn?.serverIP !== next?.serverIP;
  conn = next;
  if (!next) { store.reset(); return; }
  if (changed) void refreshStatus();
}

export async function refreshStatus() {
  if (!conn) return;
  try {
    store.set({ status: await api.status(conn) });
  } catch {
    store.set({ status: null });
  }
}
