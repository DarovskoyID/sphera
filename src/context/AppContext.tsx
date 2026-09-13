import React, { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import type { AppState, ViewType, MobilePanel, ServerUser, PendingRequest, ChatMessage } from '../types';
import type { CustomEmoji } from '../types';
import type { LocationPayload, RichMessageType } from '../types';

/** Where a rich message lives: a DM conversation or a guild channel. */
export type RichScope =
  | { kind: 'dm'; conversationId: string }
  | { kind: 'guild'; guildId: string; channelId: string };
import { loadSelectedServer, wsUrlFor } from '../config/network';
import { saveNotifPrefs, getNotifPrefs, showDesktopNotification, showCallNotification, playMessageSound, ensureNotificationPermission } from '../utils/notifications';
import { saveA11yPrefs, announce as announceA11y, type A11yPrefs } from '../utils/accessibility';
import { saveDisplayPrefs } from '../utils/displayPrefs';
import { saveCensorConfig, setCensorAudience, scopeFromScanFlags } from '../utils/censor';
import { sortByDate, insertByDate } from '../utils/messageOrder';
import { clearMessageCache, readCachedMessages, writeCachedMessages } from '../utils/messageCache';
import { postNativeTheme, setNativePrefs } from '../utils/nativeBridge';
import { deviceQuery } from '../utils/device';
import { toUserMessage, readResponse, setErrorLang } from '../utils/errorManager';
import { publishWs } from '../sdk/wsBus';
import { runLifecycle } from '../sdk/lifecycle';
import { isBusy } from '../sdk/runtime';


// ── Inject X-Ionik-Client header into every fetch ────────────────────────────
// Prevents direct browser access to the server (the server rejects requests
// without this header, returning an empty 200 response instead).
const _origFetch = window.fetch.bind(window);
let _authRefreshHandler: (() => Promise<string | null>) | null = null;
const AUTH_TOKEN_KEY = 'authToken';

function getFetchUrl(input: RequestInfo | URL): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

function hasBearerAuth(input: RequestInfo | URL, init?: RequestInit): boolean {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers as HeadersInit | undefined).forEach((value, key) => headers.set(key, value));
  return (headers.get('Authorization') || '').startsWith('Bearer ');
}

function withBearerAuth(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

(window as unknown as { fetch: typeof fetch }).fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers as HeadersInit | undefined).forEach((value, key) => headers.set(key, value));
  headers.set('X-Ionik-Client', '1');
  const nextInit = { credentials: 'include' as RequestCredentials, ...init, headers };
  return _origFetch(input, nextInit).then(async (res) => {
    const url = getFetchUrl(input);
    if (
      res.status !== 401 ||
      url.includes('/api/auth/refresh/') ||
      !hasBearerAuth(input, nextInit) ||
      !_authRefreshHandler
    ) {
      return res;
    }
    const nextToken = await _authRefreshHandler();
    if (!nextToken) return res;
    return _origFetch(input, withBearerAuth(nextInit, nextToken));
  });
};

function jwtExpiresSoon(token: string, skewSeconds = 60): boolean {
  try {
    const raw = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = raw.padEnd(raw.length + ((4 - raw.length % 4) % 4), '=');
    const payload = JSON.parse(atob(padded));
    return typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now() + skewSeconds * 1000;
  } catch {
    return true;
  }
}

function wsProtocols(token: string): string[] {
  return ['ionik.jwt', token];
}

// ── Global error interception ────────────────────────────────────────────────
// Captures errors before the context mounts, then drains them once it's ready.
const _errorQueue: string[] = [];
let _errorSink: ((msg: string) => void) | null = null;
let _guildBackGuardTimer: ReturnType<typeof setTimeout> | null = null;

function _dispatch(msg: string) {
  if (_errorSink) {
    _errorSink(msg);
  } else if (!_errorQueue.includes(msg)) {
    _errorQueue.push(msg);
  }
}

function armGuildBackGuard() {
  document.documentElement.classList.add('guild-back-guard');
  if (_guildBackGuardTimer) clearTimeout(_guildBackGuardTimer);
  _guildBackGuardTimer = setTimeout(() => {
    document.documentElement.classList.remove('guild-back-guard');
    _guildBackGuardTimer = null;
  }, 500);
}

export function reportError(e: unknown) {
  // Everything funnels through the error manager: raw technical messages are
  // localised and the main server's address is stripped before display.
  _dispatch(toUserMessage(e));
}

console.error = (...args: unknown[]) => {
  const raw = args.map(a => (a instanceof Error ? a.message : String(a))).join(' ');
  _dispatch(toUserMessage(raw));
};

// Intercept uncaught errors
window.addEventListener('error', (e) => {
  _dispatch(toUserMessage(e.error ?? e.message ?? e));
});

// Intercept unhandled promise rejections
window.addEventListener('unhandledrejection', (e) => {
  _dispatch(toUserMessage(e.reason ?? 'Unhandled rejection'));
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
  // Exposed as bare channels so stylesheets can tint with the accent at any
  // opacity — `rgba(var(--accent-rgb), .12)` — which `var(--accent-primary)`
  // alone cannot do.
  document.documentElement.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
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
  /** For modules: shallow-merge core state (navigation, panels). */
  patchState: (patch: Partial<AppState>) => void;
  logout: () => void;
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
  sendRichMessage: (scope: RichScope, type: RichMessageType, payload: Record<string, unknown>, tags?: string[]) => Promise<void>;
  toggleTodoItem: (scope: RichScope, messageId: string, itemId: string) => Promise<void>;
  editMessage: (scope: RichScope, messageId: string, body: { content?: string; payload?: Record<string, unknown> }) => Promise<void>;
  pushLiveLocation: (scope: RichScope, messageId: string, body: { lat?: number; lng?: number; stop?: boolean }) => Promise<void>;
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
    const savedToken = localStorage.getItem(AUTH_TOKEN_KEY) || '';

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
      friendsLoaded: false,
      blockedContacts: [],
      pendingRequests: [],
      sentRequests: [],
      callTargetId: null,
      incomingOffer: null,
      chatMessages: [],
      chatConversationId: null,
      chatBlockedByOther: false,
      chatLoading: false,
      customEmojis: [],
    };
  });

  // Server IP is now user-selected via ServerSelector

  const signalingWs = useRef<WebSocket | null>(null);
  const callTargetIdRef = useRef<string | null>(null);
  const [signalingPeers, setSignalingPeers] = useState<Array<{ id: string; name: string }>>([]);
  const onSignalingMessage = useRef<((msg: any) => void) | null>(null);
  const pendingStatusRef = useRef<Record<string, string>>({});
  const selfRef = useRef<{ id: string; username: string; nickname: string }>({ id: '', username: '', nickname: '' });
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
  const authTokenRef = useRef(state.authToken);
  const currentServerIPRef = useRef(state.currentServerIP);
  const refreshPromiseRef = useRef<Promise<string | null> | null>(null);
  const chatLastMsgId = useRef<string | null>(null);
  // Tombstones for just-deleted DM messages. Deleting a media message is slow
  // server-side (it wipes attachment files from disk), so the REST poll can
  // still return it mid-delete and "resurrect" it. We suppress those ids.
  const deletedChatMsgIds = useRef<Set<string>>(new Set());
  const [chatReinitTrigger, setChatReinitTrigger] = useState(0);

  useEffect(() => { authTokenRef.current = state.authToken; }, [state.authToken]);
  useEffect(() => { currentServerIPRef.current = state.currentServerIP; }, [state.currentServerIP]);

  const refreshAccessToken = useCallback(async (): Promise<string | null> => {
    if (refreshPromiseRef.current) return refreshPromiseRef.current;

    refreshPromiseRef.current = _origFetch(`${currentServerIPRef.current}/api/auth/refresh/`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Ionik-Client': '1' },
    })
      .then(async (res) => {
        if (!res.ok) return null;
        const data = await res.json();
        const access = typeof data.access === 'string' ? data.access : '';
        if (!access) return null;
        localStorage.setItem(AUTH_TOKEN_KEY, access);
        authTokenRef.current = access;
        setState(prev => ({ ...prev, authToken: access }));
        return access;
      })
      .catch(() => null)
      .finally(() => {
        refreshPromiseRef.current = null;
      });

    return refreshPromiseRef.current;
  }, []);

  useEffect(() => {
    _authRefreshHandler = refreshAccessToken;
    return () => {
      if (_authRefreshHandler === refreshAccessToken) _authRefreshHandler = null;
    };
  }, [refreshAccessToken]);

  useEffect(() => {
    if (!state.authToken) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (cancelled) return;
      if (jwtExpiresSoon(authTokenRef.current, 90)) {
        refreshAccessToken().finally(() => {
          timer = setTimeout(schedule, 60_000);
        });
      } else {
        timer = setTimeout(schedule, 60_000);
      }
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [state.authToken, refreshAccessToken]);

  // ==================== Logout helper ====================
  const logout = useCallback(() => {
    _origFetch(`${currentServerIPRef.current}/api/auth/logout/`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Ionik-Client': '1' },
    }).catch(() => undefined);
    localStorage.removeItem(AUTH_TOKEN_KEY);
    // The message cache is plain text on the device; a session ending is
    // exactly when it must stop existing.
    void clearMessageCache();
    void runLifecycle('logout');
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
    return readResponse(res, { serverIP, onUnauthorized: logout });
  }, [logout]);

  const apiPost = useCallback(async (path: string, token: string, serverIP: string, body: any) => {
    const res = await fetch(`${serverIP}${path}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return readResponse(res, { serverIP, onUnauthorized: logout });
  }, [logout]);

  // ==================== Load user info after login ====================
  useEffect(() => {
    if (!state.authToken) {
      setState(prev => ({ ...prev, currentUser: null, friends: [], pendingRequests: [], sentRequests: [], userIDonServer: '', currentChat: '' }));
      return;
    }
    const load = async () => {
      try {
        const user: ServerUser = await apiGet(`/api/auth/me/?${deviceQuery()}`, state.authToken, state.currentServerIP);
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
        setState(prev => ({ ...prev, friends: merged, blockedContacts, friendsLoaded: true }));
      } catch (e) {
        // Settled either way. An empty list the reader can act on beats a
        // skeleton that shimmers forever because one request failed — and an
        // account with no friends yet has nothing else coming that would set
        // this, so it would shimmer for the whole session.
        setState(prev => ({ ...prev, friendsLoaded: true }));
        reportError(e);
      }
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
      // Mirror notification + accessibility prefs locally so the WS handlers
      // and the global a11y layer respect them without re-fetching.
      try {
        const cfg: any = await apiGet('/api/auth/settings/', state.authToken, state.currentServerIP);
        saveNotifPrefs({
          enable_all_notifications: cfg.enable_all_notifications,
          notify_direct_messages: cfg.notify_direct_messages,
          notify_mentions: cfg.notify_mentions,
          notify_all_server_messages: cfg.notify_all_server_messages,
          notify_friend_requests: cfg.notify_friend_requests,
          sound_message: cfg.sound_message,
          sound_incoming_call: cfg.sound_incoming_call,
          streamer_disable_notifs: !!cfg.streamer_mode && !!cfg.streamer_disable_notifs,
        });
        saveDisplayPrefs({
          chat_show_timestamps: cfg.chat_show_timestamps,
          chat_emoji_reactions: cfg.chat_emoji_reactions,
          chat_compact_mode: cfg.chat_compact_mode,
          streamer_mode: cfg.streamer_mode,
          streamer_hide_info: cfg.streamer_hide_info,
        });
        saveCensorConfig({
          blur_enabled: cfg.blur_enabled,
          blur_profanity: cfg.blur_profanity,
          blur_calls_to_action: cfg.blur_calls_to_action,
          blur_code_requests: cfg.blur_code_requests,
          blur_disable_requests: cfg.blur_disable_requests,
          explicit_scope: scopeFromScanFlags(cfg),
        });
        setNativePrefs({
          allowScale: !!cfg.allow_scale,
          pushNotifications: cfg.native_push_notifications !== false,
          haptics: cfg.native_haptics !== false,
          keepScreenOn: cfg.native_keep_screen_on !== false,
          immersive: !!cfg.native_immersive,
        });
        const a11y: Partial<A11yPrefs> = {};
        (['high_contrast', 'screen_reader', 'reduce_motion', 'large_text', 'keyboard_outlines'] as const)
          .forEach(k => { if (typeof cfg[k] === 'boolean') (a11y as any)[k] = cfg[k]; });
        saveA11yPrefs(a11y);
        if (getNotifPrefs().enable_all_notifications) ensureNotificationPermission();
      } catch (e) { reportError(e); }
    };
    load();
  }, [state.authToken, state.currentServerIP]);

  // Tell the content filter who the reader is and who their friends are, so the
  // "explicit content from non-friends only" scope can be resolved at render.
  useEffect(() => {
    setCensorAudience(
      state.currentUser ? String(state.currentUser.id) : '',
      state.friends.map(f => String(f.id)),
    );
  }, [state.currentUser, state.friends]);

  // Keep a ref of the logged-in user for use inside stable WS callbacks.
  useEffect(() => {
    const u = state.currentUser;
    selfRef.current = {
      id: u ? String(u.id) : '',
      username: u?.username || '',
      nickname: u?.nickname || '',
    };
  }, [state.currentUser]);

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

    (window as any).sferaOnFcmToken = registerToken;

    // Request the token from Android if the bridge is available
    if ((window as any).AndroidBridge?.requestFcmToken) {
      (window as any).AndroidBridge.requestFcmToken();
    }

    return () => { (window as any).sferaOnFcmToken = undefined; };
  }, [state.authToken, state.currentServerIP]);

  // ==================== Friends actions ====================
  const loadFriends = useCallback(async () => {
    try {
      const friends: ServerUser[] = await apiGet('/api/auth/friends/', state.authToken, state.currentServerIP);
      setState(prev => ({ ...prev, friends, friendsLoaded: true }));
    } catch (e) {
      // Mark it settled either way: an empty list the reader can act on beats a
      // skeleton that shimmers forever because one request failed.
      setState(prev => ({ ...prev, friendsLoaded: true }));
      reportError(e);
    }
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
      };
    });
    publishWs('signaling', { type: 'local:user_blocked', user_id: String(userId) });
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
    // A bot has nobody to accept a request, so the server links it straight
    // away — showing it under "sent requests" would be a lie that never clears.
    const isBot = user?.account_type === 'bot' || !!user?.username?.endsWith('_bot');
    if (user) {
      setState(prev => (isBot
        ? {
          ...prev,
          friends: prev.friends.some(f => String(f.id) === String(userId))
            ? prev.friends
            : [...prev.friends, user],
        }
        : {
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
      setState(prev => ({
        ...prev, chatMessages: [], chatConversationId: null,
        chatBlockedByOther: false, chatLoading: false,
      }));
      return;
    }

    // setCurrentChat already clears the outgoing conversation, but the chat can
    // also change from a notification tap or a re-init, so the guarantee is
    // repeated here for whatever path got us in.
    setState(prev => (
      prev.chatConversationId === null && prev.chatMessages.length === 0
        ? (prev.chatLoading ? prev : { ...prev, chatLoading: true })
        : { ...prev, chatMessages: [], chatConversationId: null, chatBlockedByOther: false, chatLoading: true }
    ));

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
          setState(prev => ({
            ...prev, chatBlockedByOther: true, chatMessages: [],
            chatConversationId: null, chatLoading: false,
          }));
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
        // Start the history request before touching the cache, so the round
        // trip and the disk read overlap. Reading IndexedDB is quick, but it is
        // not free, and it would be a poor trade to delay the authoritative
        // answer in order to paint a placeholder sooner.
        const history = apiGet(
          `/api/conversations/${convoId}/messages/`,
          state.authToken,
          state.currentServerIP
        );
        // Awaited below, but not on every path out of here — a cancelled effect
        // returns first. Mark it handled so a failure on that path is not an
        // unhandled rejection.
        void history.catch(() => {});

        // Paint the tail we already have while that is in flight. The fetch
        // replaces what it covers, so a cached message deleted meanwhile lives
        // for one round-trip and no longer.
        const cached = await readCachedMessages(convoId);
        if (cancelled) return;
        setState(prev => (
          prev.chatMessages.length
            ? { ...prev, chatConversationId: convoId }
            : {
              ...prev,
              chatConversationId: convoId,
              chatMessages: cached ? cached.map(enrichCallMessage) : prev.chatMessages,
              chatLoading: !cached,
            }
        ));

        const msgs: ChatMessage[] = await history;
        if (cancelled) return;
        setState(prev => ({ ...prev, chatMessages: msgs.map(enrichCallMessage), chatLoading: false }));
        // Seed the last-ID ref so polling knows where to start
        const last = msgs.filter(m => !String(m.id).startsWith('optimistic-')).at(-1);
        if (last) chatLastMsgId.current = String(last.id);

        // Connect chat WebSocket (with auto-reconnect on unexpected close)
        const wsUrl = wsUrlFor(state.currentServerIP);
        let isFirstConnect = true;

        const connectChatWs = () => {
          if (cancelled) return;
          const ws = new WebSocket(`${wsUrl}/ws/chat/${convoId}/`, wsProtocols(state.authToken));

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
                    const merged = sortByDate([...freshMsgs, ...lateWsMsgs]);
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
            publishWs('chat', data);
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
              deletedChatMsgIds.current.add(String(data.id));
              setState(prev => ({
                ...prev,
                chatMessages: prev.chatMessages
                  .filter(m => m.id !== data.id)
                  .map(m => m.reply_to?.id === data.id
                    ? { ...m, reply_to: { ...m.reply_to!, deleted: true } }
                    : m
                  ),
              }));
            } else if (data.type === 'message_blocked') {
              // Anti-scam filter refused our message (a code someone asked for).
              // Keep it on screen, marked as not delivered.
              const id = `optimistic-${data.nonce}`;
              setState(prev => ({
                ...prev,
                chatMessages: prev.chatMessages.map(m => m.id === id ? { ...m, blocked_reason: data.reason || 'verification_code' } : m),
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
            } else if (data.type === 'todo_update') {
              setState(prev => ({
                ...prev,
                chatMessages: prev.chatMessages.map(m =>
                  String(m.id) === String(data.message_id) ? { ...m, payload: data.todo } : m
                ),
              }));
            } else if (data.type === 'location_update') {
              setState(prev => ({
                ...prev,
                chatMessages: prev.chatMessages.map(m =>
                  String(m.id) === String(data.message_id) ? { ...m, payload: data.location } : m
                ),
              }));
            } else if (data.type === 'message_edited') {
              const upd = data.message || {};
              setState(prev => ({
                ...prev,
                chatMessages: prev.chatMessages.map(m =>
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
            } else {
              // Drop frames that aren't a message (see the guild handler): an
              // author-less object in the list crashes the renderer.
              if (!data || typeof data !== 'object' || !data.id || !data.author) return;
              const msg: ChatMessage = enrichCallMessage(data);
              // Notify + ping for messages from the other party (not our own echo).
              const fromSelf = String(msg.author?.id) === String(state.userIDonServer);
              if (!fromSelf && !String(msg.id).startsWith('optimistic-')) {
                const sender = msg.author?.nickname || msg.author?.username || 'New message';
                showDesktopNotification('dm', sender, msg.content || '');
                playMessageSound();
              }
              setState(prev => {
                if (prev.chatMessages.some(m => String(m.id) === String(msg.id))) return prev;
                // Realtime broadcasts carry only reply_to_id (the full reply_to
                // object is filled in by the REST reload). Resolve the preview
                // from messages we already have so it shows without a refresh.
                if (!msg.reply_to) {
                  const rid = (data as { reply_to_id?: string }).reply_to_id;
                  if (rid) {
                    const target = prev.chatMessages.find(m => String(m.id) === String(rid));
                    if (target) {
                      msg.reply_to = {
                        id: String(target.id),
                        content: target.content,
                        author: { id: String(target.author.id), username: target.author.username, nickname: target.author.nickname },
                      };
                    }
                  }
                }
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
                  // Keep the reply preview we resolved optimistically if the echo lacks it.
                  if (!msg.reply_to && prev.chatMessages[optIdx].reply_to) {
                    msg.reply_to = prev.chatMessages[optIdx].reply_to;
                  }
                  msgs = [...prev.chatMessages];
                  msgs[optIdx] = msg;
                } else {
                  msgs = insertByDate(prev.chatMessages, msg);
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
            const polledRaw: ChatMessage[] = (Array.isArray(body) ? body : (body?.results ?? [])).map(enrichCallMessage);
            if (!polledRaw.length || cancelled) return;
            // Drop just-deleted messages so a slow (media) delete can't be
            // resurrected by a poll that raced the server-side file cleanup.
            const polled = polledRaw.filter(m => !deletedChatMsgIds.current.has(String(m.id)));

            setState(prev => {
              const now = Date.now();
              const realIds = new Set(prev.chatMessages.filter(m => !String(m.id).startsWith('optimistic-')).map(m => String(m.id)));
              const fresh = polled.filter(m => !realIds.has(String(m.id)));
              const polledById = new Map(polled.map(m => [String(m.id), m]));
              const polledIds = new Set(polled.map(m => String(m.id)));
              // Oldest message the poll window covers; only reconcile within it
              // so we never prune older history the poll didn't fetch.
              const oldestPolledTs = polled.reduce(
                (min, m) => Math.min(min, new Date(m.created_at).getTime()), Infinity,
              );

              let changed = false;
              // Single pass: heal (fill missing attachments) AND prune messages
              // the server no longer has (deleted) — this catches deletes whose
              // realtime WS event the client missed, without a manual reload.
              const base: ChatMessage[] = [];
              for (const m of prev.chatMessages) {
                if (String(m.id).startsWith('optimistic-')) { base.push(m); continue; }
                const p = polledById.get(String(m.id));
                if (p) {
                  if ((p.attachments?.length ?? 0) > 0 && (m.attachments?.length ?? 0) === 0) {
                    changed = true;
                    base.push({ ...m, ...p });
                  } else {
                    base.push(m);
                  }
                  continue;
                }
                // Present locally but absent from the poll. If it's inside the
                // polled window and had time to persist, it was deleted server-side.
                const ts = new Date(m.created_at).getTime();
                if (!polledIds.has(String(m.id)) && ts >= oldestPolledTs && (now - ts) > 8000) {
                  // Inferred server-side deletion. Don't tombstone — if this was
                  // a transient partial poll, the next poll re-adds it (self-heal).
                  changed = true;
                  continue; // prune
                }
                base.push(m);
              }

              let updated = base;
              let appended = false;
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
                  changed = true;
                } else {
                  updated.push(fm);
                  appended = true;
                  changed = true;
                }
              }
              // A polled message is not necessarily a NEW one. Deleting messages
              // slides the server's fixed-size window further back in time, so
              // the next poll hands back history this client had already
              // trimmed — appending that put old messages under today's.
              if (appended) updated = sortByDate(updated);
              // Remove any remaining stale optimistic messages
              const beforeLen = updated.length;
              updated = updated.filter(m =>
                !String(m.id).startsWith('optimistic-') ||
                (now - new Date(m.created_at).getTime()) < 10000
              );
              if (updated.length !== beforeLen) changed = true;
              if (updated.length > 500) updated.splice(0, updated.length - 500);
              return changed ? { ...prev, chatMessages: updated } : prev;
            });
          } catch { /* ignore */ }
        }, 5000);
      } catch (e) {
        // Never leave the chat stuck on its loading state because of a failed
        // request — an empty conversation is at least honest about what we have.
        if (!cancelled) setState(prev => ({ ...prev, chatLoading: false }));
        reportError(e);
      }
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
      // Resolve the reply preview for our own message so it shows immediately
      // (the server only echoes back reply_to_id, not the full object).
      let optimisticReplyTo: import('../types').ChatMessage['reply_to'] = null;
      if (replyToId) {
        const target = prev.chatMessages.find(m => String(m.id) === String(replyToId));
        if (target) {
          optimisticReplyTo = {
            id: String(target.id),
            content: target.content,
            author: { id: String(target.author.id), username: target.author.username, nickname: target.author.nickname },
          };
        }
      }
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
        reply_to: optimisticReplyTo,
        is_pinned: false,
      };
      const msgs = insertByDate(prev.chatMessages, optimistic);
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
      }).then(async res => {
        if (res.status !== 403) return;
        const body = await res.json().catch(() => ({}));
        if (body?.error !== 'code_blocked') return;
        setState(prev => ({
          ...prev,
          chatMessages: prev.chatMessages.map(m => m.id === `optimistic-${nonce}` ? { ...m, blocked_reason: 'verification_code' } : m),
        }));
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
      const msgs = insertByDate(prev.chatMessages, msg);
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
    deletedChatMsgIds.current.add(String(messageId));
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
      // Send the timestamp too: if the anchor message has since been deleted the
      // server can still resolve the cursor from it instead of giving up.
      const older: ChatMessage[] = await apiGet(
        `/api/conversations/${convoId}/messages/?before=${firstMsg.id}`
        + `&before_ts=${encodeURIComponent(firstMsg.created_at)}&limit=50`,
        state.authToken,
        state.currentServerIP
      );
      if (older.length === 0) return false;
      const enriched = older.map(enrichCallMessage);
      setState(prev => {
        // Dedupe + sort: prepending blindly is what scrambled the history when
        // the server answered an unresolvable cursor with the newest page.
        const have = new Set(prev.chatMessages.map(m => String(m.id)));
        const fresh = enriched.filter(m => !have.has(String(m.id)));
        if (!fresh.length) return prev;
        return {
          ...prev,
          chatMessages: sortByDate([...fresh, ...prev.chatMessages]),
        };
      });
      return true;
    } catch (e) {
      reportError(e);
      return false;
    }
  }, [state.chatConversationId, state.chatMessages, state.authToken, state.currentServerIP, apiGet]);

  // Persist the tail of the open conversation so the next visit paints at once.
  //
  // Debounced: a busy chat changes state many times a second, and each write
  // reads the stored tail back to merge with it — work worth doing once the
  // conversation settles, not on every keystroke's worth of state change.
  useEffect(() => {
    const convoId = state.chatConversationId;
    if (!convoId || !state.chatMessages.length) return;
    const timer = setTimeout(() => { void writeCachedMessages(convoId, state.chatMessages); }, 1500);
    return () => clearTimeout(timer);
  }, [state.chatConversationId, state.chatMessages]);

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
      const wsUrl = wsUrlFor(currentServerIP);
      const ws = new WebSocket(`${wsUrl}/ws/signaling/`, wsProtocols(authToken));
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
        publishWs('signaling', data);
        if (data.type === 'module_event') return;
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
          const fname = data.user?.nickname || data.user?.username || '';
          showDesktopNotification('friend', 'Friend request', fname);
          playMessageSound();
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
          } else {
            // Web desktop notification + sound, gated by user settings.
            showDesktopNotification('dm', data.sender_name || 'New message', data.content || '');
            playMessageSound();
            announceA11y(`${data.sender_name || ''}: ${data.content || ''}`);
          }
          return;
        }
        if (data.type === 'profile_update' && data.user) {
          const u = data.user;
          // The server already returns an absolute avatar URL — only prepend the
          // host for a relative path, or it doubles into a broken URL.
          const avatarUrl = u.avatar ? (u.avatar.startsWith('http') ? u.avatar : `${currentServerIP}${u.avatar}`) : '';
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
        if (data.type === 'offer' && data.from) {
          setState(prev => {
            if (prev.isCallActive || isBusy()) return prev;
            const callerFriend = prev.friends.find((f: any) => String(f.id) === String(data.from));
            const callerName = callerFriend?.nickname || callerFriend?.username || String(data.from);
            if ((window as any).AndroidBridge) {
              (window as any).AndroidBridge.showCallNotification(callerName, !!data.withVideo);
            } else {
              showCallNotification(callerName, !!data.withVideo);
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

  // ── Rich messages: polls / checklists / contacts / locations ───────────────

  const richHeaders = useCallback(() => ({
    Authorization: `Bearer ${state.authToken}`,
    'Content-Type': 'application/json',
  }), [state.authToken]);

  const richUrl = useCallback((scope: RichScope, suffix: string) => (
    scope.kind === 'dm'
      ? `${state.currentServerIP}/api/conversations/${scope.conversationId}/${suffix}`
      : `${state.currentServerIP}/api/guilds/${scope.guildId}/channels/${scope.channelId}/${suffix}`
  ), [state.currentServerIP]);

  const richMsgUrl = useCallback((scope: RichScope, messageId: string, suffix: string) => (
    scope.kind === 'dm'
      ? `${state.currentServerIP}/api/messages/${messageId}/${suffix}`
      : `${state.currentServerIP}/api/guilds/${scope.guildId}/messages/${messageId}/${suffix}`
  ), [state.currentServerIP]);

  const failed = async (res: Response) => {
    const data = await res.json().catch(() => ({} as { error?: string }));
    return new Error(data.error || `HTTP ${res.status}`);
  };

  /** Creates the message; it then arrives over the chat WS, so nothing is
   *  inserted locally here (that would duplicate it). Throws on rejection so
   *  the composer can surface the reason. */
  const sendRichMessage = useCallback(async (
    scope: RichScope, type: RichMessageType, payload: Record<string, unknown>, tags?: string[],
  ): Promise<void> => {
    const res = await fetch(richUrl(scope, 'rich/'), {
      method: 'POST',
      headers: richHeaders(),
      body: JSON.stringify({ type, payload, tags: tags || [] }),
    });
    if (!res.ok) throw await failed(res);
  }, [richHeaders, richUrl]);

  const toggleTodoItem = useCallback(async (
    scope: RichScope, messageId: string, itemId: string,
  ): Promise<void> => {
    try {
      // The WS broadcast carries the authoritative list for everyone, us included.
      await fetch(richMsgUrl(scope, messageId, 'todo/toggle/'), {
        method: 'POST', headers: richHeaders(), body: JSON.stringify({ item_id: itemId }),
      });
    } catch (e) { reportError(e); }
  }, [richHeaders, richMsgUrl]);

  // Author-only edit of a text message (body.content) or a rich message like a
  // to-do list (body.payload). Polls are rejected by the server. The updated
  // message arrives over WS (message_edited) for everyone, so nothing is set
  // locally here. Throws on rejection so the editor can surface the reason.
  const editMessage = useCallback(async (
    scope: RichScope, messageId: string, body: { content?: string; payload?: Record<string, unknown> },
  ): Promise<void> => {
    const res = await fetch(richMsgUrl(scope, messageId, ''), {
      method: 'PATCH', headers: richHeaders(), body: JSON.stringify(body),
    });
    if (!res.ok) throw await failed(res);
  }, [richHeaders, richMsgUrl]);

  const pushLiveLocation = useCallback(async (
    scope: RichScope, messageId: string, body: { lat?: number; lng?: number; stop?: boolean },
  ): Promise<void> => {
    try {
      await fetch(richMsgUrl(scope, messageId, 'location/'), {
        method: 'POST', headers: richHeaders(), body: JSON.stringify(body),
      });
    } catch (e) { reportError(e); }
  }, [richHeaders, richMsgUrl]);

  // While any of our own live-location shares is running, push the current
  // position periodically; the server fans it out and expires it at live_until.
  const liveTargets = useRef<{ scope: RichScope; id: string }[]>([]);
  useEffect(() => {
    const now = Date.now();
    const isMineAndLive = (m: { id: string; message_type?: string; payload?: unknown; author?: { id: string } }) => {
      if (m.message_type !== 'location') return false;
      const p = m.payload as LocationPayload | undefined;
      return !!p?.live && !!p.live_until && new Date(p.live_until).getTime() > now
        && String(m.author?.id) === String(state.userIDonServer);
    };
    const next: { scope: RichScope; id: string }[] = [];
    if (state.chatConversationId) {
      for (const m of state.chatMessages) {
        if (isMineAndLive(m)) next.push({ scope: { kind: 'dm', conversationId: state.chatConversationId }, id: String(m.id) });
      }
    }
    liveTargets.current = next;
  }, [state.chatMessages, state.chatConversationId, state.userIDonServer]);

  useEffect(() => {
    if (!navigator.geolocation) return;
    const timer = setInterval(() => {
      const targets = liveTargets.current;
      if (!targets.length) return;
      navigator.geolocation.getCurrentPosition(
        (pos) => targets.forEach(t => {
          void pushLiveLocation(t.scope, t.id, { lat: pos.coords.latitude, lng: pos.coords.longitude });
        }),
        () => { /* a dropped fix just means no update this tick */ },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
      );
    }, 20000);
    return () => clearInterval(timer);
  }, [pushLiveLocation]);

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
    postNativeTheme(state.theme);
  }, [state.theme]);

  useEffect(() => { localStorage.setItem('messengerCurrentServer', state.currentServer); }, [state.currentServer]);
  useEffect(() => { localStorage.setItem('messengerCurrentChat', state.currentChat); }, [state.currentChat]);
  useEffect(() => { localStorage.setItem('messengerCurrentChannel', state.currentChannel); }, [state.currentChannel]);
  useEffect(() => { localStorage.setItem('messengerLanguage', state.language); }, [state.language]);
  // Keep the (non-React) error manager in sync with the active language so
  // globally-reported errors are localised too.
  useEffect(() => { setErrorLang(state.language); }, [state.language]);

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
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // ==================== State setters ====================
  const setCurrentView = (view: ViewType) => setState(prev => ({ ...prev, currentView: view }));

  const patchState = useCallback((patch: Partial<AppState>) => setState(prev => ({ ...prev, ...patch })), []);
  const setCurrentServer = (serverId: string) => {
    setState(prev => ({
      ...prev,
      currentServer: serverId,
      currentView: serverId === 'home' ? 'home' : serverId === 'settings' ? 'settings' : serverId === 'explore' ? 'home' : 'server',
      currentChat: serverId === 'home' ? '' : prev.currentChat,
      isMobileSidebarOpen: false,
      mobileActivePanel: 'chat-list' as MobilePanel,
    }));
  };

  const setCurrentChat = (chatId: string) => {
    setState(prev => {
      // Annotated: pulling the object out of the setState call loses the
      // contextual typing, and 'home' would widen from ViewType to string.
      const next: AppState = {
        ...prev,
        currentChat: chatId,
        currentView: 'home',
        currentServer: 'home',
        mobileActivePanel: 'chat-view' as MobilePanel,
      };
      if (String(prev.currentChat) === String(chatId)) return next;
      // Drop the outgoing conversation in the SAME update that switches to the
      // new one. Loading history takes two round-trips, and until this was done
      // here every one of those frames still painted the previous chat — worse,
      // chatConversationId still pointed at it, so a message sent during that
      // window went to the conversation the reader had just left.
      return {
        ...next,
        chatMessages: [],
        chatConversationId: null,
        chatBlockedByOther: false,
        chatLoading: true,
      };
    });
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
  const setMobileActivePanel = (panel: MobilePanel) => setState(prev => {
    if (panel === 'guild-channels') {
      if (prev.mobileActivePanel === 'guild-chat') armGuildBackGuard();
    }
    return { ...prev, mobileActivePanel: panel };
  });
  const setCallActive = (active: boolean) => {
    if (active) void runLifecycle('callStart');
    setState(prev => ({ ...prev, isCallActive: active }));
  };
  const setDemonstrationActive = (v: boolean) => setState(prev => ({ ...prev, isDemonstrationActive: v }));
  const setVideoActive = (v: boolean) => setState(prev => ({ ...prev, isVideoActive: v }));
  const setMicActive = (v: boolean) => {
    setState(prev => ({ ...prev, isMicActive: v }));
    void runLifecycle(v ? 'unmute' : 'mute');
  };
  const setHeadphonesActive = (v: boolean) => {
    setState(prev => ({ ...prev, isHeadphonesActive: v }));
    void runLifecycle(v ? 'undeafen' : 'deafen');
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
    if (token) {
      localStorage.setItem(AUTH_TOKEN_KEY, token);
      authTokenRef.current = token;
    } else {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      authTokenRef.current = '';
    }
    if (!token) {
      // Logout — close all sockets, drop the on-device message cache, and
      // reset to a clean state.
      void clearMessageCache();
        chatWs.current?.close();
      chatWs.current = null;
      signalingWs.current?.close();
      signalingWs.current = null;
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
      patchState,
      logout,
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
      sendRichMessage,
      toggleTodoItem,
      editMessage,
      pushLiveLocation,
      setCurrentUser,
    }}>
      {children}
    </AppContext.Provider>
  );
};
