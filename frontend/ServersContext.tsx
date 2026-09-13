/**
 * Servers module state: guilds, channels, messages, voice.
 *
 * Moved out of the core AppContext. The code below still reads `state.*` and
 * calls `setState(prev => …)` as before; `state` is core + module state merged,
 * and `setState` routes each key back to its owner (module keys here, core
 * navigation keys through core.patchState).
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  onLifecycle, setBusy, announceA11y, insertByDate, onWs, playMessageSound, readResponse, reportError, showDesktopNotification, sortByDate,
  useCore, wsProtocols, wsUrlFor, type LocationPayload, type PollPayload,
} from '@sfera/sdk';
import type {
  Guild, GuildAuditLogEntry, GuildChannel, GuildEmoji, GuildInviteData, GuildMessage, GuildRole, GuildSound,
  GuildSticker, LayoutEntry, VoiceParticipant,
} from './types';

type MobilePanel = 'chat-list' | 'chat-view' | 'guild-channels' | 'guild-chat' | 'guild-members';
type RichScope = { kind: 'dm'; conversationId: string } | { kind: 'guild'; guildId: string; channelId: string };

interface GuildState {
  guilds: Guild[];
  serverLayout: LayoutEntry[];
  currentGuild: Guild | null;
  currentGuildChannel: GuildChannel | null;
  guildMessages: GuildMessage[];
  /** A channel is being opened: its history has not arrived yet. */
  guildMessagesLoading: boolean;
  currentVoiceChannel: GuildChannel | null;
  voiceParticipants: VoiceParticipant[];
  voiceChannelParticipants: Record<string, VoiceParticipant[]>;
}

const GUILD_KEYS: (keyof GuildState)[] = [
  'guilds', 'serverLayout', 'currentGuild', 'currentGuildChannel', 'guildMessages', 'guildMessagesLoading',
  'currentVoiceChannel', 'voiceParticipants', 'voiceChannelParticipants',
];

const INITIAL: GuildState = {
  guilds: [], serverLayout: [], currentGuild: null, currentGuildChannel: null, guildMessages: [],
  guildMessagesLoading: false, currentVoiceChannel: null, voiceParticipants: [], voiceChannelParticipants: {},
};

type CoreValue = ReturnType<typeof useCore>;
type Merged = CoreValue & GuildState;

export interface ServersContextValue extends GuildState {
  guildKickNotification: { title: string; message: string } | null;
  clearGuildKickNotification: () => void;
  loadGuilds: () => Promise<void>;
  updateGuild: (guildId: string, data: { name?: string; description?: string; tag?: string; tags?: string; icon?: File | null; banner?: File | null; removeIcon?: boolean; removeBanner?: boolean; boost_level?: number; verification_level?: string; default_notifications?: string; explicit_content_filter?: string; require_2fa?: boolean; is_discoverable?: boolean; comments_enabled?: boolean }) => Promise<void>;
  loadGuildEmojis: (guildId: string) => Promise<GuildEmoji[]>;
  uploadGuildEmoji: (guildId: string, name: string, file: File) => Promise<GuildEmoji | null>;
  deleteGuildEmoji: (guildId: string, emojiId: string) => Promise<void>;
  loadGuildStickers: (guildId: string) => Promise<GuildSticker[]>;
  uploadGuildSticker: (guildId: string, name: string, description: string, file: File) => Promise<GuildSticker | null>;
  deleteGuildSticker: (guildId: string, stickerId: string) => Promise<void>;
  loadGuildSounds: (guildId: string) => Promise<GuildSound[]>;
  uploadGuildSound: (guildId: string, name: string, file: File) => Promise<GuildSound | null>;
  deleteGuildSound: (guildId: string, soundId: string) => Promise<void>;
  loadGuildRoles: (guildId: string) => Promise<GuildRole[]>;
  createGuildRole: (guildId: string, data: { name: string; color: string; permissions: string[] }) => Promise<GuildRole | null>;
  updateGuildRole: (guildId: string, roleId: string, data: Partial<{ name: string; color: string; permissions: string[]; position: number }>) => Promise<GuildRole | null>;
  deleteGuildRole: (guildId: string, roleId: string) => Promise<void>;
  assignMemberRole: (guildId: string, userId: string, roleId: string) => Promise<void>;
  removeMemberRole: (guildId: string, userId: string, roleId: string) => Promise<void>;
  loadGuildInvites: (guildId: string) => Promise<GuildInviteData[]>;
  createGuildInvite: (guildId: string, data: { max_uses?: number; expires_hours?: number }) => Promise<GuildInviteData | null>;
  revokeGuildInvite: (guildId: string, inviteId: string) => Promise<void>;
  loadGuildAuditLog: (guildId: string) => Promise<GuildAuditLogEntry[]>;
  createGuild: (name: string, description?: string) => Promise<Guild | null>;
  saveLayout: (layout: import('./types').LayoutEntry[]) => void;
  toggleReaction: (guildId: string, messageId: string, emoji: string) => Promise<void>;
  votePoll: (guildId: string, messageId: string, optionIds: string[]) => Promise<void>;
  closePoll: (guildId: string, messageId: string) => Promise<void>;
  fetchPollVoters: (guildId: string, messageId: string, optionId: string, offset?: number, limit?: number) => Promise<{ voters: import('./types').RichUserBrief[]; total: number }>;
  registerMessageView: (guildId: string, messageId: string) => Promise<void>;
  loadPostComments: (guildId: string, messageId: string) => Promise<import('./types').PostComment[]>;
  addPostComment: (guildId: string, messageId: string, content: string) => Promise<import('./types').PostComment | null>;
  deletePostComment: (guildId: string, commentId: string) => Promise<void>;
  joinGuild: (inviteCode: string) => Promise<Guild | null>;
  previewGuild: (guildId: string) => Promise<boolean>;
  leaveGuild: (guildId: string) => Promise<void>;
  deleteGuild: (guildId: string, password?: string) => Promise<boolean>;
  kickMember: (guildId: string, userId: string) => Promise<void>;
  setMemberRole: (guildId: string, userId: string, role: 'admin' | 'member') => Promise<void>;
  createChannel: (guildId: string, name: string, type?: 'text' | 'voice', categoryId?: string) => Promise<void>;
  deleteChannel: (guildId: string, channelId: string) => Promise<void>;
  updateChannel: (guildId: string, channelId: string, data: { user_limit?: number; name?: string }) => Promise<void>;
  createCategory: (guildId: string, name: string) => Promise<void>;
  deleteCategory: (guildId: string, categoryId: string) => Promise<void>;
  toggleGuildNotifications: (guildId: string) => Promise<void>;
  selectGuild: (guild: Guild) => void;
  selectGuildChannel: (channel: GuildChannel) => void;
  sendGuildMessage: (text: string, replyToId?: string, attachmentIds?: string[], attachments?: GuildMessage['attachments']) => void;
  addOptimisticGuildPost: (text: string, fileCount: number) => string;
  removeOptimisticGuildPost: (id: string) => void;
  resolveGuildPost: (optimisticId: string, realMsgs: GuildMessage[]) => void;
  scheduleGuildMessage: (text: string, delaySecs: number, replyToId?: string, attachmentIds?: string[]) => Promise<{ id: string; send_at: string } | null>;
  loadOlderGuildMessages: () => Promise<boolean>;
  deleteGuildMessage: (messageId: string) => Promise<void>;
  pinGuildMessage: (messageId: string) => Promise<void>;
  guildChannelWs: React.MutableRefObject<WebSocket | null>;
  joinVoiceChannel: (channel: GuildChannel) => void;
  leaveVoiceChannel: () => void;
  setVoiceMuted: (muted: boolean) => void;
  sendVoiceSignal: (toUserId: string, payload: unknown) => void;
  voiceWs: React.MutableRefObject<WebSocket | null>;
  voiceSignalHandler: React.MutableRefObject<((data: unknown) => void) | null>;
  voiceLocalStream: React.MutableRefObject<MediaStream | null>;
  postCommentHandler: React.MutableRefObject<((ev: { type: 'added' | 'deleted'; messageId: string; comment?: import('./types').PostComment; commentId?: string }) => void) | null>;
}

const ServersContext = createContext<ServersContextValue | null>(null);

/** Stickers of the open server, for the core sticker picker (picker.stickers slot). */
let stickerLoader: (() => Promise<GuildSticker[]>) | null = null;
export const currentGuildStickers = () => (stickerLoader ? stickerLoader() : Promise.resolve([]));

export function useServers(): ServersContextValue {
  const v = useContext(ServersContext);
  if (!v) throw new Error('useServers outside ServersProvider');
  return v;
}

/** Core + servers, shaped like the old AppContext for the moved components. */
export function useApp() {
  const core = useCore();
  const servers = useServers();
  return { ...core, ...servers };
}

export function ServersProvider({ children }: { children: ReactNode }) {
  const core = useCore();
  const [gs, setGs] = useState<GuildState>(INITIAL);
  const coreRef = useRef(core);
  coreRef.current = core;
  const gsRef = useRef(gs);
  gsRef.current = gs;

  const state: Merged = { ...core, ...gs };

  /** Old-style updater over merged state; splits the result back to its owners. */
  const setState = useCallback((updater: (prev: Merged) => Merged) => {
    const prev = { ...coreRef.current, ...gsRef.current } as Merged;
    const next = updater(prev);
    if (next === prev) return;
    const guildPatch: Partial<GuildState> = {};
    const corePatch: Record<string, unknown> = {};
    for (const key of Object.keys(next) as (keyof Merged)[]) {
      if (next[key] === prev[key]) continue;
      if ((GUILD_KEYS as string[]).includes(key as string)) (guildPatch as Record<string, unknown>)[key as string] = next[key];
      else if (typeof next[key] !== 'function') corePatch[key as string] = next[key];
    }
    if (Object.keys(guildPatch).length) {
      gsRef.current = { ...gsRef.current, ...guildPatch };
      setGs(gsRef.current);
    }
    if (Object.keys(corePatch).length) coreRef.current.patchState(corePatch);
  }, []);

  const logout = core.logout;
  const handleAuthError = useCallback((status: number) => { if (status === 401) logout(); }, [logout]);
  const richHeaders = useCallback(() => ({
    Authorization: `Bearer ${coreRef.current.authToken}`,
    'Content-Type': 'application/json',
  }), []);
  // Tapping "back" to the channel list must not bounce straight into the channel.
  const lastGuildChatBackRef = useRef<{ channelId: string | null; at: number }>({ channelId: null, at: 0 });
  useEffect(() => {
    if (core.mobileActivePanel === 'guild-channels') {
      lastGuildChatBackRef.current = { channelId: gsRef.current.currentGuildChannel?.id ?? null, at: Date.now() };
    }
  }, [core.mobileActivePanel]);
  const apiGet = useCallback(async (path: string, token: string, serverIP: string) => {
    const res = await fetch(`${serverIP}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return readResponse(res, { serverIP, onUnauthorized: logout });
  }, [logout]);
  const apiPost = useCallback(async (path: string, token: string, serverIP: string, body: unknown) => {
    const res = await fetch(`${serverIP}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return readResponse(res, { serverIP, onUnauthorized: logout });
  }, [logout]);
  const selfRef = useRef({ id: '', username: '', nickname: '' });
  selfRef.current = {
    id: String(core.currentUser?.id ?? core.userIDonServer ?? ''),
    username: core.currentUser?.username ?? '',
    nickname: core.currentUser?.nickname ?? '',
  };

  const [guildKickNotification, setGuildKickNotification] = useState<{ title: string; message: string } | null>(null);
  const clearGuildKickNotification = useCallback(() => setGuildKickNotification(null), []);
  // Real-time post-comment events are dispatched here for the open comments modal.
  const postCommentHandler = useRef<((ev: { type: 'added' | 'deleted'; messageId: string; comment?: import('./types').PostComment; commentId?: string }) => void) | null>(null);
  // ==================== Guild WebSocket ====================
  const guildChannelWs = useRef<WebSocket | null>(null);
  const guildPresenceWs = useRef<WebSocket | null>(null);

  // Which channel connection is current. A reconnect timer from a channel the
  // reader has already left must not reopen it, so every attempt carries the
  // generation it was scheduled under and gives up if that has moved on.
  const guildWsGen = useRef(0);
  const guildWsRetry = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Close the channel socket for good.
   *
   * Bumping the generation is the point: a plain `close()` still fires
   * `onclose`, which would schedule a reconnect — and on sign-out that means
   * reopening a socket with a token that is no longer valid.
   */
  const closeGuildWs = useCallback(() => {
    guildWsGen.current++;
    if (guildWsRetry.current) { clearTimeout(guildWsRetry.current); guildWsRetry.current = null; }
    guildChannelWs.current?.close();
    guildChannelWs.current = null;
  }, []);

  const _connectGuildWs = useCallback((
    guild: Guild, channel: GuildChannel, token: string, serverIP: string,
    // Carried across attempts so a server that stays down is not hammered at
    // one-second intervals; a successful open resets it.
    retryDelay = 1000,
  ) => {
    if (guildChannelWs.current) {
      guildChannelWs.current.close();
      guildChannelWs.current = null;
    }
    if (guildWsRetry.current) { clearTimeout(guildWsRetry.current); guildWsRetry.current = null; }
    const gen = ++guildWsGen.current;
    let backoff = retryDelay;

    const wsUrl = wsUrlFor(serverIP);
    const ws = new WebSocket(`${wsUrl}/ws/guild/${guild.id}/channel/${channel.id}/`, wsProtocols(token));
    let opened = false;
    ws.onopen = () => {
      guildChannelWs.current = ws;
      backoff = 1000;
      // Everything posted while the socket was down was missed entirely — the
      // channel has no polling fallback — so the history is re-read and merged
      // on every reopen after the first.
      if (opened) {
        apiGet(`/api/guilds/${guild.id}/channels/${channel.id}/messages/`, token, serverIP)
          .then((msgs: GuildMessage[]) => setState(prev => {
            if (guildWsGen.current !== gen) return prev;
            const ids = new Set(msgs.map(m => m.id));
            const extra = prev.guildMessages.filter(m => !ids.has(m.id));
            return { ...prev, guildMessages: sortByDate([...msgs, ...extra]) };
          }))
          .catch(() => { /* the next reopen will try again */ });
      }
      opened = true;
    };
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'message_deleted') {
        setState(prev => ({ ...prev, guildMessages: prev.guildMessages.filter(m => m.id !== data.id) }));
      } else if (data.type === 'message_pinned') {
        setState(prev => ({ ...prev, guildMessages: prev.guildMessages.map(m => m.id === data.id ? { ...m, is_pinned: data.is_pinned } : m) }));
      } else if (data.type === 'reaction_update') {
        setState(prev => ({ ...prev, guildMessages: prev.guildMessages.map(m => m.id === data.message_id ? { ...m, reactions: data.reactions } : m) }));
      } else if (data.type === 'poll_update') {
        setState(prev => ({
          ...prev,
          guildMessages: prev.guildMessages.map(m => {
            if (String(m.id) !== String(data.message_id)) return m;
            // The broadcast deliberately carries no personal flags (see
            // rich.poll_view) — keep this client's own selection.
            const mine = m.payload as PollPayload | undefined;
            const next = data.poll as PollPayload;
            const byId = new Map((mine?.options ?? []).map(o => [o.id, o.me]));
            return {
              ...m,
              payload: {
                ...next,
                options: next.options.map(o => ({ ...o, me: byId.get(o.id) ?? false })),
                voted: mine?.voted ?? false,
              },
            };
          }),
        }));
      } else if (data.type === 'todo_update') {
        setState(prev => ({ ...prev, guildMessages: prev.guildMessages.map(m => String(m.id) === String(data.message_id) ? { ...m, payload: data.todo } : m) }));
      } else if (data.type === 'message_edited') {
        const upd = data.message || {};
        setState(prev => ({
          ...prev,
          guildMessages: prev.guildMessages.map(m =>
            String(m.id) === String(upd.id)
              ? {
                  ...m,
                  content: upd.content ?? m.content,
                  edited: true,
                  ...(upd.message_type ? { message_type: upd.message_type } : {}),
                  ...(upd.payload !== undefined ? { payload: upd.payload } : {}),
                }
              : m
          ),
        }));
      } else if (data.type === 'location_update') {
        setState(prev => ({ ...prev, guildMessages: prev.guildMessages.map(m => String(m.id) === String(data.message_id) ? { ...m, payload: data.location } : m) }));
      } else if (data.type === 'comment_added') {
        setState(prev => ({ ...prev, guildMessages: prev.guildMessages.map(m => String(m.id) === String(data.message_id) ? { ...m, comments_count: (m.comments_count ?? 0) + 1 } : m) }));
        postCommentHandler.current?.({ type: 'added', messageId: String(data.message_id), comment: data.comment });
      } else if (data.type === 'comment_deleted') {
        setState(prev => ({ ...prev, guildMessages: prev.guildMessages.map(m => String(m.id) === String(data.message_id) ? { ...m, comments_count: Math.max(0, (m.comments_count ?? 1) - 1) } : m) }));
        postCommentHandler.current?.({ type: 'deleted', messageId: String(data.message_id), commentId: String(data.comment_id) });
      } else if (data.type === 'guild_deleted') {
        setState(prev => ({
          ...prev,
          guilds: prev.guilds.filter(g => g.id !== data.guild_id),
          currentGuild: prev.currentGuild?.id === data.guild_id ? null : prev.currentGuild,
          currentGuildChannel: prev.currentGuild?.id === data.guild_id ? null : prev.currentGuildChannel,
          guildMessages: prev.currentGuild?.id === data.guild_id ? [] : prev.guildMessages,
          currentView: prev.currentGuild?.id === data.guild_id ? 'home' : prev.currentView,
          currentServer: prev.currentGuild?.id === data.guild_id ? 'home' : prev.currentServer,
        }));
      } else if (data.type === 'member_joined') {
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          const already = prev.currentGuild.members.some(m => m.id === data.member.id);
          if (already) return prev;
          return { ...prev, currentGuild: { ...prev.currentGuild, members: [...prev.currentGuild.members, data.member] } };
        });
      } else if (data.type === 'member_left') {
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          return { ...prev, currentGuild: { ...prev.currentGuild, members: prev.currentGuild.members.filter(m => m.id !== data.user_id) } };
        });
      } else if (data.type === 'member_kicked') {
        setState(prev => {
          const isSelf = String(data.user_id) === String(prev.userIDonServer);
          if (isSelf) {
            setGuildKickNotification({ title: 'guild_kicked_title', message: data.guild_name || guild.name });
            const isCurrentGuild = prev.currentGuild?.id === guild.id;
            return {
              ...prev,
              guilds: prev.guilds.filter(g => g.id !== guild.id),
              currentGuild: isCurrentGuild ? null : prev.currentGuild,
              currentGuildChannel: isCurrentGuild ? null : prev.currentGuildChannel,
              guildMessages: isCurrentGuild ? [] : prev.guildMessages,
              currentView: isCurrentGuild ? 'home' as const : prev.currentView,
              currentServer: isCurrentGuild ? 'home' : prev.currentServer,
            };
          }
          // Someone else was kicked — remove from member list if this is the current guild
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          return { ...prev, currentGuild: { ...prev.currentGuild, members: prev.currentGuild.members.filter(m => m.id !== data.user_id) } };
        });
      } else if (data.type === 'channel_created') {
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          const already = prev.currentGuild.channels.some(c => c.id === data.channel.id);
          if (already) return prev;
          return { ...prev, currentGuild: { ...prev.currentGuild, channels: [...prev.currentGuild.channels, data.channel] } };
        });
      } else if (data.type === 'channel_deleted') {
        if (voiceWs.current && state.currentVoiceChannel?.id === data.channel_id) {
          voiceWs.current.close();
          voiceWs.current = null;
        }
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          return {
            ...prev,
            currentGuild: { ...prev.currentGuild, channels: prev.currentGuild.channels.filter(c => c.id !== data.channel_id) },
            currentGuildChannel: prev.currentGuildChannel?.id === data.channel_id ? null : prev.currentGuildChannel,
            currentVoiceChannel: prev.currentVoiceChannel?.id === data.channel_id ? null : prev.currentVoiceChannel,
            voiceParticipants: prev.currentVoiceChannel?.id === data.channel_id ? [] : prev.voiceParticipants,
            guildMessages: prev.currentGuildChannel?.id === data.channel_id ? [] : prev.guildMessages,
          };
        });
      } else if (data.type === 'channel_updated') {
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          return { ...prev, currentGuild: { ...prev.currentGuild, channels: prev.currentGuild.channels.map(c => c.id === data.channel.id ? data.channel : c) } };
        });
      } else if (data.type === 'category_created') {
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          if (prev.currentGuild.categories.some(c => c.id === data.category.id)) return prev;
          return { ...prev, currentGuild: { ...prev.currentGuild, categories: [...prev.currentGuild.categories, data.category] } };
        });
      } else if (data.type === 'category_deleted') {
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          return { ...prev, currentGuild: { ...prev.currentGuild, categories: prev.currentGuild.categories.filter(c => c.id !== data.category_id), channels: prev.currentGuild.channels.map(ch => ch.category_id === data.category_id ? { ...ch, category_id: null } : ch) } };
        });
      } else if (data.type === 'member_muted') {
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          const isSelf = String(data.user_id) === String(prev.userIDonServer);
          return {
            ...prev,
            currentGuild: {
              ...prev.currentGuild,
              ...(isSelf ? { my_muted_until: data.muted_until } : {}),
              members: prev.currentGuild.members.map(m =>
                String(m.id) === String(data.user_id) ? { ...m, muted_until: data.muted_until } : m
              ),
            },
          };
        });
      } else if (data.type === 'member_roles_changed') {
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          return {
            ...prev,
            currentGuild: {
              ...prev.currentGuild,
              members: prev.currentGuild.members.map(m =>
                String(m.id) === String(data.user_id) ? { ...m, custom_roles: data.custom_roles } : m
              ),
            },
          };
        });
      } else if (data.type === 'member_role_changed') {
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          const isSelf = String(data.user_id) === String(prev.userIDonServer);
          return {
            ...prev,
            currentGuild: {
              ...prev.currentGuild,
              // Unlock/lock the admin UI for the affected member right away.
              ...(isSelf ? { my_role: data.role } : {}),
              members: prev.currentGuild.members.map(m =>
                String(m.id) === String(data.user_id) ? { ...m, role: data.role } : m
              ),
            },
          };
        });
      } else if (data.type === 'voice_presence_update') {
        setState(prev => ({
          ...prev,
          voiceChannelParticipants: {
            ...prev.voiceChannelParticipants,
            [data.channel_id]: data.participants,
          },
        }));
      } else {
        // Regular chat message — replace matching optimistic or append (skip exact duplicate).
        // Anything that isn't shaped like a message is dropped: letting a stray
        // frame through puts an author-less object in the list and the renderer
        // dies on msg.author.id, taking the whole chat down.
        if (!data || typeof data !== 'object' || !data.id || !data.author) return;
        const msg: GuildMessage = data;
        // Desktop notification / sound for server messages and mentions.
        const self = selfRef.current;
        const authorId = String(msg.author?.id ?? '');
        if (authorId && authorId !== self.id) {
          const text = msg.content || '';
          const mentioned = !!(
            (self.username && text.includes(`@${self.username}`)) ||
            (self.nickname && text.includes(`@${self.nickname}`)) ||
            text.includes('@everyone') || text.includes('@here')
          );
          const author = msg.author?.nickname || msg.author?.username || '';
          if (mentioned) {
            showDesktopNotification('mention', `${author} mentioned you`, text);
            playMessageSound();
            announceA11y(`${author} mentioned you: ${text}`);
          } else {
            showDesktopNotification('server', author, text);
          }
        }
        setState(prev => {
          if (prev.guildMessages.some(m => m.id === msg.id)) return prev;
          // The realtime broadcast only carries the author id (no name/avatar),
          // which would render as "?". Fill it in from ourselves or the member
          // list so the first message you send shows the right nickname.
          if (msg.author && !msg.author.username && !msg.author.nickname) {
            const aid = String(msg.author.id);
            const self = selfRef.current;
            if (self && String(self.id) === aid) {
              msg.author = { ...msg.author, username: self.username, nickname: self.nickname, avatar: prev.currentUser?.avatar || msg.author.avatar };
            } else {
              const mem = prev.currentGuild?.members?.find(m => String(m.id) === aid);
              if (mem) msg.author = { ...msg.author, username: mem.username, nickname: mem.nickname, avatar: mem.avatar, status: mem.status };
            }
          }
          // Realtime broadcasts carry only reply_to_id (the full reply_to object
          // is filled in by the REST reload). Resolve the preview from messages
          // we already have so the reply shows up without a refresh.
          if (!msg.reply_to) {
            const rid = (data as { reply_to_id?: string }).reply_to_id;
            if (rid) {
              const target = prev.guildMessages.find(m => String(m.id) === String(rid));
              if (target) {
                msg.reply_to = {
                  id: String(target.id),
                  content: target.content,
                  author: { id: String(target.author.id), username: target.author.username, nickname: target.author.nickname },
                };
              }
            }
          }
          let optIdx = prev.guildMessages.findIndex(
            m => String(m.id).startsWith('optimistic-') &&
              String(m.author.id) === String(msg.author?.id) &&
              m.content === msg.content
          );
          if (optIdx === -1) {
            optIdx = prev.guildMessages.findIndex(
              m => String(m.id).startsWith('optimistic-') &&
                String(m.author.id) === String(msg.author?.id)
            );
          }
          let msgs: GuildMessage[];
          if (optIdx !== -1) {
            // Keep the reply preview we resolved optimistically if the echo lacks it.
            if (!msg.reply_to && prev.guildMessages[optIdx].reply_to) {
              msg.reply_to = prev.guildMessages[optIdx].reply_to;
            }
            // Keep the optimistic author (full name/avatar) if the echo lacks it.
            if (!msg.author?.username && !msg.author?.nickname && prev.guildMessages[optIdx].author?.username) {
              msg.author = prev.guildMessages[optIdx].author;
            }
            // Keep optimistic attachments (with media URLs) if the echo lacks them.
            if (!msg.attachments?.length && prev.guildMessages[optIdx].attachments?.length) {
              msg.attachments = prev.guildMessages[optIdx].attachments;
            }
            msgs = [...prev.guildMessages];
            msgs[optIdx] = msg;
          } else {
            msgs = insertByDate(prev.guildMessages, msg);
          }
          if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
          return { ...prev, guildMessages: msgs };
        });
      }
    };
    ws.onclose = () => {
      if (guildChannelWs.current === ws) guildChannelWs.current = null;
      // Only reconnect while this is still the channel on screen. Without this
      // the diary and every guild channel simply stopped updating after the
      // first dropped connection — backgrounding a phone was enough — and only
      // a reload brought them back.
      if (guildWsGen.current !== gen) return;
      const next = Math.min(backoff * 2, 15000);
      guildWsRetry.current = setTimeout(() => {
        if (guildWsGen.current !== gen) return;
        _connectGuildWs(guild, channel, token, serverIP, next);
      }, backoff);
    };
  }, []);

  const _connectGuildPresenceWs = useCallback((guild: Guild, token: string, serverIP: string) => {
    if (guildPresenceWs.current) { guildPresenceWs.current.close(); guildPresenceWs.current = null; }
    const wsUrl = wsUrlFor(serverIP);
    const ws = new WebSocket(`${wsUrl}/ws/guild/${guild.id}/`, wsProtocols(token));
    ws.onopen = () => { guildPresenceWs.current = ws; };
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'guild_deleted') {
        setState(prev => ({
          ...prev,
          guilds: prev.guilds.filter(g => g.id !== data.guild_id),
          currentGuild: prev.currentGuild?.id === data.guild_id ? null : prev.currentGuild,
          currentGuildChannel: prev.currentGuild?.id === data.guild_id ? null : prev.currentGuildChannel,
          guildMessages: prev.currentGuild?.id === data.guild_id ? [] : prev.guildMessages,
          currentView: prev.currentGuild?.id === data.guild_id ? 'home' : prev.currentView,
          currentServer: prev.currentGuild?.id === data.guild_id ? 'home' : prev.currentServer,
        }));
      } else if (data.type === 'member_joined') {
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          const already = prev.currentGuild.members.some(m => m.id === data.member.id);
          if (already) return prev;
          return { ...prev, currentGuild: { ...prev.currentGuild, members: [...prev.currentGuild.members, data.member] } };
        });
      } else if (data.type === 'member_left') {
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          return { ...prev, currentGuild: { ...prev.currentGuild, members: prev.currentGuild.members.filter(m => m.id !== data.user_id) } };
        });
      } else if (data.type === 'member_kicked') {
        setState(prev => {
          const isSelf = String(data.user_id) === String(prev.userIDonServer);
          if (isSelf) {
            setGuildKickNotification({ title: 'guild_kicked_title', message: data.guild_name || guild.name });
            const isCurrentGuild = prev.currentGuild?.id === guild.id;
            return {
              ...prev,
              guilds: prev.guilds.filter(g => g.id !== guild.id),
              currentGuild: isCurrentGuild ? null : prev.currentGuild,
              currentGuildChannel: isCurrentGuild ? null : prev.currentGuildChannel,
              guildMessages: isCurrentGuild ? [] : prev.guildMessages,
              currentView: isCurrentGuild ? 'home' as const : prev.currentView,
              currentServer: isCurrentGuild ? 'home' : prev.currentServer,
            };
          }
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          return { ...prev, currentGuild: { ...prev.currentGuild, members: prev.currentGuild.members.filter(m => m.id !== data.user_id) } };
        });
      } else if (data.type === 'channel_created') {
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          const already = prev.currentGuild.channels.some(c => c.id === data.channel.id);
          if (already) return prev;
          return { ...prev, currentGuild: { ...prev.currentGuild, channels: [...prev.currentGuild.channels, data.channel] } };
        });
      } else if (data.type === 'channel_deleted') {
        if (voiceWs.current && state.currentVoiceChannel?.id === data.channel_id) {
          voiceWs.current.close();
          voiceWs.current = null;
        }
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          return {
            ...prev,
            currentGuild: { ...prev.currentGuild, channels: prev.currentGuild.channels.filter(c => c.id !== data.channel_id) },
            currentGuildChannel: prev.currentGuildChannel?.id === data.channel_id ? null : prev.currentGuildChannel,
            currentVoiceChannel: prev.currentVoiceChannel?.id === data.channel_id ? null : prev.currentVoiceChannel,
            voiceParticipants: prev.currentVoiceChannel?.id === data.channel_id ? [] : prev.voiceParticipants,
            guildMessages: prev.currentGuildChannel?.id === data.channel_id ? [] : prev.guildMessages,
          };
        });
      } else if (data.type === 'channel_updated') {
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          return { ...prev, currentGuild: { ...prev.currentGuild, channels: prev.currentGuild.channels.map(c => c.id === data.channel.id ? data.channel : c) } };
        });
      } else if (data.type === 'category_created') {
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          if (prev.currentGuild.categories.some(c => c.id === data.category.id)) return prev;
          return { ...prev, currentGuild: { ...prev.currentGuild, categories: [...prev.currentGuild.categories, data.category] } };
        });
      } else if (data.type === 'category_deleted') {
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          return { ...prev, currentGuild: { ...prev.currentGuild, categories: prev.currentGuild.categories.filter(c => c.id !== data.category_id), channels: prev.currentGuild.channels.map(ch => ch.category_id === data.category_id ? { ...ch, category_id: null } : ch) } };
        });
      } else if (data.type === 'member_muted') {
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          const isSelf = String(data.user_id) === String(prev.userIDonServer);
          return {
            ...prev,
            currentGuild: {
              ...prev.currentGuild,
              ...(isSelf ? { my_muted_until: data.muted_until } : {}),
              members: prev.currentGuild.members.map(m =>
                String(m.id) === String(data.user_id) ? { ...m, muted_until: data.muted_until } : m
              ),
            },
          };
        });
      } else if (data.type === 'member_roles_changed') {
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          return {
            ...prev,
            currentGuild: {
              ...prev.currentGuild,
              members: prev.currentGuild.members.map(m =>
                String(m.id) === String(data.user_id) ? { ...m, custom_roles: data.custom_roles } : m
              ),
            },
          };
        });
      } else if (data.type === 'member_role_changed') {
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          const isSelf = String(data.user_id) === String(prev.userIDonServer);
          return {
            ...prev,
            currentGuild: {
              ...prev.currentGuild,
              // Unlock/lock the admin UI for the affected member right away.
              ...(isSelf ? { my_role: data.role } : {}),
              members: prev.currentGuild.members.map(m =>
                String(m.id) === String(data.user_id) ? { ...m, role: data.role } : m
              ),
            },
          };
        });
      } else if (data.type === 'voice_presence_update') {
        setState(prev => ({
          ...prev,
          voiceChannelParticipants: { ...prev.voiceChannelParticipants, [data.channel_id]: data.participants },
        }));
      }
    };
    ws.onclose = () => { if (guildPresenceWs.current === ws) guildPresenceWs.current = null; };
  }, []);

  // Coming back to the app is the common case, not a network outage: a phone
  // that has been in a pocket has had its socket closed for minutes, and
  // waiting out the backoff before reconnecting would leave the channel stale
  // for exactly as long as the reader is looking at it.
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      const guild = state.currentGuild;
      const channel = state.currentGuildChannel;
      if (!guild || !channel || !state.authToken) return;
      if (guildChannelWs.current?.readyState === WebSocket.OPEN) return;
      _connectGuildWs(guild, channel, state.authToken, state.currentServerIP);
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, [state.currentGuild, state.currentGuildChannel, state.authToken, state.currentServerIP, _connectGuildWs]);

  // ==================== Guild methods ====================
  const loadGuilds = useCallback(async () => {
    try {
      const guilds: Guild[] = await apiGet('/api/guilds/', state.authToken, state.currentServerIP);
      setState(prev => ({ ...prev, guilds }));
    } catch (e) { reportError(e); }
  }, [state.authToken, state.currentServerIP, apiGet]);

  const createGuild = useCallback(async (name: string, description = ''): Promise<Guild | null> => {
    try {
      const guild: Guild = await apiPost('/api/guilds/', state.authToken, state.currentServerIP, { name, description });
      setState(prev => ({ ...prev, guilds: [...prev.guilds, guild] }));
      return guild;
    } catch (e) { reportError(e); return null; }
  }, [state.authToken, state.currentServerIP, apiPost]);


  // ── Server-bar layout (ordering + folders), synced per user ────────────────
  const layoutSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistLayout = useCallback((layout: import('./types').LayoutEntry[]) => {
    if (layoutSaveTimer.current) clearTimeout(layoutSaveTimer.current);
    const token = state.authToken, ip = state.currentServerIP;
    layoutSaveTimer.current = setTimeout(() => {
      fetch(`${ip}/api/server-layout/`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout }),
      }).catch(() => { /* best-effort; local state already updated */ });
    }, 500);
  }, [state.authToken, state.currentServerIP]);

  const saveLayout = useCallback((layout: import('./types').LayoutEntry[]) => {
    setState(prev => ({ ...prev, serverLayout: layout }));
    persistLayout(layout);
  }, [persistLayout]);

  const toggleReaction = useCallback(async (guildId: string, messageId: string, emoji: string): Promise<void> => {
    try {
      const res = await fetch(`${state.currentServerIP}/api/guilds/${guildId}/messages/${messageId}/reactions/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji }),
      });
      if (res.ok) {
        const data = await res.json();
        setState(prev => ({
          ...prev,
          guildMessages: prev.guildMessages.map(m => m.id === messageId ? { ...m, reactions: data.reactions } : m),
        }));
      }
      // 409 (reaction limit) is silently ignored — the add button is already hidden
      // once the user has 3 reactions, so this only guards a desynced UI.
    } catch (e) { reportError(e); }
  }, [state.authToken, state.currentServerIP]);


  const votePoll = useCallback(async (
    guildId: string, messageId: string, optionIds: string[],
  ): Promise<void> => {
    try {
      const res = await fetch(`${state.currentServerIP}/api/guilds/${guildId}/messages/${messageId}/poll/vote/`, {
        method: 'POST', headers: richHeaders(), body: JSON.stringify({ option_ids: optionIds }),
      });
      if (!res.ok) return;
      const data = await res.json();
      // This response is authoritative for us: it carries our own me/voted.
      setState(prev => ({
        ...prev,
        guildMessages: prev.guildMessages.map(m =>
          String(m.id) === String(messageId) ? { ...m, payload: data.poll as PollPayload } : m
        ),
      }));
    } catch (e) { reportError(e); }
  }, [richHeaders, state.currentServerIP]);

  const fetchPollVoters = useCallback(async (
    guildId: string, messageId: string, optionId: string, offset = 0, limit = 50,
  ): Promise<{ voters: import('./types').RichUserBrief[]; total: number }> => {
    const res = await fetch(
      `${state.currentServerIP}/api/guilds/${guildId}/messages/${messageId}/poll/voters/`
      + `?option=${encodeURIComponent(optionId)}&offset=${offset}&limit=${limit}`,
      { headers: { Authorization: `Bearer ${state.authToken}` } },
    );
    if (!res.ok) return { voters: [], total: 0 };
    return res.json();
  }, [state.authToken, state.currentServerIP]);

  const closePoll = useCallback(async (guildId: string, messageId: string): Promise<void> => {
    try {
      const res = await fetch(`${state.currentServerIP}/api/guilds/${guildId}/messages/${messageId}/poll/close/`, {
        method: 'POST', headers: richHeaders(),
      });
      if (!res.ok) return;
      const data = await res.json();
      setState(prev => ({
        ...prev,
        guildMessages: prev.guildMessages.map(m =>
          String(m.id) === String(messageId) ? { ...m, payload: data.poll as PollPayload } : m
        ),
      }));
    } catch (e) { reportError(e); }
  }, [richHeaders, state.currentServerIP]);


  const registerMessageView = useCallback(async (guildId: string, messageId: string): Promise<void> => {
    try {
      const res = await fetch(`${state.currentServerIP}/api/guilds/${guildId}/messages/${messageId}/view/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setState(prev => ({
          ...prev,
          guildMessages: prev.guildMessages.map(m => m.id === messageId ? { ...m, views: data.views } : m),
        }));
      }
    } catch { /* ignore */ }
  }, [state.authToken, state.currentServerIP]);

  const loadPostComments = useCallback(async (guildId: string, messageId: string): Promise<import('./types').PostComment[]> => {
    try {
      return await apiGet(`/api/guilds/${guildId}/messages/${messageId}/comments/`, state.authToken, state.currentServerIP);
    } catch { return []; }
  }, [state.authToken, state.currentServerIP, apiGet]);

  const addPostComment = useCallback(async (guildId: string, messageId: string, content: string): Promise<import('./types').PostComment | null> => {
    try {
      const res = await fetch(`${state.currentServerIP}/api/guilds/${guildId}/messages/${messageId}/comments/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) return null;
      const comment = await res.json();
      // Count/thread updates arrive via the WS 'comment_added' broadcast (which
      // this sender also receives), so we don't bump comments_count here to avoid
      // double-counting.
      return comment;
    } catch (e) { reportError(e); return null; }
  }, [state.authToken, state.currentServerIP]);

  const deletePostComment = useCallback(async (guildId: string, commentId: string): Promise<void> => {
    try {
      await fetch(`${state.currentServerIP}/api/guilds/${guildId}/comments/${commentId}/`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${state.authToken}` },
      });
    } catch (e) { reportError(e); }
  }, [state.authToken, state.currentServerIP]);

  const joinGuild = useCallback(async (inviteCode: string): Promise<Guild | null> => {
    try {
      const guild: Guild = await apiPost('/api/guilds/join/', state.authToken, state.currentServerIP, { invite_code: inviteCode });
      setState(prev => {
        const already = prev.guilds.some(g => g.id === guild.id);
        return { ...prev, guilds: already ? prev.guilds.map(g => g.id === guild.id ? guild : g) : [...prev.guilds, guild] };
      });
      return guild;
    } catch (e) { reportError(e); return null; }
  }, [state.authToken, state.currentServerIP, apiPost]);

  const leaveGuild = useCallback(async (guildId: string) => {
    await fetch(`${state.currentServerIP}/api/guilds/${guildId}/leave/`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${state.authToken}` },
    });
    setState(prev => ({
      ...prev,
      guilds: prev.guilds.filter(g => g.id !== guildId),
      currentGuild: prev.currentGuild?.id === guildId ? null : prev.currentGuild,
      currentGuildChannel: prev.currentGuild?.id === guildId ? null : prev.currentGuildChannel,
      guildMessages: prev.currentGuild?.id === guildId ? [] : prev.guildMessages,
      currentView: prev.currentGuild?.id === guildId ? 'home' : prev.currentView,
      currentServer: prev.currentGuild?.id === guildId ? 'home' : prev.currentServer,
    }));
    closeGuildWs();
    if (guildPresenceWs.current) { guildPresenceWs.current.close(); guildPresenceWs.current = null; }
  }, [state.authToken, state.currentServerIP]);

  const deleteGuild = useCallback(async (guildId: string, password?: string): Promise<boolean> => {
    const res = await fetch(`${state.currentServerIP}/api/guilds/${guildId}/`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${state.authToken}`, 'Content-Type': 'application/json' },
      body: password !== undefined ? JSON.stringify({ password }) : undefined,
    });
    if (!res.ok) return false;
    setState(prev => ({
      ...prev,
      guilds: prev.guilds.filter(g => g.id !== guildId),
      currentGuild: prev.currentGuild?.id === guildId ? null : prev.currentGuild,
      currentGuildChannel: prev.currentGuild?.id === guildId ? null : prev.currentGuildChannel,
      guildMessages: prev.currentGuild?.id === guildId ? [] : prev.guildMessages,
      currentView: prev.currentGuild?.id === guildId ? 'home' : prev.currentView,
      currentServer: prev.currentGuild?.id === guildId ? 'home' : prev.currentServer,
    }));
    closeGuildWs();
    if (guildPresenceWs.current) { guildPresenceWs.current.close(); guildPresenceWs.current = null; }
    return true;
  }, [state.authToken, state.currentServerIP]);

  const updateGuild = useCallback(async (guildId: string, data: { name?: string; description?: string; tag?: string; tags?: string; icon?: File | null; banner?: File | null; removeIcon?: boolean; removeBanner?: boolean; boost_level?: number; verification_level?: string; default_notifications?: string; explicit_content_filter?: string; require_2fa?: boolean; is_discoverable?: boolean; comments_enabled?: boolean }) => {
    const form = new FormData();
    if (data.name !== undefined) form.append('name', data.name);
    if (data.description !== undefined) form.append('description', data.description);
    if (data.tag !== undefined) form.append('tag', data.tag);
    if (data.icon) form.append('icon', data.icon);
    if (data.banner) form.append('banner', data.banner);
    if (data.removeIcon) form.append('remove_icon', 'true');
    if (data.removeBanner) form.append('remove_banner', 'true');
    if (data.boost_level !== undefined) form.append('boost_level', String(data.boost_level));
    if (data.verification_level !== undefined) form.append('verification_level', data.verification_level);
    if (data.default_notifications !== undefined) form.append('default_notifications', data.default_notifications);
    if (data.explicit_content_filter !== undefined) form.append('explicit_content_filter', data.explicit_content_filter);
    if (data.require_2fa !== undefined) form.append('require_2fa', data.require_2fa ? 'true' : 'false');
    if (data.is_discoverable !== undefined) form.append('is_discoverable', data.is_discoverable ? 'true' : 'false');
    if (data.comments_enabled !== undefined) form.append('comments_enabled', data.comments_enabled ? 'true' : 'false');
    if (data.tags !== undefined) form.append('tags', data.tags);
    try {
      const res = await fetch(`${state.currentServerIP}/api/guilds/${guildId}/`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${state.authToken}` },
        body: form,
      });
      if (!res.ok) handleAuthError(res.status);
      const updated: Guild = await res.json();
      setState(prev => ({
        ...prev,
        guilds: prev.guilds.map(g => g.id === guildId ? updated : g),
        currentGuild: prev.currentGuild?.id === guildId ? updated : prev.currentGuild,
      }));
    } catch (e) { reportError(e); }
  }, [state.authToken, state.currentServerIP]);

  const loadGuildEmojis = useCallback(async (guildId: string): Promise<GuildEmoji[]> => {
    try {
      const data: GuildEmoji[] = await apiGet(`/api/guilds/${guildId}/emojis/`, state.authToken, state.currentServerIP);
      return data.map(e => ({ ...e, image: e.image ? `${state.currentServerIP}${e.image}` : e.image }));
    } catch { return []; }
  }, [state.authToken, state.currentServerIP, apiGet]);

  const uploadGuildEmoji = useCallback(async (guildId: string, name: string, file: File): Promise<GuildEmoji | null> => {
    try {
      const form = new FormData();
      form.append('name', name);
      form.append('image', file);
      const res = await fetch(`${state.currentServerIP}/api/guilds/${guildId}/emojis/`, {
        method: 'POST', headers: { Authorization: `Bearer ${state.authToken}` }, body: form,
      });
      if (!res.ok) handleAuthError(res.status);
      const e: GuildEmoji = await res.json();
      return { ...e, image: e.image ? `${state.currentServerIP}${e.image}` : e.image };
    } catch (err) { reportError(err); return null; }
  }, [state.authToken, state.currentServerIP]);

  const deleteGuildEmoji = useCallback(async (guildId: string, emojiId: string) => {
    await fetch(`${state.currentServerIP}/api/guilds/${guildId}/emojis/${emojiId}/`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${state.authToken}` },
    });
  }, [state.authToken, state.currentServerIP]);

  const loadGuildStickers = useCallback(async (guildId: string): Promise<GuildSticker[]> => {
    try {
      const data: GuildSticker[] = await apiGet(`/api/guilds/${guildId}/stickers/`, state.authToken, state.currentServerIP);
      return data.map(s => ({ ...s, image: s.image ? `${state.currentServerIP}${s.image}` : s.image }));
    } catch { return []; }
  }, [state.authToken, state.currentServerIP, apiGet]);

  const uploadGuildSticker = useCallback(async (guildId: string, name: string, description: string, file: File): Promise<GuildSticker | null> => {
    try {
      const form = new FormData();
      form.append('name', name);
      form.append('description', description);
      form.append('image', file);
      const res = await fetch(`${state.currentServerIP}/api/guilds/${guildId}/stickers/`, {
        method: 'POST', headers: { Authorization: `Bearer ${state.authToken}` }, body: form,
      });
      if (!res.ok) handleAuthError(res.status);
      const s: GuildSticker = await res.json();
      return { ...s, image: s.image ? `${state.currentServerIP}${s.image}` : s.image };
    } catch (err) { reportError(err); return null; }
  }, [state.authToken, state.currentServerIP]);

  const deleteGuildSticker = useCallback(async (guildId: string, stickerId: string) => {
    await fetch(`${state.currentServerIP}/api/guilds/${guildId}/stickers/${stickerId}/`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${state.authToken}` },
    });
  }, [state.authToken, state.currentServerIP]);

  const loadGuildSounds = useCallback(async (guildId: string): Promise<GuildSound[]> => {
    try {
      const data: GuildSound[] = await apiGet(`/api/guilds/${guildId}/sounds/`, state.authToken, state.currentServerIP);
      return data.map(s => ({ ...s, url: s.url ? `${state.currentServerIP}${s.url}` : s.url }));
    } catch { return []; }
  }, [state.authToken, state.currentServerIP, apiGet]);

  const uploadGuildSound = useCallback(async (guildId: string, name: string, file: File): Promise<GuildSound | null> => {
    try {
      const form = new FormData();
      form.append('name', name);
      form.append('file', file);
      const res = await fetch(`${state.currentServerIP}/api/guilds/${guildId}/sounds/`, {
        method: 'POST', headers: { Authorization: `Bearer ${state.authToken}` }, body: form,
      });
      if (!res.ok) handleAuthError(res.status);
      const s: GuildSound = await res.json();
      return { ...s, url: s.url ? `${state.currentServerIP}${s.url}` : s.url };
    } catch (err) { reportError(err); return null; }
  }, [state.authToken, state.currentServerIP]);

  const deleteGuildSound = useCallback(async (guildId: string, soundId: string) => {
    await fetch(`${state.currentServerIP}/api/guilds/${guildId}/sounds/${soundId}/`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${state.authToken}` },
    });
  }, [state.authToken, state.currentServerIP]);

  const loadGuildRoles = useCallback(async (guildId: string): Promise<GuildRole[]> => {
    try { return await apiGet(`/api/guilds/${guildId}/roles/`, state.authToken, state.currentServerIP); }
    catch { return []; }
  }, [state.authToken, state.currentServerIP, apiGet]);

  const createGuildRole = useCallback(async (guildId: string, data: { name: string; color: string; permissions: string[] }): Promise<GuildRole | null> => {
    try {
      const res = await fetch(`${state.currentServerIP}/api/guilds/${guildId}/roles/`, {
        method: 'POST', headers: { Authorization: `Bearer ${state.authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) handleAuthError(res.status);
      return res.json();
    } catch (err) { reportError(err); return null; }
  }, [state.authToken, state.currentServerIP]);

  const updateGuildRole = useCallback(async (guildId: string, roleId: string, data: Partial<{ name: string; color: string; permissions: string[]; position: number }>): Promise<GuildRole | null> => {
    try {
      const res = await fetch(`${state.currentServerIP}/api/guilds/${guildId}/roles/${roleId}/`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${state.authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) handleAuthError(res.status);
      return res.json();
    } catch (err) { reportError(err); return null; }
  }, [state.authToken, state.currentServerIP]);

  const deleteGuildRole = useCallback(async (guildId: string, roleId: string) => {
    await fetch(`${state.currentServerIP}/api/guilds/${guildId}/roles/${roleId}/`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${state.authToken}` },
    });
  }, [state.authToken, state.currentServerIP]);

  const updateMemberCustomRoles = useCallback((guildId: string, userId: string, updater: (roles: string[]) => string[]) => {
    setState(prev => {
      const mapMembers = (members: Guild['members']) =>
        members.map(m => String(m.id) === String(userId) ? { ...m, custom_roles: updater(m.custom_roles ?? []) } : m);
      return {
        ...prev,
        guilds: prev.guilds.map(g => g.id === guildId ? { ...g, members: mapMembers(g.members) } : g),
        currentGuild: prev.currentGuild && prev.currentGuild.id === guildId
          ? { ...prev.currentGuild, members: mapMembers(prev.currentGuild.members) }
          : prev.currentGuild,
      };
    });
  }, []);

  const assignMemberRole = useCallback(async (guildId: string, userId: string, roleId: string) => {
    await fetch(`${state.currentServerIP}/api/guilds/${guildId}/members/${userId}/roles/${roleId}/`, {
      method: 'POST', headers: { Authorization: `Bearer ${state.authToken}` },
    });
    updateMemberCustomRoles(guildId, userId, roles => roles.includes(roleId) ? roles : [...roles, roleId]);
  }, [state.authToken, state.currentServerIP, updateMemberCustomRoles]);

  const removeMemberRole = useCallback(async (guildId: string, userId: string, roleId: string) => {
    await fetch(`${state.currentServerIP}/api/guilds/${guildId}/members/${userId}/roles/${roleId}/`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${state.authToken}` },
    });
    updateMemberCustomRoles(guildId, userId, roles => roles.filter(r => r !== roleId));
  }, [state.authToken, state.currentServerIP, updateMemberCustomRoles]);

  const loadGuildInvites = useCallback(async (guildId: string): Promise<GuildInviteData[]> => {
    try { return await apiGet(`/api/guilds/${guildId}/invites/`, state.authToken, state.currentServerIP); }
    catch { return []; }
  }, [state.authToken, state.currentServerIP, apiGet]);

  const createGuildInvite = useCallback(async (guildId: string, data: { max_uses?: number; expires_hours?: number }): Promise<GuildInviteData | null> => {
    try {
      const res = await fetch(`${state.currentServerIP}/api/guilds/${guildId}/invites/`, {
        method: 'POST', headers: { Authorization: `Bearer ${state.authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) handleAuthError(res.status);
      return res.json();
    } catch (err) { reportError(err); return null; }
  }, [state.authToken, state.currentServerIP]);

  const revokeGuildInvite = useCallback(async (guildId: string, inviteId: string) => {
    await fetch(`${state.currentServerIP}/api/guilds/${guildId}/invites/${inviteId}/`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${state.authToken}` },
    });
  }, [state.authToken, state.currentServerIP]);

  const loadGuildAuditLog = useCallback(async (guildId: string): Promise<GuildAuditLogEntry[]> => {
    try { return await apiGet(`/api/guilds/${guildId}/audit-log/`, state.authToken, state.currentServerIP); }
    catch { return []; }
  }, [state.authToken, state.currentServerIP, apiGet]);

  const kickMember = useCallback(async (guildId: string, userId: string) => {
    await fetch(`${state.currentServerIP}/api/guilds/${guildId}/kick/${userId}/`, {
      method: 'POST', headers: { Authorization: `Bearer ${state.authToken}` },
    });
    setState(prev => {
      if (!prev.currentGuild || prev.currentGuild.id !== guildId) return prev;
      return { ...prev, currentGuild: { ...prev.currentGuild, members: prev.currentGuild.members.filter(m => m.id !== userId) } };
    });
  }, [state.authToken, state.currentServerIP]);

  const setMemberRole = useCallback(async (guildId: string, userId: string, role: 'admin' | 'member') => {
    await apiPost(`/api/guilds/${guildId}/role/${userId}/`, state.authToken, state.currentServerIP, { role });
    setState(prev => {
      if (!prev.currentGuild || prev.currentGuild.id !== guildId) return prev;
      return { ...prev, currentGuild: { ...prev.currentGuild, members: prev.currentGuild.members.map(m => m.id === userId ? { ...m, role } : m) } };
    });
  }, [state.authToken, state.currentServerIP, apiPost]);

  const createChannel = useCallback(async (guildId: string, name: string, type: 'text' | 'voice' = 'text', categoryId?: string) => {
    const ch = await apiPost(`/api/guilds/${guildId}/channels/`, state.authToken, state.currentServerIP, { name, type, category_id: categoryId || undefined });
    setState(prev => {
      if (!prev.currentGuild || prev.currentGuild.id !== guildId) return prev;
      if (prev.currentGuild.channels.some(c => c.id === ch.id)) return prev;
      return { ...prev, currentGuild: { ...prev.currentGuild, channels: [...prev.currentGuild.channels, ch] } };
    });
  }, [state.authToken, state.currentServerIP, apiPost]);

  const deleteChannel = useCallback(async (guildId: string, channelId: string) => {
    await fetch(`${state.currentServerIP}/api/guilds/${guildId}/channels/${channelId}/`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${state.authToken}` },
    });
  }, [state.authToken, state.currentServerIP]);

  const updateChannel = useCallback(async (guildId: string, channelId: string, data: { user_limit?: number; name?: string }) => {
    await fetch(`${state.currentServerIP}/api/guilds/${guildId}/channels/${channelId}/`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${state.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  }, [state.authToken, state.currentServerIP]);

  const createCategory = useCallback(async (guildId: string, name: string) => {
    const cat = await apiPost(`/api/guilds/${guildId}/categories/`, state.authToken, state.currentServerIP, { name });
    setState(prev => {
      if (!prev.currentGuild || prev.currentGuild.id !== guildId) return prev;
      if (prev.currentGuild.categories.some(c => c.id === cat.id)) return prev;
      return { ...prev, currentGuild: { ...prev.currentGuild, categories: [...prev.currentGuild.categories, cat] } };
    });
  }, [state.authToken, state.currentServerIP, apiPost]);

  const deleteCategory = useCallback(async (guildId: string, categoryId: string) => {
    await fetch(`${state.currentServerIP}/api/guilds/${guildId}/categories/${categoryId}/`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${state.authToken}` },
    });
  }, [state.authToken, state.currentServerIP]);

  const toggleGuildNotifications = useCallback(async (guildId: string) => {
    const res = await fetch(`${state.currentServerIP}/api/guilds/${guildId}/notifications/`, {
      method: 'POST', headers: { Authorization: `Bearer ${state.authToken}` },
    });
    if (res.ok) {
      const { notifications_muted } = await res.json();
      setState(prev => {
        const updGuilds = prev.guilds.map(g => g.id === guildId ? { ...g, my_notifications_muted: notifications_muted } : g);
        return {
          ...prev,
          guilds: updGuilds,
          currentGuild: prev.currentGuild?.id === guildId ? { ...prev.currentGuild, my_notifications_muted: notifications_muted } : prev.currentGuild,
        };
      });
    }
  }, [state.authToken, state.currentServerIP]);

  const selectGuild = useCallback((guild: Guild) => {
    setState(prev => {
      // Already on this guild — just show channel list on mobile, preserve chat
      if (prev.currentGuild?.id === guild.id && prev.currentView === 'server') {
        return { ...prev, mobileActivePanel: 'guild-channels' as MobilePanel };
      }
      // Switching to a different guild — close old channel WS
      if (guildChannelWs.current) { guildChannelWs.current.close(); guildChannelWs.current = null; }
      // Connect guild-level presence WS so member/channel events arrive even without a channel open
      _connectGuildPresenceWs(guild, prev.authToken, prev.currentServerIP);
      return {
        ...prev,
        currentGuild: guild,
        currentGuildChannel: null,
        guildMessages: [],
        currentView: 'server',
        currentServer: String(guild.id),
        voiceChannelParticipants: {},
        mobileActivePanel: 'guild-channels' as MobilePanel,
      };
    });
  }, [_connectGuildPresenceWs]);

  // Open a discoverable guild/channel for preview WITHOUT joining/subscribing.
  const previewGuild = useCallback(async (guildId: string): Promise<boolean> => {
    try {
      const guild: Guild = await apiGet(`/api/guilds/${guildId}/`, state.authToken, state.currentServerIP);
      selectGuild(guild);
      return true;
    } catch (e) { reportError(e); return false; }
  }, [state.authToken, state.currentServerIP, apiGet, selectGuild]);

  const selectGuildChannel = useCallback((channel: GuildChannel) => {
    setState(prev => {
      if (!prev.currentGuild) return prev;
      if (prev.currentGuildChannel?.id !== channel.id) {
        _connectGuildWs(prev.currentGuild, channel, prev.authToken, prev.currentServerIP);
      }
      const isSameChannel = prev.currentGuildChannel?.id === channel.id;
      const recentBackToList =
        prev.mobileActivePanel === 'guild-channels' &&
        lastGuildChatBackRef.current.channelId === channel.id &&
        Date.now() - lastGuildChatBackRef.current.at < 900;
      if (isSameChannel && recentBackToList) return prev;
      const sameChannel = prev.currentGuildChannel?.id === channel.id;
      return {
        ...prev,
        currentGuildChannel: channel,
        guildMessages: sameChannel ? prev.guildMessages : [],
        guildMessagesLoading: !sameChannel,
        mobileActivePanel: 'guild-chat' as MobilePanel,
      };
    });
  }, [_connectGuildWs]);

  // Load guild channel message history when channel changes
  useEffect(() => {
    if (!state.currentGuild || !state.currentGuildChannel || !state.authToken) return;
    const { id: guildId } = state.currentGuild;
    const { id: channelId } = state.currentGuildChannel;

    const history = apiGet(`/api/guilds/${guildId}/channels/${channelId}/messages/`, state.authToken, state.currentServerIP);

    history
      .then((msgs: GuildMessage[]) => {
        setState(prev => {
          // Merge: keep any WS messages that arrived after the REST snapshot
          const ids = new Set(msgs.map(m => m.id));
          const extra = prev.guildMessages.filter(m => !ids.has(m.id));
          const merged = sortByDate([...msgs, ...extra]);
          return { ...prev, guildMessages: merged, guildMessagesLoading: false };
        });
      })
      .catch(e => {
        setState(prev => ({ ...prev, guildMessagesLoading: false }));
        reportError(e);
      });
  }, [state.currentGuildChannel?.id]);

  // Show an immediate placeholder post while the author's photos upload/post.
  // The real post (delivered over the WS gateway bridge) reconciles with this
  // optimistic entry by matching author + content in the guild chat_message
  // handler; a timeout drops it if the broadcast never arrives.
  const addOptimisticGuildPost = useCallback((text: string, fileCount: number): string => {
    const id = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setState(prev => {
      if (!prev.currentUser) return prev;
      const optimistic = {
        id,
        author: { id: prev.userIDonServer, username: prev.currentUser.username, nickname: prev.currentUser.nickname, avatar: prev.currentUser.avatar, status: prev.currentUser.status },
        content: text,
        created_at: new Date().toISOString(),
        attachments: [],
        reply_to: null,
        is_pinned: false,
        pending: true,
        pending_count: fileCount,
      } as unknown as import('./types').GuildMessage;
      return { ...prev, guildMessages: insertByDate(prev.guildMessages, optimistic) };
    });
    return id;
  }, []);

  const removeOptimisticGuildPost = useCallback((id: string) => {
    setState(prev => {
      if (!prev.guildMessages.some(m => m.id === id)) return prev;
      return { ...prev, guildMessages: prev.guildMessages.filter(m => m.id !== id) };
    });
  }, []);

  // Drop a pending skeleton and add the real post(s) straight from the HTTP
  // response, so the author sees their post even if the WS bridge broadcast
  // never reached them (e.g. the socket reconnected during the upload).
  const resolveGuildPost = useCallback((optimisticId: string, realMsgs: import('./types').GuildMessage[]) => {
    setState(prev => {
      const existing = new Set(prev.guildMessages.map(m => String(m.id)));
      const fresh = realMsgs.filter(m => m && !existing.has(String(m.id)));
      const kept = prev.guildMessages.filter(m => m.id !== optimisticId);
      if (!fresh.length && kept.length === prev.guildMessages.length) return prev;
      return { ...prev, guildMessages: [...kept, ...fresh] };
    });
  }, []);

  const sendGuildMessage = useCallback((text: string, replyToId?: string, attachmentIds?: string[], attachments?: import('./types').GuildMessage['attachments']) => {
    if (guildChannelWs.current?.readyState !== WebSocket.OPEN) return;
    const payload: Record<string, unknown> = { message: text };
    if (replyToId) payload.reply_to_id = replyToId;
    if (attachmentIds?.length) payload.attachment_ids = attachmentIds;
    guildChannelWs.current.send(JSON.stringify(payload));
    setState(prev => {
      if (!prev.currentUser) return prev;
      // Resolve the reply preview for our own message so it shows immediately
      // (the server only echoes back reply_to_id, not the full object).
      let optimisticReplyTo: import('./types').GuildMessage['reply_to'] = null;
      if (replyToId) {
        const target = prev.guildMessages.find(m => String(m.id) === String(replyToId));
        if (target) {
          optimisticReplyTo = {
            id: String(target.id),
            content: target.content,
            author: { id: String(target.author.id), username: target.author.username, nickname: target.author.nickname },
          };
        }
      }
      const optimistic: import('./types').GuildMessage = {
        id: `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        author: {
          id: prev.userIDonServer,
          username: prev.currentUser!.username,
          nickname: prev.currentUser!.nickname,
          avatar: prev.currentUser!.avatar,
          status: prev.currentUser!.status,
        },
        content: text,
        created_at: new Date().toISOString(),
        attachments: attachments || [],
        reply_to: optimisticReplyTo,
        is_pinned: false,
      };
      const msgs = insertByDate(prev.guildMessages, optimistic);
      if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
      return { ...prev, guildMessages: msgs };
    });
  }, []);

  const scheduleGuildMessage = useCallback(async (text: string, delaySecs: number, replyToId?: string, attachmentIds?: string[]): Promise<{ id: string; send_at: string } | null> => {
    if (!state.currentGuild || !state.currentGuildChannel) return null;
    try {
      const body: Record<string, unknown> = { content: text, delay_seconds: delaySecs };
      if (replyToId) body.reply_to_id = replyToId;
      if (attachmentIds?.length) body.attachment_ids = attachmentIds;
      const res = await fetch(`${state.currentServerIP}/api/guilds/${state.currentGuild.id}/channels/${state.currentGuildChannel.id}/schedule/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) return await res.json();
    } catch { /* ignore */ }
    return null;
  }, [state.currentGuild, state.currentGuildChannel, state.currentServerIP, state.authToken]);

  const loadOlderGuildMessages = useCallback(async (): Promise<boolean> => {
    if (!state.currentGuild || !state.currentGuildChannel) return false;
    const firstMsg = state.guildMessages[0];
    if (!firstMsg) return false;
    try {
      const older: GuildMessage[] = await apiGet(
        `/api/guilds/${state.currentGuild.id}/channels/${state.currentGuildChannel.id}/messages/`
        + `?before=${firstMsg.id}&before_ts=${encodeURIComponent(firstMsg.created_at)}&limit=50`,
        state.authToken, state.currentServerIP
      );
      if (older.length === 0) return false;
      setState(prev => {
        // Same guard as the DM loader: dedupe + sort so a bad page can never
        // scramble the channel history.
        const have = new Set(prev.guildMessages.map(m => String(m.id)));
        const fresh = older.filter(m => !have.has(String(m.id)));
        if (!fresh.length) return prev;
        return {
          ...prev,
          guildMessages: sortByDate([...fresh, ...prev.guildMessages]),
        };
      });
      return true;
    } catch (e) { reportError(e); return false; }
  }, [state.currentGuild, state.currentGuildChannel, state.guildMessages, state.authToken, state.currentServerIP, apiGet]);

  const deleteGuildMessage = useCallback(async (messageId: string) => {
    if (!state.currentGuild) return;
    await fetch(`${state.currentServerIP}/api/guilds/${state.currentGuild.id}/messages/${messageId}/`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${state.authToken}` },
    });
    setState(prev => ({ ...prev, guildMessages: prev.guildMessages.filter(m => m.id !== messageId) }));
  }, [state.currentGuild, state.currentServerIP, state.authToken]);

  const pinGuildMessage = useCallback(async (messageId: string) => {
    if (!state.currentGuild) return;
    await fetch(`${state.currentServerIP}/api/guilds/${state.currentGuild.id}/messages/${messageId}/pin/`, {
      method: 'POST', headers: { Authorization: `Bearer ${state.authToken}` },
    });
  }, [state.currentGuild, state.currentServerIP, state.authToken]);

  // ==================== Guild Voice ====================
  const voiceWs = useRef<WebSocket | null>(null);

  const joinVoiceChannel = useCallback((channel: GuildChannel) => {
    // Already in this channel — just focus its view (show the card grid) instead
    // of tearing down and rejoining. Leaving is done from the disconnect button.
    if (state.currentVoiceChannel?.id === channel.id) {
      // On mobile, also slide over to the stage so the participant cards open.
      setState(prev => ({ ...prev, currentGuildChannel: null, mobileActivePanel: 'guild-chat' as MobilePanel }));
      return;
    }
    if (voiceWs.current) {
      voiceWs.current.close();
      voiceWs.current = null;
    }
    setState(prev => ({
      ...prev,
      currentVoiceChannel: channel,
      // Focus the voice view: clearing the text channel makes the main area show
      // the participant grid. On mobile, slide the panel over to it as well so the
      // participant cards actually open instead of staying behind the channel list.
      currentGuildChannel: null,
      mobileActivePanel: 'guild-chat' as MobilePanel,
      voiceParticipants: [],
      isCallActive: false,
      callStatus: 'inactive' as const,
      callTargetId: null,
    }));

    const wsUrl = wsUrlFor(state.currentServerIP);
    const guildId = state.currentGuild?.id;
    if (!guildId) return;
    const ws = new WebSocket(`${wsUrl}/ws/guild/${guildId}/voice/${channel.id}/`, wsProtocols(state.authToken));
    voiceWs.current = ws;

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'voice_participants') {
        setState(prev => ({ ...prev, voiceParticipants: (data.participants || []).map((p: any) => ({ ...p, deafened: p.deafened ?? false })) }));
      } else if (data.type === 'voice_user_joined') {
        const user = { ...data.user, deafened: data.user.deafened ?? false };
        setState(prev => ({
          ...prev,
          voiceParticipants: prev.voiceParticipants.some(p => p.id === user.id)
            ? prev.voiceParticipants
            : [...prev.voiceParticipants, user],
        }));
      } else if (data.type === 'voice_user_left') {
        setState(prev => ({
          ...prev,
          voiceParticipants: prev.voiceParticipants.filter(p => p.id !== data.user_id),
        }));
      } else if (data.type === 'voice_mute_changed') {
        setState(prev => ({
          ...prev,
          voiceParticipants: prev.voiceParticipants.map(p =>
            p.id === data.user_id ? { ...p, muted: data.muted } : p
          ),
        }));
      } else if (data.type === 'voice_deafen_changed') {
        setState(prev => ({
          ...prev,
          voiceParticipants: prev.voiceParticipants.map(p =>
            p.id === data.user_id ? { ...p, deafened: data.deafened } : p
          ),
        }));
      } else if (data.type === 'signal') {
        // Forward incoming WebRTC signal to voice room handler
        voiceSignalHandler.current?.(data);
      }
    };

    ws.onclose = () => {
      setState(prev => {
        if (prev.currentVoiceChannel?.id !== channel.id) return prev;
        return { ...prev, currentVoiceChannel: null, voiceParticipants: [] };
      });
    };
  }, [state.currentServerIP, state.authToken, state.currentGuild?.id, state.currentVoiceChannel?.id]);

  const leaveVoiceChannel = useCallback(() => {
    voiceWs.current?.close();
    voiceWs.current = null;
    setState(prev => ({
      ...prev,
      currentVoiceChannel: null,
      voiceParticipants: [],
      // On mobile, if we were looking at the voice stage (no text channel open),
      // return to the channel list instead of stranding the user on the empty
      // "выберите канал" welcome screen.
      mobileActivePanel: prev.currentGuildChannel ? prev.mobileActivePanel : 'guild-channels' as MobilePanel,
    }));
  }, []);

  const setVoiceMuted = useCallback((muted: boolean) => {
    if (voiceWs.current?.readyState === WebSocket.OPEN) {
      voiceWs.current.send(JSON.stringify({ type: 'voice_mute', muted }));
    }
  }, []);

  const sendVoiceSignal = useCallback((toUserId: string, payload: unknown) => {
    if (voiceWs.current?.readyState === WebSocket.OPEN) {
      voiceWs.current.send(JSON.stringify({ type: 'signal', to: toUserId, payload }));
    }
  }, []);

  // Ref for voice room to register its signal handler
  const voiceSignalHandler = useRef<((data: unknown) => void) | null>(null);
  // Ref to local MediaStream so UserProfile controls can mute/deafen
  const voiceLocalStream = useRef<MediaStream | null>(null);

  // Load guilds on login; restore saved guild on refresh
  useEffect(() => {
    if (!state.authToken) { setState(prev => ({ ...prev, guilds: [], currentGuild: null, currentGuildChannel: null, guildMessages: [] })); return; }
    apiGet('/api/guilds/', state.authToken, state.currentServerIP)
      .then((guilds: Guild[]) => {
        setState(prev => ({ ...prev, guilds }));
      })
      .catch(reportError);
    // Load the saved server-bar layout (folders + ordering) for this user.
    apiGet('/api/server-layout/', state.authToken, state.currentServerIP)
      .then((r: { layout: import('./types').LayoutEntry[] }) => {
        setState(prev => ({ ...prev, serverLayout: Array.isArray(r?.layout) ? r.layout : [] }));
      })
      .catch(() => { /* non-fatal: bar falls back to default order */ });
  }, [state.authToken]);


  // ── Signals that concern servers ─────────────────────────────────────────
  useEffect(() => onWs('signaling', 'guild_kicked_direct', data => {
          // Kicked user receives this via their personal signaling channel
          // regardless of which screen they're currently on
          setState(prev => {
            const isSelf = String(data.user_id) === String(prev.userIDonServer);
            if (!isSelf) return prev;
            const guildId = String(data.guild_id);
            const guildName = String(data.guild_name || '');
            setGuildKickNotification({ title: 'guild_kicked_title', message: guildName });
            const isCurrentGuild = prev.currentGuild?.id === guildId;
            return {
              ...prev,
              guilds: prev.guilds.filter(g => g.id !== guildId),
              currentGuild: isCurrentGuild ? null : prev.currentGuild,
              currentGuildChannel: isCurrentGuild ? null : prev.currentGuildChannel,
              guildMessages: isCurrentGuild ? [] : prev.guildMessages,
              currentView: isCurrentGuild ? 'home' as const : prev.currentView,
              currentServer: isCurrentGuild ? 'home' : prev.currentServer,
            };
          });
  }), []);

  // Someone we blocked, or who blocked us, disappears from member lists.
  useEffect(() => {
    const drop = (userId: string) => setState(prev => ({
      ...prev,
      guilds: prev.guilds.map(g => ({ ...g, members: g.members.filter(m => String(m.id) !== userId) })),
      currentGuild: prev.currentGuild
        ? { ...prev.currentGuild, members: prev.currentGuild.members.filter(m => String(m.id) !== userId) }
        : null,
    }));
    const offs = [
      onWs('signaling', 'blocked', f => drop(String(f.by_user_id as string))),
      onWs('signaling', 'local:user_blocked', f => drop(String(f.user_id as string))),
      onWs('signaling', 'profile_update', f => {
        const u = f.user as { id: string; avatar?: string } | undefined;
        if (!u) return;
        setState(prev => ({
          ...prev,
          guilds: prev.guilds.map(g => ({ ...g, members: g.members.map(m => String(m.id) === String(u.id) ? { ...m, ...u } : m) })),
          currentGuild: prev.currentGuild ? {
            ...prev.currentGuild,
            members: prev.currentGuild.members.map(m => String(m.id) === String(u.id) ? { ...m, ...u } : m),
          } : null,
        }));
      }),
    ];
    return () => offs.forEach(off => off());
  }, [setState]);

  // Leaving the server view (home / settings / explore / another module) clears
  // the open guild, as the core used to do in setCurrentServer.
  useEffect(() => {
    const cur = core.currentServer;
    if (gsRef.current.currentGuild && cur !== String(gsRef.current.currentGuild.id)) {
      closeGuildWs();
      setGs(prev => ({ ...prev, currentGuild: null, currentGuildChannel: null, guildMessages: [] }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core.currentServer]);

  const reloadedFor = useRef(new Set<string>());
  // Navigating to a guild id (from another module, a link, or a restored
  // session) opens that guild once it is known.
  useEffect(() => {
    const cur = core.currentServer;
    if (core.currentView !== 'server' || gs.currentGuild?.id === cur) return;
    const target = gs.guilds.find(g => String(g.id) === cur);
    if (target) { selectGuild(target); return; }
    // Not in the list yet (e.g. a family server created a moment ago): reload once.
    if (/^[0-9a-f-]{36}$/i.test(cur) && !reloadedFor.current.has(cur)) {
      reloadedFor.current.add(cur);
      void loadGuilds();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core.currentServer, core.currentView, gs.guilds]);

  // A DM call ends voice; deafening in the call UI also deafens the voice room.
  useEffect(() => {
    const offs = [
      onLifecycle('callStart', () => {
        if (voiceWs.current) { voiceWs.current.close(); voiceWs.current = null; }
        setGs(prev => ({ ...prev, currentVoiceChannel: null, voiceParticipants: [] }));
      }),
      onLifecycle('deafen', () => { if (voiceWs.current?.readyState === WebSocket.OPEN) voiceWs.current.send(JSON.stringify({ type: 'voice_deafen', deafened: true })); }),
      onLifecycle('undeafen', () => { if (voiceWs.current?.readyState === WebSocket.OPEN) voiceWs.current.send(JSON.stringify({ type: 'voice_deafen', deafened: false })); }),
      onLifecycle('logout', () => {
        closeGuildWs();
        voiceWs.current?.close();
        voiceWs.current = null;
        voiceLocalStream.current?.getTracks().forEach(t => t.stop());
        voiceLocalStream.current = null;
        voiceSignalHandler.current = null;
        setGs(INITIAL);
      }),
    ];
    const onUnload = () => { if (voiceWs.current?.readyState === WebSocket.OPEN) voiceWs.current.close(); };
    window.addEventListener('beforeunload', onUnload);
    return () => { offs.forEach(off => off()); window.removeEventListener('beforeunload', onUnload); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { setBusy('servers', !!gs.currentVoiceChannel); }, [gs.currentVoiceChannel]);

  // Keep pushing our own live locations in the open channel.
  const liveTargetsRef = useRef<{ scope: RichScope; id: string }[]>([]);
  useEffect(() => {
    const now = Date.now();
    liveTargetsRef.current = !state.currentGuild || !state.currentGuildChannel ? [] : state.guildMessages
      .filter(m => {
        const p = m.payload as LocationPayload | undefined;
        return m.message_type === 'location' && !!p?.live && !!p.live_until && new Date(p.live_until).getTime() > now
          && String(m.author?.id) === String(state.userIDonServer);
      })
      .map(m => ({ scope: { kind: 'guild', guildId: state.currentGuild!.id, channelId: state.currentGuildChannel!.id }, id: String(m.id) }));
  }, [state.guildMessages, state.currentGuild, state.currentGuildChannel, state.userIDonServer]);
  useEffect(() => {
    if (!navigator.geolocation) return;
    const timer = setInterval(() => {
      const targets = liveTargetsRef.current;
      if (!targets.length) return;
      navigator.geolocation.getCurrentPosition(
        pos => targets.forEach(t => { void core.pushLiveLocation(t.scope, t.id, { lat: pos.coords.latitude, lng: pos.coords.longitude }); }),
        () => {},
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
      );
    }, 20000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  stickerLoader = () => (gsRef.current.currentGuild ? loadGuildStickers(gsRef.current.currentGuild.id) : Promise.resolve([]));

  const value = {
    ...gs,
    guildKickNotification,
    clearGuildKickNotification,
    loadGuilds,
    updateGuild,
    loadGuildEmojis,
    uploadGuildEmoji,
    deleteGuildEmoji,
    loadGuildStickers,
    uploadGuildSticker,
    deleteGuildSticker,
    loadGuildSounds,
    uploadGuildSound,
    deleteGuildSound,
    loadGuildRoles,
    createGuildRole,
    updateGuildRole,
    deleteGuildRole,
    assignMemberRole,
    removeMemberRole,
    loadGuildInvites,
    createGuildInvite,
    revokeGuildInvite,
    loadGuildAuditLog,
    createGuild,
    saveLayout,
    toggleReaction,
    votePoll,
    closePoll,
    fetchPollVoters,
    registerMessageView,
    loadPostComments,
    addPostComment,
    deletePostComment,
    joinGuild,
    previewGuild,
    leaveGuild,
    deleteGuild,
    kickMember,
    setMemberRole,
    createChannel,
    deleteChannel,
    updateChannel,
    createCategory,
    deleteCategory,
    toggleGuildNotifications,
    selectGuild,
    selectGuildChannel,
    sendGuildMessage,
    addOptimisticGuildPost,
    removeOptimisticGuildPost,
    resolveGuildPost,
    scheduleGuildMessage,
    loadOlderGuildMessages,
    deleteGuildMessage,
    pinGuildMessage,
    guildChannelWs,
    joinVoiceChannel,
    leaveVoiceChannel,
    setVoiceMuted,
    sendVoiceSignal,
    voiceWs,
    voiceSignalHandler,
    voiceLocalStream,
    postCommentHandler,
  } as ServersContextValue;

  return <ServersContext.Provider value={value}>{children}</ServersContext.Provider>;
}

void React;
void useMemo;
