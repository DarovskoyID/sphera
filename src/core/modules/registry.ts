import { useSyncExternalStore } from 'react';
import type { ModuleContext, SferaModule } from '../../sdk/defineModule';
import { SDK_VERSION } from '../../sdk/defineModule';
import { registerSlot, unregisterModuleSlots } from '../../sdk/slots';
import { onWs } from '../../sdk/wsBus';
import { onLifecycle } from '../../sdk/lifecycle';
import { registerModuleStrings } from '../../i18n/moduleStrings';

export interface ModuleInfo {
  id: string;
  version: string;
  name: Record<string, string>;
  description: Record<string, string>;
  deps: string[];
  icon: string;
  provides: string[];
  installed: boolean;
  /** Frontend code is loaded and set up. */
  active: boolean;
  error?: string;
}

/**
 * Module frontends are bundled as lazy chunks: every `modules/<id>/` checked out
 * (from branch `module/<id>`) before `vite build` becomes a separate chunk that
 * is only fetched once the user installs the module.
 */
const bundled = import.meta.glob<{ default: SferaModule }>('../../../modules/*/frontend/index.tsx');

function loaderFor(id: string) {
  return bundled[`../../../modules/${id}/frontend/index.tsx`];
}

type State = {
  loaded: boolean;
  /** Installed modules finished their first activation (or failed). */
  ready: boolean;
  /** Current user is the instance superuser, the only one who installs modules. */
  canManage: boolean;
  modules: ModuleInfo[];
};
let state: State = { loaded: false, ready: false, canManage: false, modules: [] };
const listeners = new Set<() => void>();
const disposers = new Map<string, (() => void)[]>();
let conn: { serverIP: string; token: string } | null = null;

function set(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach(l => l());
}

function patch(id: string, p: Partial<ModuleInfo>) {
  set({ modules: state.modules.map(m => (m.id === id ? { ...m, ...p } : m)) });
}

async function api(path: string, method = 'GET') {
  if (!conn) throw new Error('not connected');
  const res = await fetch(`${conn.serverIP}/api/modules/${path}`, {
    method,
    headers: { Authorization: `Bearer ${conn.token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { body });
  return body;
}

async function activate(id: string) {
  if (disposers.has(id)) return;
  const load = loaderFor(id);
  if (!load) {
    patch(id, { active: false, error: 'frontend_missing' });
    return;
  }
  const bag: (() => void)[] = [];
  disposers.set(id, bag);
  try {
    const mod = (await load()).default;
    if (mod.sdkVersion !== SDK_VERSION) throw new Error(`sdkVersion ${mod.sdkVersion} != ${SDK_VERSION}`);
    const ctx: ModuleContext = {
      id,
      slot: (slot, item) => { bag.push(registerSlot(id, slot, item)); },
      onWs: (channel, type, handler) => { bag.push(onWs(channel, type, handler)); },
      onLifecycle: (event, fn) => { bag.push(onLifecycle(event, fn)); },
      strings: dicts => { bag.push(registerModuleStrings(id, dicts)); },
      onDispose: fn => { bag.push(fn); },
    };
    await mod.setup(ctx);
    patch(id, { active: true, error: undefined });
  } catch (e) {
    console.error(`[modules] failed to activate ${id}`, e);
    deactivate(id);
    patch(id, { active: false, error: String((e as Error).message || e) });
  }
}

function deactivate(id: string) {
  const bag = disposers.get(id);
  disposers.delete(id);
  bag?.reverse().forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  unregisterModuleSlots(id);
  if (state.modules.some(m => m.id === id)) patch(id, { active: false });
}

/** Called by ModuleHost on login / server change. */
export async function connectModules(serverIP: string, token: string) {
  conn = { serverIP, token };
  try {
    const data = await api('');
    const modules: ModuleInfo[] = (data.modules as Omit<ModuleInfo, 'active'>[]).map(m => ({
      ...m,
      active: disposers.has(m.id),
    }));
    set({ loaded: true, canManage: Boolean(data.can_manage), modules });
    // Activate dependencies first.
    const done = new Set<string>();
    const visit = async (m: ModuleInfo) => {
      if (done.has(m.id) || !m.installed) return;
      done.add(m.id);
      for (const d of m.deps) {
        const dep = modules.find(x => x.id === d);
        if (dep) await visit(dep);
      }
      await activate(m.id);
    };
    for (const m of modules) await visit(m);
    for (const id of [...disposers.keys()]) {
      if (!modules.some(m => m.id === id && m.installed)) deactivate(id);
    }
  } finally {
    set({ ready: true });
  }
}

export function disconnectModules() {
  for (const id of [...disposers.keys()]) deactivate(id);
  conn = null;
  set({ loaded: false, ready: false, canManage: false, modules: [] });
}

export async function installModule(id: string) {
  const res = await api(`${id}/install/`, 'POST');
  const ids: string[] = res.installed ?? [id];
  set({ modules: state.modules.map(m => (ids.includes(m.id) ? { ...m, installed: true } : m)) });
  // Dependencies were appended after the module itself; activate them first.
  for (const mid of [...ids].reverse()) await activate(mid);
}

export async function uninstallModule(id: string) {
  await api(`${id}/install/`, 'DELETE');
  deactivate(id);
  patch(id, { installed: false });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useModules(): State {
  return useSyncExternalStore(subscribe, () => state);
}

export function isModuleActive(id: string) {
  return disposers.has(id) && state.modules.some(m => m.id === id && m.active);
}
