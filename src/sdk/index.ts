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
export type { RichMessageType, RichPayload, RichUserBrief, PollPayload } from '../types';
export { openModuleSocket } from './realtime';
export { tmStatic, goTo, setBusy, isBusy } from './runtime';
export type { ModuleSocket } from './realtime';
export { reportError } from '../context/AppContext';
// Feed / media building blocks.
export { EmojiPicker, CensoredPlainText } from '../components/EmojiPicker';
export { UnifiedPicker } from '../components/StickerGifPicker';
export { BlurredMedia } from '../components/BlurredMedia';
export { default as ConfirmModal } from '../components/ConfirmModal';
export { Skeleton, ListSkeleton, MediaSkeleton, FeedSkeleton, CardGridSkeleton } from '../components/Skeleton';
export { VoiceMessagePlayer, VideoCirclePlayer } from '../components/ChatMain';
export { getDraftText, setDraftText, getDraftFiles, setDraftFiles, clearDraft } from '../utils/drafts';
export { pickRecorderFormat, mediaUnsupportedReason, describeMediaError } from '../utils/recording';
export { useModuleStore, createModuleStore } from './store';
export type { ModuleStore } from './store';
export { navigate } from './navigation';
export type { WsChannel, WsFrame } from './wsBus';
export { useModules, installModule, uninstallModule, updateModule } from '../core/modules/registry';
export type { ModuleInfo } from '../core/modules/registry';

/** Core app state and actions (auth, user, DMs, navigation, toasts). */
export const useCore = useApp;

/** Translation hook for module-owned keys. */
export function useModuleT() {
  const { language } = useApp();
  return useCallback((key: string) => tm(language, key), [language]);
}
export { settingsUi } from './settingsUi';
export type { AccountType, ServerUser, CustomEmoji, ChatAttachment } from '../types';
// Low-level helpers for modules that own realtime state.
export { onWs, publishWs } from './wsBus';
export { onLifecycle } from './lifecycle';
export {
  wsUrlFor, getIceServers, getSelectedServerEntry, fetchPoolIceServers,
  loadServers, saveServers, loadSelectedServer, saveSelectedServer, pingServer, pingStun, getResolvedTurn, API_BASE_URL,
} from '../config/network';
export type { ServerEntry } from '../config/network';
export const wsProtocols = (token: string) => ['ionik.jwt', token];
export { readResponse } from '../utils/errorManager';
export { sortByDate, insertByDate } from '../utils/messageOrder';
export { showDesktopNotification, playMessageSound } from '../utils/notifications';
export { announce as announceA11y } from '../utils/accessibility';
export type { LocationPayload } from '../types';
// Shared app widgets used by module screens.
export { ProfileModal } from '../components/ProfileModal';
export type { ProfileUser } from '../components/ProfileModal';
export { UserProfile } from '../components/ChatSidebar';
export { useAnchoredMenu } from '../components/useAnchoredMenu';
export { LONG_PRESS_SAFE, useLongPress, useDragArm, useIsTouch } from '../components/useLongPress';
export { MessageListSkeleton } from '../components/Skeleton';
export { ComposerActions, RailSlot } from '../core/modules/Slots';
