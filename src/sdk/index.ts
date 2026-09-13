/**
 * Public Module SDK (`@sfera/sdk`). Modules import only from here; anything
 * else in `src/` is core-private and may change without notice.
 */
import { useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { tm } from '../i18n';

export { defineModule, SDK_VERSION } from './defineModule';
export type { ModuleContext, SferaModule } from './defineModule';
export { useSlot, getSlot } from './slots';
export type { SlotMap, SlotName, MainRoute, ComposerActionProps, ExploreSearchProvider, ExploreSearchResult } from './slots';
export { ToolCard } from './ui';
export { BotBadge, AccountBadge, isBot, accountDisplayName } from '../components/BotBadge';
export { useTranslation as useT } from '../i18n/useTranslation';
export type { WsChannel, WsFrame } from './wsBus';
export { useModules, installModule, uninstallModule } from '../core/modules/registry';
export type { ModuleInfo } from '../core/modules/registry';

/** Core app state and actions (auth, user, DMs, navigation, toasts). */
export const useCore = useApp;

/** Translation hook for module-owned keys. */
export function useModuleT() {
  const { language } = useApp();
  return useCallback((key: string) => tm(language, key), [language]);
}
