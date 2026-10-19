import { useSyncExternalStore } from 'react';
import type { ModuleContext, SferaModule } from '../../sdk/defineModule';
import { SDK_VERSION } from '../../sdk/defineModule';
import { registerSlot, unregisterModuleSlots } from '../../sdk/slots';
import { onWs } from '../../sdk/wsBus';
import { onLifecycle } from '../../sdk/lifecycle';
import { registerModuleStrings } from '../../i18n/moduleStrings';

// These services use the core's data-only runtime. Never import their old bundles.
const COMMERCIAL_IDS = new Set(['amocrm', 'bitrix', 'onec']);

export interface ModuleInfo {
  id: string;
  version: string;
  name: Record<string, string>;
  description: Record<string, string>;
  deps: string[];
  icon: string;
  provides: string[];
  installed: boolean;
  /** Module code is on this server and loaded by its backend. */
  deployed: boolean;
  /** Frontend bundle path relative to the server, e.g. `api/modules/diary/bundle.js?v=<ref>`. */
  bundle?: string | null;
  /** Version on the module's branch in the repository. */
  latestVersion?: string | null;
  updateAvailable?: boolean;
  /** Fetching or building from the repository, or waiting for the server to restart. */
  pending?: 'installing' | 'updating' | 'restarting' | null;
  /** Installed, but the server is not restarted automatically (SFERA_MODULES_RESTART=none). */
  manualRestart?: boolean;
  /** Published for a newer core than this server runs: cannot be installed here. */
  needsCoreSdk?: number | null;
  /** Frontend code is loaded and set up. */
  active: boolean;
  error?: string;
}

type State = {
  loaded: boolean;
  /** Installed modules finished their first activation (or failed). */
  ready: boolean;
  /** Current user is the instance superuser, the only one who installs modules. */
  canManage: boolean;
  /** The repository could not be reached; only modules already on the server are listed. */
  repoError?: string | null;
  modules: ModuleInfo[];
};
let state: State = { loaded: false, ready: false, canManage: false, modules: [] };
const listeners = new Set<() => void>();
const disposers = new Map<string, (() => void)[]>();
/** Bundle each active module was loaded from, to reload it after an update. */
const activeBundles = new Map<string, string>();
let conn: { serverIP: string; token: string } | null = null;
let publicServerIP: string | null = null;

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

/**
 * Module frontends are not part of the core build: the server takes a module from
 * its branch in the repository and builds a bundle of it (scripts/modules/build-module.mjs).
 * The bundle is imported from the server only once the module is installed.
 */
async function loadBundle(bundle: string): Promise<SferaModule> {
  const base = conn?.serverIP ?? publicServerIP ?? '';
  const url = new URL(`${base.replace(/\/$/, '')}/${bundle}`, window.location.href).href;
  const mod = await import(/* @vite-ignore */ url);
  return mod.default as SferaModule;
}

async function activate(id: string) {
  if (COMMERCIAL_IDS.has(id)) { deactivate(id); return; }
  const info = state.modules.find(m => m.id === id);
  if (disposers.has(id)) {
    if (!info?.bundle || activeBundles.get(id) === info.bundle) return;
    deactivate(id);  // updated: swap in the new build
  }
  if (!info?.bundle || !info.deployed) return;
  const bag: (() => void)[] = [];
  disposers.set(id, bag);
  activeBundles.set(id, info.bundle);
  try {
    const mod = await loadBundle(info.bundle);
    if (mod.sdkVersion > SDK_VERSION) throw new Error(`sdkVersion ${mod.sdkVersion} needs a newer core (${SDK_VERSION})`);
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
  activeBundles.delete(id);
  bag?.reverse().forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  unregisterModuleSlots(id);
  if (state.modules.some(m => m.id === id)) patch(id, { active: false });
}

async function activateInstalled(modules: ModuleInfo[]) {
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
    if (!modules.some(m => m.id === id && m.installed && m.deployed)) deactivate(id);
  }
}

async function refresh() {
  const data = await api('');
  const modules: ModuleInfo[] = (data.modules as Omit<ModuleInfo, 'active'>[]).map(m => ({
    ...m,
    active: disposers.has(m.id),
  }));
  set({ loaded: true, canManage: Boolean(data.can_manage), repoError: data.repo_error ?? null, modules });
  await activateInstalled(modules);
  return modules;
}

/** Called by ModuleHost on login / server change. */
export async function connectModules(serverIP: string, token: string) {
  conn = { serverIP, token };
  try {
    const modules = await refresh();
    if (modules.some(m => m.pending)) void waitForPending();
  } finally {
    set({ ready: true });
  }
}

/** Signed out: activate only installed modules that work on the sign-in screen. */
export async function connectPublicModules(serverIP: string) {
  publicServerIP = serverIP;
  try {
    const res = await fetch(`${serverIP}/api/modules/public/`);
    const data = res.ok ? await res.json() : { modules: [] };
    const modules: ModuleInfo[] = (data.modules ?? []).map((m: Omit<ModuleInfo, 'active'>) => ({
      ...m, installed: true, deployed: true, active: disposers.has(m.id),
    }));
    set({ modules });
    for (const m of modules) await activate(m.id);
    for (const id of [...disposers.keys()]) {
      if (!modules.some(m => m.id === id)) deactivate(id);
    }
  } catch (e) {
    console.error('[modules] public catalog failed', e);
  }
}

export function disconnectModules() {
  for (const id of [...disposers.keys()]) deactivate(id);
  conn = null;
  set({ loaded: false, ready: false, canManage: false, modules: [] });
}

let waiting: Promise<void> | null = null;

/**
 * Installing from the repository takes a while: the server fetches the branch,
 * builds the bundle, migrates and restarts to load the backend. Poll the catalog
 * (the server is briefly unreachable while it restarts) until nothing is pending.
 */
function waitForPending(timeoutMs = 10 * 60 * 1000): Promise<void> {
  if (waiting) return waiting;
  const until = Date.now() + timeoutMs;
  waiting = (async () => {
    while (conn && Date.now() < until) {
      await new Promise(r => setTimeout(r, 2500));
      try {
        const modules = await refresh();
        if (!modules.some(m => m.pending)) return;
      } catch { /* restarting */ }
    }
  })().finally(() => { waiting = null; });
  return waiting;
}

async function runJob(id: string, method: 'POST' | 'PUT', pending: 'installing' | 'updating') {
  patch(id, { pending, error: undefined });
  try {
    await api(`${id}/install/`, method);
  } catch (e) {
    patch(id, { pending: null });
    throw e;
  }
  await waitForPending();
  const m = state.modules.find(x => x.id === id);
  if (m?.error) throw Object.assign(new Error(m.error), { body: { error: m.error } });
}

/** Fetch the module (and its dependencies) from the repository and install it. */
export const installModule = (id: string) => runJob(id, 'POST', 'installing');

/** Move an installed module to the latest version of its branch. */
export const updateModule = (id: string) => runJob(id, 'PUT', 'updating');

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
