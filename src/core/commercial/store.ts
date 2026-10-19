import { useSyncExternalStore } from 'react';
import { parseServiceCatalog, type CommercialService } from './schema';

type State = { services: CommercialService[]; status: string; server: string };
let state: State = { services: [], status: 'loading', server: '' };
const listeners = new Set<() => void>();
let connection: { server: string; token: string } | null = null;
let generation = 0;
let pending: AbortController | null = null;
const emit = (value: State) => { state = value; listeners.forEach(listener => listener()); };

export async function refreshCommercial(quiet = false) {
  if (!connection) return;
  const current = connection;
  const version = ++generation;
  pending?.abort();
  const controller = new AbortController(); pending = controller;
  const timeout = setTimeout(() => controller.abort(), 12000);
  if (!quiet) emit({ services: [], status: 'loading', server: current.server });
  try {
    const response = await fetch(`${current.server}/api/modules/commercial/`, { headers: { Authorization: `Bearer ${current.token}` }, signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'commercial_unavailable');
    const services = parseServiceCatalog(data);
    if (version === generation) emit({ services, status: 'ready', server: current.server });
  } catch (error) {
    if (version === generation) emit({ services: [], status: error instanceof Error && error.name !== 'AbortError' ? error.message : 'commercial_unavailable', server: current.server });
  } finally { clearTimeout(timeout); }
}

export function connectCommercial(server: string, token: string | null) {
  connection = token ? { server, token } : null;
  if (connection) void refreshCommercial();
  else { ++generation; pending?.abort(); emit({ services: [], status: 'loading', server }); }
  return () => { ++generation; pending?.abort(); connection = null; emit({ services: [], status: 'loading', server: '' }); };
}

export function useCommercial() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state);
}

export function workspaceWritable(moduleId: string, server?: string) {
  return (!server || state.server === server) && state.status === 'ready' && state.services.some(service => service.id === moduleId && service.available);
}

export function subscribeCommercial(listener: () => void) {
  listeners.add(listener); return () => { listeners.delete(listener); };
}

/** Keep local data accessible on an explicitly opened read-only route. */
export function workspaceEnabled(moduleId: string, server: string, route: string) {
  return workspaceWritable(moduleId, server) || route.startsWith(moduleId + ':');
}
