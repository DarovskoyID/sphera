import type { SlotMap, SlotName } from './slots';
import type { WsChannel, WsFrame } from './wsBus';
import type { LifecycleEvent } from './lifecycle';

/** Bumped on breaking SDK changes; must match `sdkVersion` in module.json. */
export const SDK_VERSION = 1;

export interface ModuleContext {
  id: string;
  /** Fill a UI slot. Everything registered is removed automatically on uninstall. */
  slot<K extends SlotName>(slot: K, item: SlotMap[K]): void;
  /** Subscribe to WebSocket frames of the core sockets. */
  onWs(channel: WsChannel, type: string, handler: (frame: WsFrame) => void): void;
  onLifecycle(event: LifecycleEvent, fn: () => void | Promise<void>): void;
  /** Per-language dictionaries, looked up with `tm(lang, key)` / `useModuleT()`. */
  strings(dicts: Partial<Record<string, Record<string, string>>>): void;
  /** Arbitrary cleanup to run on uninstall. */
  onDispose(fn: () => void): void;
}

export interface SferaModule {
  id: string;
  sdkVersion: number;
  setup(ctx: ModuleContext): void | Promise<void>;
}

export function defineModule(mod: Omit<SferaModule, 'sdkVersion'> & { sdkVersion?: number }): SferaModule {
  return { sdkVersion: SDK_VERSION, ...mod };
}
