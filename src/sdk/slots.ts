import { useSyncExternalStore, type ComponentType, type ReactNode } from 'react';

/**
 * UI extension points. The core renders a slot; modules fill it.
 * A slot with no registrations renders nothing (e.g. no search bar in
 * «Исследовать сферу» until servers/channels is installed).
 */
export interface SlotMap {
  /** Button in the left rail (ServerSidebar). */
  'nav.rail': { id: string; order?: number; render: ComponentType };
  /** Full-screen view selected by `currentServer === view` or a `match()` predicate. */
  'main.view': { id: string; match: (route: MainRoute) => boolean; render: ComponentType<{ style?: React.CSSProperties }> };
  /** Settings page + its menu entry. */
  'settings.page': { id: string; label: string | (() => string); icon?: ReactNode; render: ComponentType };
  /** Item in the rail "+" menu; 
ender is the dialog it opens. */
  'rail.addAction': { id: string; order?: number; label: () => string; icon?: ReactNode; render: ComponentType<{ onClose: () => void }> };
  /** Card in «Исследовать сферу». */
  'explore.card': { id: string; order?: number; render: ComponentType };
  /** Search provider in «Исследовать сферу». */
  'explore.search': ExploreSearchProvider;
  /** Button next to a message composer (DM or guild/channel). */
  'chat.composerAction': { id: string; render: ComponentType<ComposerActionProps> };
  /** Badge rendered next to a user name. */
  'user.badge': { id: string; render: ComponentType<{ userId: string; accountType?: string }> };
  /** Extra section in the profile modal. */
  'profile.section': { id: string; render: ComponentType<{ userId: string; profile: Record<string, unknown> }> };
  /** Extra rows above the user panel in the DM sidebar (e.g. voice connection). */
  'sidebar.userPanel': { id: string; render: ComponentType };
  /** Scrollable part of the left rail (e.g. server icons with folders). */
  'nav.railScroll': { id: string; render: ComponentType };
  /** Sticker sources for the sticker/GIF picker. */
  'picker.stickers': { id: string; load: () => Promise<PickerSticker[]> };
  /** Always-mounted overlay (toasts, voice banner, …). */
  'app.overlay': { id: string; render: ComponentType };
  /** Under the sign-in form (modules with `preAuth` in module.json). */
  'auth.footer': { id: string; order?: number; render: ComponentType };
  /** React provider wrapping the whole app (module state). */
  'app.provider': { id: string; render: ComponentType<{ children: ReactNode }> };
}

export interface PickerSticker {
  id: string;
  name: string;
  description: string;
  image: string;
}

export interface ComposerActionProps {
  kind: 'dm' | 'channel';
  /** Peer user id for a DM, channel id otherwise. */
  targetId: string;
  token: string;
  serverIP: string;
  /** Insert text into the composer. */
  onPick: (text: string) => void;
}

export interface MainRoute {
  currentServer: string;
  currentView: string;
}

export interface ExploreSearchResult {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  avatar?: string | null;
  badge?: string;
  open: () => void;
}

export interface ExploreSearchProvider {
  id: string;
  label: string | (() => string);
  order?: number;
  search: (query: string, signal: AbortSignal) => Promise<ExploreSearchResult[]>;
}

export type SlotName = keyof SlotMap;
export type SlotEntry<K extends SlotName> = SlotMap[K] & { moduleId: string };
type Entry<K extends SlotName> = SlotEntry<K>;

const entries = new Map<SlotName, Entry<SlotName>[]>();
const listeners = new Set<() => void>();
let version = 0;
const snapshots = new Map<SlotName, { v: number; list: Entry<SlotName>[] }>();

function emit() {
  version++;
  listeners.forEach(l => l());
}

export function registerSlot<K extends SlotName>(moduleId: string, slot: K, item: SlotMap[K]): () => void {
  const list = (entries.get(slot) ?? []).filter(e => !(e.moduleId === moduleId && e.id === item.id));
  const entry = { ...item, moduleId } as Entry<SlotName>;
  list.push(entry);
  list.sort((a, b) => ((a as { order?: number }).order ?? 0) - ((b as { order?: number }).order ?? 0));
  entries.set(slot, list);
  emit();
  return () => {
    entries.set(slot, (entries.get(slot) ?? []).filter(e => e !== entry));
    emit();
  };
}

export function unregisterModuleSlots(moduleId: string) {
  let changed = false;
  for (const [slot, list] of entries) {
    const next = list.filter(e => e.moduleId !== moduleId);
    if (next.length !== list.length) {
      entries.set(slot, next);
      changed = true;
    }
  }
  if (changed) emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function getSlot<K extends SlotName>(slot: K): Entry<K>[] {
  const cached = snapshots.get(slot);
  if (cached && cached.v === version) return cached.list as unknown as Entry<K>[];
  const list = [...(entries.get(slot) ?? [])];
  snapshots.set(slot, { v: version, list });
  return list as unknown as Entry<K>[];
}

export function useSlot<K extends SlotName>(slot: K): Entry<K>[] {
  return useSyncExternalStore(subscribe, () => getSlot(slot));
}
