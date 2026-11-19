import { createModuleStore, reportError } from '@sfera/sdk';
import { api, type Conn, type Status } from './api';

interface State {
  loaded: boolean;
  status: Status | null;
}

export const store = createModuleStore<State>({ loaded: false, status: null });

let conn: Conn | null = null;

export const need = () => {
  if (!conn) throw new Error('legal: not connected');
  return conn;
};

export function connect(next: Conn | null) {
  const changed = conn?.token !== next?.token || conn?.serverIP !== next?.serverIP;
  conn = next;
  if (!next) {
    store.reset();
    return;
  }
  if (changed) void refreshStatus();
}

export async function refreshStatus() {
  if (!conn) return;
  try {
    store.set({ loaded: true, status: await api.status(conn) });
  } catch (e) {
    store.set({ loaded: true });
    reportError(e);
  }
}
