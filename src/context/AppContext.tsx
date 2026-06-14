import React, { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import type { AppState, ViewType, MobilePanel, ServerUser, PendingRequest, ChatMessage, Guild, GuildChannel, GuildMessage, GuildRole, GuildEmoji, GuildSticker, GuildSound, GuildInviteData, GuildAuditLogEntry } from '../types';
import type { CustomEmoji } from '../types';
import { loadSelectedServer } from '../config/network';


// ── Inject X-Ionik-Client header into every fetch ────────────────────────────
// Prevents direct browser access to the server (the server rejects requests
// without this header, returning an empty 200 response instead).
const _origFetch = window.fetch.bind(window);
(window as unknown as { fetch: typeof fetch }).fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const headers = new Headers((init?.headers) as HeadersInit | undefined);
  headers.set('X-Ionik-Client', '1');
  return _origFetch(input, { ...init, headers });
};

// ── Global error interception ────────────────────────────────────────────────
// Captures errors before the context mounts, then drains them once it's ready.
const _errorQueue: string[] = [];
let _errorSink: ((msg: string) => void) | null = null;

function _dispatch(msg: string) {
  if (_errorSink) {
    _errorSink(msg);
  } else if (!_errorQueue.includes(msg)) {
    _errorQueue.push(msg);
  }
}

export function reportError(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e ?? 'Unknown error');
  _dispatch(msg);
}

console.error = (...args: unknown[]) => {
  const msg = args.map(a => (a instanceof Error ? a.message : String(a))).join(' ');
  _dispatch(msg);
};

// Intercept uncaught errors
window.addEventListener('error', (e) => {
  _dispatch(e.message || String(e));
});

// Intercept unhandled promise rejections
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  const msg = reason instanceof Error ? reason.message : String(reason ?? 'Unhandled rejection');
  _dispatch(msg);
});

// ── Parse call message content ───────────────────────────────────────────────
const CALL_CONTENT_RE = /^%%call:(\w+):(voice|video)(?::(\d+))?%%$/;
function enrichCallMessage(msg: ChatMessage): ChatMessage {
  if (msg.message_type === 'call' && msg.call_info) return msg;
  const m = msg.content?.match(CALL_CONTENT_RE);
  if (!m) return msg;
  const status = m[1] as import('../types').CallStatus;
  const video = m[2] === 'video';
  const duration = m[3] != null ? Number(m[3]) : undefined;
  return { ...msg, message_type: 'call', call_info: { status, duration, video } };
}

// ── Accent colour (premium blue default) ─────────────────────────────────────
const DEFAULT_ACCENT = '#0070F3';
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
function applyAccent(color: string) {
  document.documentElement.style.setProperty('--accent-primary', color);
  document.documentElement.style.setProperty('--accent-hover', shadeColor(color, -15));
  document.documentElement.style.setProperty('--accent-active', shadeColor(color, -25));
  const [r, g, b] = hexToRgb(color);
  const isDark = document.body.classList.contains('dark-theme');
  const msgOwn = isDark
    ? `rgba(${r}, ${g}, ${b}, 0.18)`
    : `rgba(${r}, ${g}, ${b}, 0.15)`;
  document.documentElement.style.setProperty('--message-own', msgOwn);
}
function shadeColor(hex: string, pct: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, Math.max(0, (n >> 16) + Math.round(2.55 * pct)));
  const g = Math.min(255, Math.max(0, ((n >> 8) & 0xff) + Math.round(2.55 * pct)));
  const b = Math.min(255, Math.max(0, (n & 0xff) + Math.round(2.55 * pct)));
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
// Apply on load
applyAccent(localStorage.getItem('accentColor') || DEFAULT_ACCENT);
document.documentElement.style.setProperty('--chat-message-gap', '4px');

interface AppContextType extends AppState {
  setCurrentView: (view: ViewType) => void;
  setCurrentServer: (serverId: string) => void;
  setCurrentChat: (chatId: string) => void;
  setCurrentChannel: (channel: string) => void;
  setCurrentSettingsPage: (page: string) => void;
  toggleTheme: () => void;
  setLanguage: (lang: string) => void;
  toggleMobileSidebar: () => void;
  setMobileActivePanel: (panel: MobilePanel) => void;
  setCallActive: (active: boolean) => void;
  setDemonstrationActive: (DemonstrationActive: boolean) => void;
  setVideoActive: (VideoActive: boolean) => void;
  setMicActive: (v: boolean) => void;
  setHeadphonesActive: (v: boolean) => void;
  setSpeakersActive: (SpeakersActive: Array<string>) => void;
  setCallStatus: (status: 'active' | 'ringing' | 'connection' | 'inactive') => void;
  setCurrentServerIP: (serverIP: string) => void;
  setUserIDonServer: (userIDonServer: string) => void;
  setCurrentUser: (user: ServerUser) => void;
  setAuthToken: (token: string) => void;
  setCallTargetId: (id: string | null) => void;
  setIncomingOffer: (offer: any | null) => void;
  signalingWs: React.MutableRefObject<WebSocket | null>;
  sendSignal: (data: any) => void;
  signalingPeers: Array<{ id: string; name: string }>;
  onSignalingMessage: React.MutableRefObject<((msg: any) => void) | null>;
  loadFriends: () => Promise<void>;
  loadPendingRequests: () => Promise<void>;
  removeFriend: (userId: string) => Promise<void>;
  blockUser: (userId: string) => Promise<void>;
  unblockUser: (userId: string) => Promise<void>;
  removeBlockedContact: (userId: string) => void;
  setAccentColor: (color: string) => void;
  sendFriendRequest: (userId: string, user?: ServerUser) => Promise<void>;
  acceptFriendRequest: (friendshipId: string) => Promise<void>;
  rejectFriendRequest: (friendshipId: string) => Promise<void>;
  searchUsers: (query: string) => Promise<ServerUser[]>;
  sendChatMessage: (text: string, attachmentIds?: string[], replyToId?: string) => void;
  addCallMessage: (callInfo: import('../types').CallInfo) => void;
  deleteMessage: (messageId: string) => Promise<void>;
  pinMessage: (messageId: string) => Promise<void>;
  reportMessage: (messageId: string) => Promise<void>;
  loadOlderMessages: () => Promise<boolean>;
  loadCustomEmojis: () => Promise<void>;
  scheduleMessage: (conversationId: string, text: string, attachmentIds: string[], delaySeconds: number, replyToId?: string) => Promise<{ id: string; send_at: string } | null>;
  cancelScheduledMessage: (scheduledId: string) => Promise<void>;
  listScheduled: (conversationId: string) => Promise<Array<{ id: string; send_at: string; content: string }>>;
  showError: (message: string) => void;
  clearError: () => void;
  errorMessage: string | null;
  toasts: Array<{ id: number; message: string }>;
  dismissToast: (id: number) => void;
  guildKickNotification: { title: string; message: string } | null;
  clearGuildKickNotification: () => void;
  // Guild methods
  loadGuilds: () => Promise<void>;
  updateGuild: (guildId: string, data: { name?: string; description?: string; tag?: string; icon?: File | null; banner?: File | null; removeIcon?: boolean; removeBanner?: boolean; boost_level?: number; verification_level?: string; default_notifications?: string; explicit_content_filter?: string; require_2fa?: boolean }) => Promise<void>;
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
  joinGuild: (inviteCode: string) => Promise<Guild | null>;
  leaveGuild: (guildId: string) => Promise<void>;
  deleteGuild: (guildId: string) => Promise<void>;
  kickMember: (guildId: string, userId: string) => Promise<void>;
  setMemberRole: (guildId: string, userId: string, role: 'admin' | 'member') => Promise<void>;
  createChannel: (guildId: string, name: string, type?: 'text' | 'voice') => Promise<void>;
  deleteChannel: (guildId: string, channelId: string) => Promise<void>;
  selectGuild: (guild: Guild) => void;
  selectGuildChannel: (channel: GuildChannel) => void;
  sendGuildMessage: (text: string, replyToId?: string, attachmentIds?: string[]) => void;
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
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within AppProvider');
  }
  return context;
};

interface AppProviderProps {
  children: ReactNode;
}

export const AppProvider: React.FC<AppProviderProps> = ({ children }) => {
  const [state, setState] = useState<AppState>(() => {
    const savedTheme = localStorage.getItem('messengerTheme') as 'light' | 'dark' || 'dark';
    const supportedLangs = ['en', 'ru', 'es', 'zh', 'fr', 'de', 'pt'];
    const browserLang = (navigator.language || '').slice(0, 2).toLowerCase();
    const defaultLang = supportedLangs.includes(browserLang) ? browserLang : 'en';
    const savedLanguage = localStorage.getItem('messengerLanguage') || defaultLang;
    const savedServer = localStorage.getItem('messengerCurrentServer') || 'home';
    const savedChat = localStorage.getItem('messengerCurrentChat') || '';
    const savedChannel = localStorage.getItem('messengerCurrentChannel') || 'general';
    const savedToken = localStorage.getItem('authToken') || '';

    return {
      currentView: savedServer === 'settings' ? 'settings' : 'home',
      currentServer: (savedServer === 'home' || savedServer === 'settings') ? savedServer : 'home',
      currentChat: savedChat,
      currentChannel: savedChannel,
      currentSettingsPage: '',
      theme: savedTheme,
      language: savedLanguage,
      isMobileSidebarOpen: false,
      mobileActivePanel: 'chat-list',
      isCallActive: false,
      isDemonstrationActive: false,
      isVideoActive: false,
      isMicActive: true,
      isHeadphonesActive: true,
      SpeakersActive: ["", ""],
      callStatus: 'inactive',
      currentServerIP: loadSelectedServer(),
      userIDonServer: '',
      authToken: savedToken,
      currentUser: null,
      friends: [],
      blockedContacts: [],
      pendingRequests: [],
      sentRequests: [],
      callTargetId: null,
      incomingOffer: null,
      chatMessages: [],
      chatConversationId: null,
      chatBlockedByOther: false,
      customEmojis: [],
      guilds: [],
      currentGuild: null,
      currentGuildChannel: null,
      guildMessages: [],
      currentVoiceChannel: null,
      voiceParticipants: [],
      voiceChannelParticipants: {},
    };
  });

  // Server IP is now user-selected via ServerSelector

  const signalingWs = useRef<WebSocket | null>(null);
  const callTargetIdRef = useRef<string | null>(null);
  const [signalingPeers, setSignalingPeers] = useState<Array<{ id: string; name: string }>>([]);
  const onSignalingMessage = useRef<((msg: any) => void) | null>(null);
  const pendingStatusRef = useRef<Record<string, string>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const showError = useCallback((message: string) => setErrorMessage(message), []);
  const clearError = useCallback(() => setErrorMessage(null), []);
  const toastIdRef = useRef(0);
  const [toasts, setToasts] = useState<Array<{ id: number; message: string }>>([]);
  const addToast = useCallback((message: string) => {
    setToasts(prev => {
      if (prev.some(t => t.message === message)) return prev;
      const id = ++toastIdRef.current;
      return [...prev, { id, message }];
    });
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);
  const [guildKickNotification, setGuildKickNotification] = useState<{ title: string; message: string } | null>(null);
  const clearGuildKickNotification = useCallback(() => setGuildKickNotification(null), []);

  // Drain any errors that were queued before the context mounted, then
  // redirect all future console.error / window errors into the modal.
  useEffect(() => {
    // Drain queue
    for (const msg of _errorQueue) addToast(msg);
    _errorQueue.length = 0;
    // Point the global sink at toasts
    _errorSink = (msg: string) => addToast(msg);
    return () => {
      _errorSink = null;
    };
  }, [addToast]);

  const chatWs = useRef<WebSocket | null>(null);
  const chatLastMsgId = useRef<string | null>(null);
  const [chatReinitTrigger, setChatReinitTrigger] = useState(0);

  // ==================== Logout helper ====================
  const logout = useCallback(() => {
    localStorage.removeItem('authToken');
    setState(prev => ({ ...prev, authToken: '', currentUser: null, friends: [], pendingRequests: [], sentRequests: [], userIDonServer: '', currentChat: '' }));
  }, []);

  const handleAuthError = useCallback((status: number) => {
    if (status === 401) {
      logout();
      throw new Error('error_unauthorized');
    }
    if (status === 403) throw new Error('error_forbidden');
    if (status === 404) throw new Error('error_not_found');
    if (status >= 500) throw new Error('error_server');
    throw new Error(`Error ${status}`);
  }, [logout]);

  // ==================== API helpers ====================
  const apiGet = useCallback(async (path: string, token: string, serverIP: string) => {
    const res = await fetch(`${serverIP}${path}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) handleAuthError(res.status);
    return res.json();
  }, [handleAuthError]);

  const apiPost = useCallback(async (path: string, token: string, serverIP: string, body: any) => {
    const res = await fetch(`${serverIP}${path}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (res.status === 401) { logout(); throw new Error('error_unauthorized'); }
      const data = await res.json().catch(() => null);
      if (data && typeof data === 'object') {
        const msg = Object.values(data).flat().join(', ');
        if (msg) throw new Error(msg);
      }
      handleAuthError(res.status);
    }
    return res.json();
  }, [handleAuthError, logout]);

  // ==================== Load user info after login ====================
  useEffect(() => {
    if (!state.authToken) {
      setState(prev => ({ ...prev, currentUser: null, friends: [], pendingRequests: [], sentRequests: [], userIDonServer: '', currentChat: '' }));
      return;
    }
    const load = async () => {
      try {
        const user: ServerUser = await apiGet('/api/auth/me/', state.authToken, state.currentServerIP);
        setState(prev => ({ ...prev, currentUser: user, userIDonServer: String(user.id) }));
      } catch (e) { logout(); return; }
      try {
        const [friendsRaw, blockedRaw]: [ServerUser[], any[]] = await Promise.all([
          apiGet('/api/auth/friends/', state.authToken, state.currentServerIP),
          apiGet('/api/auth/blocked/', state.authToken, state.currentServerIP),
        ]);
        const friends = friendsRaw;
        const blockedContacts: ServerUser[] = blockedRaw.map((r: any) => r.blocked);
        // Merge any status updates that arrived via WS before this load completed
        const merged = friends.map(f => ({
          ...f,
          status: (pendingStatusRef.current[String(f.id)] ?? f.status) as ServerUser['status'],
        }));
        setState(prev => ({ ...prev, friends: merged, blockedContacts }));
      } catch (e) { reportError(e); }
      try {
        const pending: PendingRequest[] = await apiGet('/api/auth/friends/requests/pending/', state.authToken, state.currentServerIP);
        setState(prev => ({ ...prev, pendingRequests: pending }));
      } catch (e) { reportError(e); }
      try {
        const emojis: CustomEmoji[] = await apiGet('/api/auth/emojis/', state.authToken, state.currentServerIP);
        const serverIP = state.currentServerIP;
        setState(prev => ({
          ...prev,
          customEmojis: emojis.map(e => ({
            ...e,
            image_url: e.image_url ? `${serverIP}${e.image_url}` : '',
          })),
        }));
      } catch (e) { reportError(e); }
    };
    load();
  }, [state.authToken, state.currentServerIP]);

  // ==================== FCM token registration (Android push notifications) ====================
  useEffect(() => {
    if (!state.authToken || !state.currentServerIP) return;

    const registerToken = (token: string) => {
      fetch(`${state.currentServerIP}/api/auth/fcm-token/`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${state.authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token }),
      }).catch(() => {/* silent — non-critical */});
    };

    (window as any).ionikOnFcmToken = registerToken;

    // Request the token from Android if the bridge is available
    if ((window as any).AndroidBridge?.requestFcmToken) {
      (window as any).AndroidBridge.requestFcmToken();
    }

    return () => { (window as any).ionikOnFcmToken = undefined; };
  }, [state.authToken, state.currentServerIP]);

  // ==================== Friends actions ====================
  const loadFriends = useCallback(async () => {
    try {
      const friends: ServerUser[] = await apiGet('/api/auth/friends/', state.authToken, state.currentServerIP);
      setState(prev => ({ ...prev, friends }));
    } catch (e) { reportError(e); }
  }, [state.authToken, state.currentServerIP, apiGet]);

  const loadPendingRequests = useCallback(async () => {
    try {
      const pending: PendingRequest[] = await apiGet('/api/auth/friends/requests/pending/', state.authToken, state.currentServerIP);
      setState(prev => ({ ...prev, pendingRequests: pending }));
    } catch (e) { reportError(e); }
  }, [state.authToken, state.currentServerIP, apiGet]);

  const loadCustomEmojis = useCallback(async () => {
    if (!state.authToken) return;
    try {
      const emojis: CustomEmoji[] = await apiGet('/api/auth/emojis/', state.authToken, state.currentServerIP);
      const serverIP = state.currentServerIP;
      setState(prev => ({
        ...prev,
        customEmojis: emojis.map(e => ({
          ...e,
          image_url: e.image_url ? `${serverIP}${e.image_url}` : '',
        })),
      }));
    } catch (e) { reportError(e); }
  }, [state.authToken, state.currentServerIP, apiGet]);

  const removeFriend = useCallback(async (userId: string) => {
    await fetch(`${state.currentServerIP}/api/auth/friends/${userId}/remove/`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${state.authToken}` },
    });
    setState(prev => ({ ...prev, friends: prev.friends.filter(f => String(f.id) !== String(userId)) }));
  }, [state.authToken, state.currentServerIP]);

  const blockUser = useCallback(async (userId: string) => {
    const res = await fetch(`${state.currentServerIP}/api/auth/block/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId }),
    });
    // API returns the blocked user's info — use it directly so the list always updates
    const data = res.ok ? await res.json() : null;
    const blockedUser: ServerUser | null = data?.blocked ?? null;

    setState(prev => {
      const fromFriends = prev.friends.find(f => String(f.id) === String(userId));
      const blockedEntry = blockedUser ?? fromFriends ?? null;
      return {
        ...prev,
        friends: prev.friends.filter(f => String(f.id) !== String(userId)),
        pendingRequests: prev.pendingRequests.filter(r => String(r.id) !== String(userId)),
        sentRequests: prev.sentRequests.filter(r => String(r.id) !== String(userId)),
        blockedContacts: blockedEntry
          ? [...prev.blockedContacts.filter(u => String(u.id) !== String(userId)), blockedEntry]
          : prev.blockedContacts,
        guilds: prev.guilds.map(g => ({
          ...g,
          members: g.members.filter(m => String(m.id) !== String(userId)),
        })),
        currentGuild: prev.currentGuild
          ? { ...prev.currentGuild, members: prev.currentGuild.members.filter(m => String(m.id) !== String(userId)) }
          : null,
      };
    });
  }, [state.authToken, state.currentServerIP]);

  const unblockUser = useCallback(async (userId: string) => {
    await fetch(`${state.currentServerIP}/api/auth/unblock/${userId}/`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${state.authToken}` },
    });
    // Read current state synchronously from closure to decide what to do immediately.
    const inBlocked = state.blockedContacts.find(u => String(u.id) === String(userId));
    const inFriends = state.friends.some(f => String(f.id) === String(userId));
    setState(prev => {
      const unblocked = prev.blockedContacts.find(u => String(u.id) === String(userId));
      const alreadyFriend = prev.friends.some(f => String(f.id) === String(userId));
      return {
        ...prev,
        blockedContacts: prev.blockedContacts.filter(u => String(u.id) !== String(userId)),
        friends: unblocked && !alreadyFriend ? [...prev.friends, unblocked] : prev.friends,
      };
    });
    // If the user wasn't in either list (block + delete dialog case), fetch their profile
    // immediately so they appear in the sidebar without waiting for loadFriends().
    if (!inBlocked && !inFriends) {
      try {
        const res = await fetch(`${state.currentServerIP}/api/auth/users/${userId}/profile/`, {
          headers: { Authorization: `Bearer ${state.authToken}` },
        });
        if (res.ok) {
          const profile = await res.json();
          setState(prev => {
            if (prev.friends.some(f => String(f.id) === String(userId))) return prev;
            return { ...prev, friends: [...prev.friends, profile] };
          });
        }
      } catch { /* ignore */ }
    }
    await loadFriends();
  }, [state.authToken, state.currentServerIP, state.blockedContacts, state.friends, loadFriends]);

  const removeBlockedContact = useCallback((userId: string) => {
    setState(prev => ({
      ...prev,
      blockedContacts: prev.blockedContacts.filter(u => String(u.id) !== String(userId)),
    }));
  }, []);

  const setAccentColor = useCallback((color: string) => {
    localStorage.setItem('accentColor', color);
    applyAccent(color);
  }, []);

  const sendFriendRequest = useCallback(async (userId: string, user?: ServerUser) => {
    if (user) {
      setState(prev => ({
        ...prev,
        sentRequests: prev.sentRequests.some(u => String(u.id) === String(userId))
          ? prev.sentRequests
          : [...prev.sentRequests, user],
      }));
    }
    await apiPost('/api/auth/friends/request/', state.authToken, state.currentServerIP, { user_id: userId });
  }, [state.authToken, state.currentServerIP, apiPost]);

  const acceptFriendRequest = useCallback(async (friendshipId: string) => {
    // Optimistic update: move accepted user from pendingRequests → friends immediately
    setState(prev => {
      const req = prev.pendingRequests.find(r => r.id === friendshipId);
      if (!req) return prev;
      const newFriend: ServerUser = req.from_user;
      const alreadyFriend = prev.friends.some(f => String(f.id) === String(newFriend.id));
      return {
        ...prev,
        friends: alreadyFriend ? prev.friends : [...prev.friends, newFriend],
        pendingRequests: prev.pendingRequests.filter(r => r.id !== friendshipId),
      };
    });
    await apiPost(`/api/auth/friends/request/${friendshipId}/accept/`, state.authToken, state.currentServerIP, {});
    await loadFriends();
    await loadPendingRequests();
  }, [state.authToken, state.currentServerIP, apiPost, loadFriends, loadPendingRequests]);

  const rejectFriendRequest = useCallback(async (friendshipId: string) => {
    await apiPost(`/api/auth/friends/request/${friendshipId}/reject/`, state.authToken, state.currentServerIP, {});
    await loadPendingRequests();
  }, [state.authToken, state.currentServerIP, apiPost, loadPendingRequests]);

  const searchUsers = useCallback(async (query: string): Promise<ServerUser[]> => {
    const users: ServerUser[] = await apiGet('/api/auth/users/', state.authToken, state.currentServerIP);
    const q = query.toLowerCase();
    return users.filter(u =>
      u.username.toLowerCase().includes(q) || u.nickname.toLowerCase().includes(q)
    );
  }, [state.authToken, state.currentServerIP, apiGet]);

  // ==================== Chat WebSocket ====================
  // When currentChat changes, get/create conversation, load history, connect WS
  useEffect(() => {
    // Close existing chat WS
    if (chatWs.current) {
      chatWs.current.close();
      chatWs.current = null;
    }

    if (!state.currentChat || !state.authToken) {
      setState(prev => ({ ...prev, chatMessages: [], chatConversationId: null, chatBlockedByOther: false }));
      return;
    }

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const initChat = async () => {
      try {
        // Get or create conversation with this user
        setState(prev => ({ ...prev, chatBlockedByOther: false }));
        const convoRes = await fetch(`${state.currentServerIP}/api/conversations/create/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.authToken}` },
          body: JSON.stringify({ user_id: state.currentChat }),
        });
        if (cancelled) return;
        if (convoRes.status === 403) {
          // No prior conversation exists and we're blocked — nothing to show
          setState(prev => ({ ...prev, chatBlockedByOther: true, chatMessages: [], chatConversationId: null }));
          return;
        }
        if (!convoRes.ok) handleAuthError(convoRes.status);
        const convo = await convoRes.json();
        if (cancelled) return;
        if (convo.blocked_by_other) {
          // Existing conversation accessible, but we can't send new messages
          setState(prev => ({ ...prev, chatBlockedByOther: true }));
        }

        const convoId = convo.id;
        setState(prev => ({ ...prev, chatConversationId: convoId }));

        // Load message history
        const msgs: ChatMessage[] = await apiGet(
          `/api/conversations/${convoId}/messages/`,
          state.authToken,
          state.currentServerIP
        );
        if (cancelled) return;
        setState(prev => ({ ...prev, chatMessages: msgs.map(enrichCallMessage) }));
        // Seed the last-ID ref so polling knows where to start
        const last = msgs.filter(m => !String(m.id).startsWith('optimistic-')).at(-1);
        if (last) chatLastMsgId.current = String(last.id);

        // Connect chat WebSocket (with auto-reconnect on unexpected close)
        const wsUrl = state.currentServerIP.replace(/^http/, 'ws');
        let isFirstConnect = true;

        const connectChatWs = () => {
          if (cancelled) return;
          const ws = new WebSocket(`${wsUrl}/ws/chat/${convoId}/?token=${state.authToken}`);

          ws.onopen = () => {
            if (cancelled) { ws.close(); return; }
            chatWs.current = ws;

            if (!isFirstConnect) {
              // On reconnect: reload history to surface messages missed while WS was down.
              // IMPORTANT: merge with current state — don't discard WS messages that arrived
              // after the API snapshot was taken (they would otherwise be silently lost).
              apiGet(`/api/conversations/${convoId}/messages/`, state.authToken, state.currentServerIP)
                .then((raw: ChatMessage[]) => {
                  if (cancelled) return;
                  const freshMsgs = raw.map(enrichCallMessage);
                  setState(prev => {
                    const freshIds = new Set(freshMsgs.map(m => String(m.id)));
                    // Keep confirmed WS messages not yet in the server snapshot
                    const lateWsMsgs = prev.chatMessages.filter(
                      m => !String(m.id).startsWith('optimistic-') && !freshIds.has(String(m.id))
                    );
                    const merged = [...freshMsgs, ...lateWsMsgs].sort(
                      (a, b) => a.created_at.localeCompare(b.created_at)
                    );
                    const realContents = new Set(merged.map(m => m.content));
                    const pending = prev.chatMessages.filter(
                      m => String(m.id).startsWith('optimistic-') && !realContents.has(m.content)
                    );
                    return { ...prev, chatMessages: [...merged, ...pending] };
                  });
                })
                .catch(() => {});
            }
            isFirstConnect = false;

            // Mark all as read
            try { ws.send(JSON.stringify({ type: 'mark_read' })); } catch { /* ignore */ }
          };

          ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'conversation_deleted') {
              setState(prev => ({
                ...prev,
                chatMessages: [],
                chatConversationId: null,
                currentChat: '',
                mobileActivePanel: 'chat-list' as MobilePanel,
                // Also remove from blocked contacts if this was a blocked DM
                blockedContacts: prev.blockedContacts.filter(
                  u => String(u.id) !== String(prev.currentChat)
                ),
              }));
              if (chatWs.current === ws) {
                chatWs.current = null;
              }
              return;
            }
            if (data.type === 'message_deleted') {
              setState(prev => ({
                ...prev,
                chatMessages: prev.chatMessages
                  .filter(m => m.id !== data.id)
                  .map(m => m.reply_to?.id === data.id
                    ? { ...m, reply_to: { ...m.reply_to!, deleted: true } }
                    : m
                  ),
              }));
            } else if (data.type === 'message_status') {
              const ids: string[] = data.ids || [];
              const field: 'delivered_at' | 'read_at' = data.field;
              const ts: string = data.ts;
              setState(prev => ({
                ...prev,
                chatMessages: prev.chatMessages.map(m =>
                  ids.includes(String(m.id))
                    ? (field === 'read_at'
                        ? { ...m, read_at: ts, delivered_at: m.delivered_at || ts }
                        : { ...m, delivered_at: ts })
                    : m
                ),
              }));
            } else {
              const msg: ChatMessage = enrichCallMessage(data);
              setState(prev => {
                if (prev.chatMessages.some(m => String(m.id) === String(msg.id))) return prev;
                const nonce = (data as any).nonce;
                let optIdx = -1;
                if (nonce) {
                  optIdx = prev.chatMessages.findIndex(m => m.id === `optimistic-${nonce}`);
                }
                if (optIdx === -1) {
                  optIdx = prev.chatMessages.findIndex(
                    m => String(m.id).startsWith('optimistic-') &&
                      m.content === msg.content
                  );
                }
                if (optIdx === -1) {
                  optIdx = prev.chatMessages.findIndex(
                    m => String(m.id).startsWith('optimistic-')
                  );
                }
                let msgs: ChatMessage[];
                if (optIdx !== -1) {
                  msgs = [...prev.chatMessages];
                  msgs[optIdx] = msg;
                } else {
                  msgs = [...prev.chatMessages, msg];
                }
                if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
                chatLastMsgId.current = String(msg.id);
                return { ...prev, chatMessages: msgs };
              });
            }
          };

          ws.onclose = () => {
            if (chatWs.current === ws) chatWs.current = null;
            // Auto-reconnect after 3 s if not intentionally cancelled
            if (!cancelled) {
              reconnectTimer = setTimeout(connectChatWs, 3000);
            }
          };

          ws.onerror = () => {};
        };

        connectChatWs();

        // Polling fallback: catches messages the server WS broadcast dropped.
        // Same URL as the initial load — server returns recent messages.
        // cache:'no-store' prevents browser from serving a stale cached response.
        const pollUrl = `${state.currentServerIP}/api/conversations/${convoId}/messages/`;
        pollTimer = setInterval(async () => {
          if (cancelled) return;
          try {
            const res = await fetch(pollUrl, {
              headers: { Authorization: `Bearer ${state.authToken}`, 'X-Ionik-Client': '1' },
              cache: 'no-store',
            });
            if (!res.ok || cancelled) return;
            const body = await res.json();
            // Support both plain array and DRF paginated {results:[...]} shapes
            const polled: ChatMessage[] = (Array.isArray(body) ? body : (body?.results ?? [])).map(enrichCallMessage);
            if (!polled.length || cancelled) return;

            setState(prev => {
              const realIds = new Set(prev.chatMessages.filter(m => !String(m.id).startsWith('optimistic-')).map(m => String(m.id)));
              const fresh = polled.filter(m => !realIds.has(String(m.id)));
              if (!fresh.length) {
                // Even with no fresh messages, clean up stale optimistic messages
                // (older than 10s — server should have confirmed them by now)
                const now = Date.now();
                const cleaned = prev.chatMessages.filter(m =>
                  !String(m.id).startsWith('optimistic-') ||
                  (now - new Date(m.created_at).getTime()) < 10000
                );
                return cleaned.length !== prev.chatMessages.length
                  ? { ...prev, chatMessages: cleaned }
                  : prev;
              }
              let updated = [...prev.chatMessages];
              for (const fm of fresh) {
                let optIdx = updated.findIndex(
                  m => String(m.id).startsWith('optimistic-') &&
                    m.content === fm.content
                );
                if (optIdx === -1) {
                  optIdx = updated.findIndex(
                    m => String(m.id).startsWith('optimistic-')
                  );
                }
                if (optIdx !== -1) {
                  updated[optIdx] = fm;
                } else {
                  updated.push(fm);
                }
              }
              // Remove any remaining stale optimistic messages
              const now = Date.now();
              updated = updated.filter(m =>
                !String(m.id).startsWith('optimistic-') ||
                (now - new Date(m.created_at).getTime()) < 10000
              );
              if (updated.length > 500) updated.splice(0, updated.length - 500);
              return { ...prev, chatMessages: updated };
            });
          } catch { /* ignore */ }
        }, 5000);
      } catch (e) { reportError(e); }
    };

    initChat();

    return () => {
      cancelled = true;
      if (pollTimer !== null) clearInterval(pollTimer);
      chatLastMsgId.current = null;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (chatWs.current) {
        chatWs.current.close();
        chatWs.current = null;
      }
    };
  }, [state.currentChat, state.authToken, state.currentServerIP, chatReinitTrigger]);

  const sendChatMessage = useCallback((text: string, attachmentIds?: string[], replyToId?: string) => {
    const payload: Record<string, unknown> = {};
    if (text.trim()) payload.message = text;
    if (attachmentIds?.length) payload.attachment_ids = attachmentIds;
    if (replyToId) payload.reply_to_id = replyToId;
    if (!payload.message && !payload.attachment_ids) return;

    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    payload.nonce = nonce;
    // Add optimistic message BEFORE sending so the WS echo can't arrive first
    setState(prev => {
      if (!prev.currentUser) return prev;
      const optimistic: import('../types').ChatMessage = {
        id: `optimistic-${nonce}`,
        author: {
          id: prev.userIDonServer,
          username: prev.currentUser!.username,
          nickname: prev.currentUser!.nickname,
          avatar: prev.currentUser!.avatar,
          status: prev.currentUser!.status,
        },
        content: text,
        created_at: new Date().toISOString(),
        attachments: [],
        reply_to: null,
        is_pinned: false,
      };
      const msgs = [...prev.chatMessages, optimistic];
      if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
      return { ...prev, chatMessages: msgs };
    });

    const payloadStr = JSON.stringify(payload);
    let sent = false;

    if (chatWs.current?.readyState === WebSocket.OPEN) {
      try {
        chatWs.current.send(payloadStr);
        sent = true;
      } catch { /* fall through to HTTP */ }
    }

    if (!sent && state.chatConversationId) {
      fetch(`${state.currentServerIP}/api/conversations/${state.chatConversationId}/messages/send/`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${state.authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: text,
          attachment_ids: attachmentIds || [],
          reply_to_id: replyToId || null,
        }),
      }).catch(() => {});
    }
  }, [state.chatConversationId, state.currentServerIP, state.authToken]);

  const addCallMessage = useCallback((callInfo: import('../types').CallInfo) => {
    // Encode call info into a special content string so the server persists it
    const parts = [callInfo.status, callInfo.video ? 'video' : 'voice'];
    if (callInfo.duration != null) parts.push(String(callInfo.duration));
    const content = `%%call:${parts.join(':')}%%`;

    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload: Record<string, unknown> = {
      message: content,
      message_type: 'call',
      call_info: callInfo,
      nonce,
    };

    // Optimistic insert
    setState(prev => {
      if (!prev.currentUser) return prev;
      const msg: import('../types').ChatMessage = {
        id: `optimistic-${nonce}`,
        author: {
          id: prev.userIDonServer,
          username: prev.currentUser.username,
          nickname: prev.currentUser.nickname,
          avatar: prev.currentUser.avatar,
          status: prev.currentUser.status,
        },
        content,
        created_at: new Date().toISOString(),
        message_type: 'call',
        call_info: callInfo,
      };
      const msgs = [...prev.chatMessages, msg];
      if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
      return { ...prev, chatMessages: msgs };
    });

    const payloadStr = JSON.stringify(payload);
    let sent = false;
    if (chatWs.current?.readyState === WebSocket.OPEN) {
      try { chatWs.current.send(payloadStr); sent = true; } catch { }
    }
    if (!sent && state.chatConversationId) {
      fetch(`${state.currentServerIP}/api/conversations/${state.chatConversationId}/messages/send/`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${state.authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content, message_type: 'call', call_info: callInfo }),
      }).catch(() => {});
    }
  }, [state.chatConversationId, state.currentServerIP, state.authToken]);

  const deleteMessage = useCallback(async (messageId: string) => {
    await fetch(`${state.currentServerIP}/api/messages/${messageId}/`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${state.authToken}` },
    });
    // Optimistically remove from local state in case the WS event is delayed
    setState(prev => ({
      ...prev,
      chatMessages: prev.chatMessages
        .filter(m => m.id !== messageId)
        .map(m => m.reply_to?.id === messageId
          ? { ...m, reply_to: { ...m.reply_to!, deleted: true } }
          : m
        ),
    }));
  }, [state.currentServerIP, state.authToken]);

  const scheduleMessage = useCallback(async (
    conversationId: string,
    text: string,
    attachmentIds: string[],
    delaySeconds: number,
    replyToId?: string,
  ): Promise<{ id: string; send_at: string } | null> => {
    try {
      const res = await fetch(
        `${state.currentServerIP}/api/conversations/${conversationId}/schedule/`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${state.authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: text,
            attachment_ids: attachmentIds,
            delay_seconds: delaySeconds,
            reply_to_id: replyToId,
          }),
        }
      );
      if (!res.ok) return null;
      return res.json();
    } catch (e) {
      reportError(e);
      return null;
    }
  }, [state.currentServerIP, state.authToken]);

  const cancelScheduledMessage = useCallback(async (scheduledId: string) => {
    await fetch(`${state.currentServerIP}/api/scheduled/${scheduledId}/`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${state.authToken}` },
    });
  }, [state.currentServerIP, state.authToken]);

  const listScheduled = useCallback(async (conversationId: string): Promise<Array<{ id: string; send_at: string; content: string }>> => {
    try {
      return await apiGet(`/api/conversations/${conversationId}/scheduled/`, state.authToken, state.currentServerIP);
    } catch (e) {
      reportError(e);
      return [];
    }
  }, [state.authToken, state.currentServerIP, apiGet]);

  const pinMessage = useCallback(async (messageId: string) => {
    await fetch(`${state.currentServerIP}/api/messages/${messageId}/pin/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.authToken}` },
    });
  }, [state.currentServerIP, state.authToken]);

  const reportMessage = useCallback(async (messageId: string) => {
    await fetch(`${state.currentServerIP}/api/messages/${messageId}/report/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.authToken}` },
    });
  }, [state.currentServerIP, state.authToken]);

  const loadOlderMessages = useCallback(async (): Promise<boolean> => {
    const convoId = state.chatConversationId;
    const firstMsg = state.chatMessages[0];
    if (!convoId || !firstMsg?.id) return false;
    try {
      const older: ChatMessage[] = await apiGet(
        `/api/conversations/${convoId}/messages/?before=${firstMsg.id}&limit=50`,
        state.authToken,
        state.currentServerIP
      );
      if (older.length === 0) return false;
      const enriched = older.map(enrichCallMessage);
      setState(prev => ({
        ...prev,
        chatMessages: [...enriched, ...prev.chatMessages],
      }));
      return true;
    } catch (e) {
      reportError(e);
      return false;
    }
  }, [state.chatConversationId, state.chatMessages, state.authToken, state.currentServerIP, apiGet]);

  // ==================== Signaling WebSocket ====================
  useEffect(() => {
    if (!state.authToken) {
      if (signalingWs.current) {
        signalingWs.current.close();
        signalingWs.current = null;
        setSignalingPeers([]);
      }
      return;
    }

    const authToken = state.authToken;
    const currentServerIP = state.currentServerIP;
    let alive = true;
    let activeWs: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (!alive) return;
      const wsUrl = currentServerIP.replace(/^http/, 'ws');
      const ws = new WebSocket(`${wsUrl}/ws/signaling/?token=${authToken}`);
      activeWs = ws;

      ws.onopen = () => {
        if (!alive) { ws.close(); return; }
        signalingWs.current = ws;
        setState(prev => prev.currentUser
          ? { ...prev, currentUser: { ...prev.currentUser, status: 'online' } }
          : prev
        );
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'peers') {
          setSignalingPeers(data.peers);
          return;
        }
        if (data.type === 'blocked') {
          const blockerId = String(data.by_user_id);
          setState(prev => ({
            ...prev,
            // Keep blocker in friends list so the conversation stays visible in the sidebar.
            // The chatBlockedByOther flag disables sending and shows the banner.
            chatBlockedByOther: blockerId === String(prev.currentChat) ? true : prev.chatBlockedByOther,
            pendingRequests: prev.pendingRequests.filter(r => String(r.id) !== blockerId),
            sentRequests: prev.sentRequests.filter(r => String(r.id) !== blockerId),
            guilds: prev.guilds.map(g => ({
              ...g,
              members: g.members.filter(m => String(m.id) !== blockerId),
            })),
            currentGuild: prev.currentGuild ? {
              ...prev.currentGuild,
              members: prev.currentGuild.members.filter(m => String(m.id) !== blockerId),
            } : null,
          }));
          return;
        }
        if (data.type === 'unblocked') {
          const unblockerId = String(data.by_user_id);
          setState(prev => ({
            ...prev,
            chatBlockedByOther: unblockerId === String(prev.currentChat) ? false : prev.chatBlockedByOther,
          }));
          // If there is no active chat WS (was blocked before any conversation existed),
          // force a reinit so the connection is established and new messages arrive.
          if (!chatWs.current) {
            setChatReinitTrigger(n => n + 1);
          }
          loadFriends();
          return;
        }
        if (data.type === 'friend-request') {
          setState(prev => {
            const already = prev.pendingRequests.some(r => r.id === data.user.id);
            return already ? prev : { ...prev, pendingRequests: [...prev.pendingRequests, data.user] };
          });
          return;
        }
        if (data.type === 'friend-removed') {
          setState(prev => ({
            ...prev,
            friends: prev.friends.filter(f => String(f.id) !== String(data.user.id)),
            currentChat: String(prev.currentChat) === String(data.user.id) ? '' : prev.currentChat,
            mobileActivePanel: String(prev.currentChat) === String(data.user.id) ? 'chat-list' as MobilePanel : prev.mobileActivePanel,
          }));
          return;
        }
        if (data.type === 'friend-request-rejected') {
          setState(prev => ({
            ...prev,
            sentRequests: prev.sentRequests.filter(u => String(u.id) !== String(data.user.id)),
          }));
          return;
        }
        if (data.type === 'friend-added') {
          setState(prev => {
            const alreadyFriend = prev.friends.some(f => String(f.id) === String(data.user.id));
            return {
              ...prev,
              friends: alreadyFriend ? prev.friends : [...prev.friends, data.user],
              sentRequests: prev.sentRequests.filter(u => String(u.id) !== String(data.user.id)),
            };
          });
          return;
        }
        if (data.type === 'status_update') {
          pendingStatusRef.current[String(data.user_id)] = data.status;
          setState(prev => ({
            ...prev,
            friends: prev.friends.map(f =>
              String(f.id) === String(data.user_id) ? { ...f, status: data.status } : f
            ),
          }));
          return;
        }
        if (data.type === 'new_message_notification') {
          if ((window as any).AndroidBridge) {
            (window as any).AndroidBridge.showMessageNotification(
              data.sender_name || '',
              data.content || ''
            );
          }
          return;
        }
        if (data.type === 'profile_update' && data.user) {
          const u = data.user;
          const avatarUrl = u.avatar ? `${currentServerIP}${u.avatar}` : '';
          setState(prev => {
            const updatedUser = { ...u, avatar: avatarUrl };
            return {
              ...prev,
              // Update currentUser if it's the same person (self-update)
              currentUser: prev.currentUser && String(prev.currentUser.id) === String(u.id)
                ? { ...prev.currentUser, ...updatedUser }
                : prev.currentUser,
              // Update in friends list
              friends: prev.friends.map(f =>
                String(f.id) === String(u.id) ? { ...f, ...updatedUser } : f
              ),
              // Update in guilds member lists
              guilds: prev.guilds.map(g => ({
                ...g,
                members: g.members.map(m =>
                  String(m.id) === String(u.id) ? { ...m, ...updatedUser } : m
                ),
              })),
              currentGuild: prev.currentGuild ? {
                ...prev.currentGuild,
                members: prev.currentGuild.members.map(m =>
                  String(m.id) === String(u.id) ? { ...m, ...updatedUser } : m
                ),
              } : null,
            };
          });
          return;
        }
        if (data.type === 'message_pinned') {
          setState(prev => ({
            ...prev,
            chatMessages: prev.chatMessages.map(m =>
              m.id === data.id ? { ...m, is_pinned: data.is_pinned } : m
            ),
          }));
          return;
        }
        if (data.type === 'guild_kicked_direct') {
          // Kicked user receives this via their personal signaling channel
          // regardless of which screen they're currently on
          setState(prev => {
            const isSelf = String(data.user_id) === String(prev.userIDonServer);
            if (!isSelf) return prev;
            const guildId = data.guild_id;
            const guildName = data.guild_name || '';
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
          return;
        }
        if (data.type === 'offer' && data.from) {
          setState(prev => {
            if (prev.isCallActive) return prev;
            if ((window as any).AndroidBridge) {
              const callerFriend = prev.friends.find((f: any) => String(f.id) === String(data.from));
              const callerName = callerFriend?.nickname || callerFriend?.username || String(data.from);
              (window as any).AndroidBridge.showCallNotification(callerName, !!data.withVideo);
            }
            return { ...prev, incomingOffer: data };
          });
        }
        if (onSignalingMessage.current) {
          onSignalingMessage.current(data);
        }
      };

      ws.onclose = () => {
        if (signalingWs.current === ws) signalingWs.current = null;
        setState(prev => ({
          ...prev,
          incomingOffer: null,
          ...(prev.currentUser ? { currentUser: { ...prev.currentUser, status: 'offline' } } : {}),
        }));
        // Auto-reconnect after 3 seconds if still mounted and not intentionally closed
        if (alive) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {};
    };

    connect();

    return () => {
      alive = false;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      const ws = activeWs;
      if (!ws) return;
      if (signalingWs.current === ws) signalingWs.current = null;
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.onopen = () => ws.close();
        ws.onclose = () => {};
        ws.onerror = () => {};
        ws.onmessage = () => {};
      } else {
        ws.onclose = () => {};
        ws.onmessage = () => {};
        ws.close();
      }
    };
  }, [state.authToken, state.currentServerIP]);

  // ==================== Guild WebSocket ====================
  const guildChannelWs = useRef<WebSocket | null>(null);
  const guildPresenceWs = useRef<WebSocket | null>(null);

  const _connectGuildWs = useCallback((guild: Guild, channel: GuildChannel, token: string, serverIP: string) => {
    if (guildChannelWs.current) {
      guildChannelWs.current.close();
      guildChannelWs.current = null;
    }
    const wsUrl = serverIP.replace(/^http/, 'ws');
    const ws = new WebSocket(`${wsUrl}/ws/guild/${guild.id}/channel/${channel.id}/?token=${token}`);
    ws.onopen = () => { guildChannelWs.current = ws; };
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'message_deleted') {
        setState(prev => ({ ...prev, guildMessages: prev.guildMessages.filter(m => m.id !== data.id) }));
      } else if (data.type === 'message_pinned') {
        setState(prev => ({ ...prev, guildMessages: prev.guildMessages.map(m => m.id === data.id ? { ...m, is_pinned: data.is_pinned } : m) }));
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
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          return { ...prev, currentGuild: { ...prev.currentGuild, channels: prev.currentGuild.channels.filter(c => c.id !== data.channel_id) } };
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
      } else if (data.type === 'voice_presence_update') {
        setState(prev => ({
          ...prev,
          voiceChannelParticipants: {
            ...prev.voiceChannelParticipants,
            [data.channel_id]: data.participants,
          },
        }));
      } else {
        // Regular chat message — replace matching optimistic or append (skip exact duplicate)
        const msg: GuildMessage = data;
        setState(prev => {
          if (prev.guildMessages.some(m => m.id === msg.id)) return prev;
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
            msgs = [...prev.guildMessages];
            msgs[optIdx] = msg;
          } else {
            msgs = [...prev.guildMessages, msg];
          }
          if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
          return { ...prev, guildMessages: msgs };
        });
      }
    };
    ws.onclose = () => { if (guildChannelWs.current === ws) guildChannelWs.current = null; };
  }, []);

  const _connectGuildPresenceWs = useCallback((guild: Guild, token: string, serverIP: string) => {
    if (guildPresenceWs.current) { guildPresenceWs.current.close(); guildPresenceWs.current = null; }
    const wsUrl = serverIP.replace(/^http/, 'ws');
    const ws = new WebSocket(`${wsUrl}/ws/guild/${guild.id}/?token=${token}`);
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
        setState(prev => {
          if (!prev.currentGuild || prev.currentGuild.id !== guild.id) return prev;
          return { ...prev, currentGuild: { ...prev.currentGuild, channels: prev.currentGuild.channels.filter(c => c.id !== data.channel_id) } };
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
      } else if (data.type === 'voice_presence_update') {
        setState(prev => ({
          ...prev,
          voiceChannelParticipants: { ...prev.voiceChannelParticipants, [data.channel_id]: data.participants },
        }));
      }
    };
    ws.onclose = () => { if (guildPresenceWs.current === ws) guildPresenceWs.current = null; };
  }, []);

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
    if (guildChannelWs.current) { guildChannelWs.current.close(); guildChannelWs.current = null; }
    if (guildPresenceWs.current) { guildPresenceWs.current.close(); guildPresenceWs.current = null; }
  }, [state.authToken, state.currentServerIP]);

  const deleteGuild = useCallback(async (guildId: string) => {
    await fetch(`${state.currentServerIP}/api/guilds/${guildId}/`, {
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
    if (guildChannelWs.current) { guildChannelWs.current.close(); guildChannelWs.current = null; }
    if (guildPresenceWs.current) { guildPresenceWs.current.close(); guildPresenceWs.current = null; }
  }, [state.authToken, state.currentServerIP]);

  const updateGuild = useCallback(async (guildId: string, data: { name?: string; description?: string; tag?: string; icon?: File | null; banner?: File | null; removeIcon?: boolean; removeBanner?: boolean; boost_level?: number; verification_level?: string; default_notifications?: string; explicit_content_filter?: string; require_2fa?: boolean }) => {
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
      const mapMembers = (members: typeof prev.currentGuild!.members) =>
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

  const createChannel = useCallback(async (guildId: string, name: string, type: 'text' | 'voice' = 'text') => {
    await apiPost(`/api/guilds/${guildId}/channels/`, state.authToken, state.currentServerIP, { name, type });
  }, [state.authToken, state.currentServerIP, apiPost]);

  const deleteChannel = useCallback(async (guildId: string, channelId: string) => {
    await fetch(`${state.currentServerIP}/api/guilds/${guildId}/channels/${channelId}/`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${state.authToken}` },
    });
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
  }, [_connectGuildWs, _connectGuildPresenceWs]);

  const selectGuildChannel = useCallback((channel: GuildChannel) => {
    setState(prev => {
      if (!prev.currentGuild) return prev;
      if (prev.currentGuildChannel?.id !== channel.id) {
        _connectGuildWs(prev.currentGuild, channel, prev.authToken, prev.currentServerIP);
      }
      return { ...prev, currentGuildChannel: channel, guildMessages: prev.currentGuildChannel?.id === channel.id ? prev.guildMessages : [], mobileActivePanel: 'guild-chat' as MobilePanel };
    });
  }, [_connectGuildWs]);

  // Load guild channel message history when channel changes
  useEffect(() => {
    if (!state.currentGuild || !state.currentGuildChannel || !state.authToken) return;
    const { id: guildId } = state.currentGuild;
    const { id: channelId } = state.currentGuildChannel;
    apiGet(`/api/guilds/${guildId}/channels/${channelId}/messages/`, state.authToken, state.currentServerIP)
      .then((msgs: GuildMessage[]) => setState(prev => {
        // Merge: keep any WS messages that arrived after the REST snapshot
        const ids = new Set(msgs.map(m => m.id));
        const extra = prev.guildMessages.filter(m => !ids.has(m.id));
        const merged = [...msgs, ...extra].sort((a, b) => a.created_at.localeCompare(b.created_at));
        return { ...prev, guildMessages: merged };
      }))
      .catch(reportError);
  }, [state.currentGuildChannel?.id]);

  const sendGuildMessage = useCallback((text: string, replyToId?: string, attachmentIds?: string[]) => {
    if (guildChannelWs.current?.readyState !== WebSocket.OPEN) return;
    const payload: Record<string, unknown> = { message: text };
    if (replyToId) payload.reply_to_id = replyToId;
    if (attachmentIds?.length) payload.attachment_ids = attachmentIds;
    guildChannelWs.current.send(JSON.stringify(payload));
    setState(prev => {
      if (!prev.currentUser) return prev;
      const optimistic: import('../types').GuildMessage = {
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
        attachments: [],
        reply_to: null,
        is_pinned: false,
      };
      const msgs = [...prev.guildMessages, optimistic];
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
        `/api/guilds/${state.currentGuild.id}/channels/${state.currentGuildChannel.id}/messages/?before=${firstMsg.id}&limit=50`,
        state.authToken, state.currentServerIP
      );
      if (older.length === 0) return false;
      setState(prev => ({ ...prev, guildMessages: [...older, ...prev.guildMessages] }));
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
    if (voiceWs.current) {
      voiceWs.current.close();
      voiceWs.current = null;
    }
    setState(prev => ({ ...prev, currentVoiceChannel: channel, voiceParticipants: [] }));

    const wsUrl = state.currentServerIP.replace(/^http/, 'ws');
    const guildId = state.currentGuild?.id;
    if (!guildId) return;
    const ws = new WebSocket(`${wsUrl}/ws/guild/${guildId}/voice/${channel.id}/?token=${state.authToken}`);
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
  }, [state.currentServerIP, state.authToken, state.currentGuild?.id]);

  const leaveVoiceChannel = useCallback(() => {
    voiceWs.current?.close();
    voiceWs.current = null;
    setState(prev => ({ ...prev, currentVoiceChannel: null, voiceParticipants: [] }));
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
  }, [state.authToken]);

  const sendSignal = (data: any) => {
    const ws = signalingWs.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  };

  // ==================== localStorage effects ====================
  useEffect(() => {
    if (state.theme === 'dark') {
      document.body.classList.add('dark-theme');
    } else {
      document.body.classList.remove('dark-theme');
    }
    localStorage.setItem('messengerTheme', state.theme);
    applyAccent(localStorage.getItem('accentColor') || DEFAULT_ACCENT);
  }, [state.theme]);

  useEffect(() => { localStorage.setItem('messengerCurrentServer', state.currentServer); }, [state.currentServer]);
  useEffect(() => { localStorage.setItem('messengerCurrentChat', state.currentChat); }, [state.currentChat]);
  useEffect(() => { localStorage.setItem('messengerCurrentChannel', state.currentChannel); }, [state.currentChannel]);
  useEffect(() => { localStorage.setItem('messengerLanguage', state.language); }, [state.language]);

  // ==================== Cleanup on page refresh/close ====================
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (signalingWs.current?.readyState === WebSocket.OPEN) {
        if (callTargetIdRef.current) {
          signalingWs.current.send(JSON.stringify({ type: 'call-end', to: callTargetIdRef.current }));
        }
        signalingWs.current.close();
        signalingWs.current = null;
      }
      if (voiceWs.current?.readyState === WebSocket.OPEN) {
        voiceWs.current.close();
        voiceWs.current = null;
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // ==================== State setters ====================
  const setCurrentView = (view: ViewType) => setState(prev => ({ ...prev, currentView: view }));

  const setCurrentServer = (serverId: string) => {
    const isLeavingServer = serverId === 'home' || serverId === 'settings';
    setState(prev => ({
      ...prev,
      currentServer: serverId,
      currentView: serverId === 'home' ? 'home' : serverId === 'settings' ? 'settings' : 'server',
      currentChat: serverId === 'home' ? '' : prev.currentChat,
      isMobileSidebarOpen: false,
      mobileActivePanel: 'chat-list' as MobilePanel,
      // Clear guild state when navigating away from server view
      ...(isLeavingServer ? { currentGuild: null, currentGuildChannel: null, guildMessages: [] } : {}),
    }));
  };

  const setCurrentChat = (chatId: string) => {
    setState(prev => ({ ...prev, currentChat: chatId, currentView: 'home', currentServer: 'home', mobileActivePanel: 'chat-view' as MobilePanel }));
  };

  const setCurrentChannel = (channel: string) => setState(prev => ({ ...prev, currentChannel: channel }));

  const setCurrentSettingsPage = (page: string) => {
    setState(prev => ({ ...prev, currentSettingsPage: page, mobileActivePanel: 'chat-view' as MobilePanel }));
  };

  const toggleTheme = () => setState(prev => ({ ...prev, theme: prev.theme === 'dark' ? 'light' : 'dark' }));
  const setLanguage = (lang: string) => {
    setState(prev => ({ ...prev, language: lang }));
    localStorage.setItem('messengerLanguage', lang);
  };
  const toggleMobileSidebar = () => setState(prev => ({ ...prev, isMobileSidebarOpen: !prev.isMobileSidebarOpen }));
  const setMobileActivePanel = (panel: MobilePanel) => setState(prev => ({ ...prev, mobileActivePanel: panel }));
  const setCallActive = (active: boolean) => setState(prev => ({ ...prev, isCallActive: active }));
  const setDemonstrationActive = (v: boolean) => setState(prev => ({ ...prev, isDemonstrationActive: v }));
  const setVideoActive = (v: boolean) => setState(prev => ({ ...prev, isVideoActive: v }));
  const setMicActive = (v: boolean) => setState(prev => ({ ...prev, isMicActive: v }));
  const setHeadphonesActive = (v: boolean) => {
    setState(prev => ({ ...prev, isHeadphonesActive: v }));
    if (voiceWs.current?.readyState === WebSocket.OPEN) {
      voiceWs.current.send(JSON.stringify({ type: 'voice_deafen', deafened: !v }));
    }
  };
  const setSpeakersActive = useCallback((v: Array<string>) => setState(prev => ({ ...prev, SpeakersActive: v })), []);
  const setCallStatus = (s: 'active' | 'ringing' | 'connection' | 'inactive') => setState(prev => ({ ...prev, callStatus: s }));
  const setCurrentServerIP = (ip: string) => setState(prev => ({ ...prev, currentServerIP: ip }));
  const setUserIDonServer = (id: string) => setState(prev => ({ ...prev, userIDonServer: id }));
  const setCallTargetId = (id: string | null) => {
    callTargetIdRef.current = id;
    setState(prev => ({ ...prev, callTargetId: id }));
  };
  const setIncomingOffer = (offer: any | null) => setState(prev => ({ ...prev, incomingOffer: offer }));

  const setCurrentUser = (user: ServerUser) => setState(prev => ({ ...prev, currentUser: user }));

  const setAuthToken = (token: string) => {
    localStorage.setItem('authToken', token);
    if (!token) {
      // Logout — close all sockets and reset to clean state
      signalingWs.current?.close();
      signalingWs.current = null;
      guildChannelWs.current?.close();
      guildChannelWs.current = null;
      voiceWs.current?.close();
      voiceWs.current = null;
      voiceLocalStream.current?.getTracks().forEach(t => t.stop());
      voiceLocalStream.current = null;
      voiceSignalHandler.current = null;
      localStorage.removeItem('messengerCurrentServer');
      localStorage.removeItem('messengerCurrentChat');
      localStorage.removeItem('messengerCurrentChannel');
      setState(prev => ({
        ...prev,
        authToken: '',
        currentUser: null,
        friends: [],
        blockedContacts: [],
        pendingRequests: [],
        sentRequests: [],
        chatMessages: [],
        chatConversationId: null,
        chatBlockedByOther: false,
        customEmojis: [],
        guilds: [],
        currentGuild: null,
        currentGuildChannel: null,
        guildMessages: [],
        currentVoiceChannel: null,
        voiceParticipants: [],
        voiceChannelParticipants: {},
        currentView: 'home',
        currentServer: 'home',
        currentChat: '',
        callTargetId: null,
        incomingOffer: null,
        isCallActive: false,
        isDemonstrationActive: false,
        isVideoActive: false,
        isMicActive: true,
        isHeadphonesActive: true,
        callStatus: 'inactive',
      }));
    } else {
      setState(prev => ({ ...prev, authToken: token }));
    }
  };

  return (
    <AppContext.Provider value={{
      ...state,
      setCurrentView,
      setCurrentServer,
      setCurrentChat,
      setCurrentChannel,
      setCurrentSettingsPage,
      toggleTheme,
      setLanguage,
      toggleMobileSidebar,
      setMobileActivePanel,
      setCallActive,
      setDemonstrationActive,
      setVideoActive,
      setMicActive,
      setHeadphonesActive,
      setSpeakersActive,
      setCallStatus,
      setCurrentServerIP,
      setUserIDonServer,
      setAuthToken,
      setCallTargetId,
      setIncomingOffer,
      signalingWs,
      sendSignal,
      signalingPeers,
      onSignalingMessage,
      loadFriends,
      loadPendingRequests,
      removeFriend,
      blockUser,
      unblockUser,
      removeBlockedContact,
      setAccentColor,
      sendFriendRequest,
      acceptFriendRequest,
      rejectFriendRequest,
      searchUsers,
      sendChatMessage,
      addCallMessage,
      deleteMessage,
      pinMessage,
      reportMessage,
      loadOlderMessages,
      loadCustomEmojis,
      scheduleMessage,
      cancelScheduledMessage,
      listScheduled,
      showError,
      clearError,
      errorMessage,
      toasts,
      dismissToast,
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
      joinGuild,
      leaveGuild,
      deleteGuild,
      kickMember,
      setMemberRole,
      createChannel,
      deleteChannel,
      selectGuild,
      selectGuildChannel,
      sendGuildMessage,
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
      setCurrentUser,
    }}>
      {children}
    </AppContext.Provider>
  );
};
