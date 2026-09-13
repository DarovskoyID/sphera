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
// Message building blocks shared by core chats and modules.
export { MessageText } from '../components/EmojiPicker';
export { CensorOff } from '../components/CensorScope';
export { RichMessage } from '../components/RichMessage';
export { RichComposer } from '../components/RichComposer';
export { MessageEditModal } from '../components/MessageEditModal';
export { HideSelectionButton } from '../components/HideSelectionButton';
export { createTailCache } from '../utils/cachedTail';
export type { TailEntry } from '../utils/cachedTail';
export type { RichMessageType, RichPayload } from '../types';
export { useModuleStore, createModuleStore } from './store';
export type { ModuleStore } from './store';
export { navigate } from './navigation';
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
