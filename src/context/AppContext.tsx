import React, { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import type { AppState, ViewType, MobilePanel, ServerUser, PendingRequest, ChatMessage } from '../types';
import type { CustomEmoji } from '../types';

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
  setSpeakersActive: (SpeakersActive: Array<string>) => void;
  setCallStatus: (status: 'active' | 'ringing' | 'connection' | 'inactive') => void;
  setCurrentServerIP: (serverIP: string) => void;
  setUserIDonServer: (userIDonServer: string) => void;
  setAuthToken: (token: string) => void;
  setCallTargetId: (id: string | null) => void;
  setIncomingOffer: (offer: any | null) => void;
  signalingWs: React.MutableRefObject<WebSocket | null>;
  sendSignal: (data: any) => void;
  signalingPeers: Array<{ id: string; name: string }>;
  onSignalingMessage: React.MutableRefObject<((msg: any) => void) | null>;
  loadFriends: () => Promise<void>;
  loadPendingRequests: () => Promise<void>;
  sendFriendRequest: (userId: string) => Promise<void>;
  acceptFriendRequest: (friendshipId: number) => Promise<void>;
  rejectFriendRequest: (friendshipId: number) => Promise<void>;
  searchUsers: (query: string) => Promise<ServerUser[]>;
  sendChatMessage: (text: string, attachmentIds?: number[], replyToId?: number) => void;
  deleteMessage: (messageId: number) => Promise<void>;
  pinMessage: (messageId: number) => Promise<void>;
  reportMessage: (messageId: number) => Promise<void>;
  loadOlderMessages: () => Promise<boolean>;
  loadCustomEmojis: () => Promise<void>;
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
    const savedLanguage = localStorage.getItem('messengerLanguage') || 'en';
    const savedServer = localStorage.getItem('messengerCurrentServer') || 'home';
    const savedChat = localStorage.getItem('messengerCurrentChat') || '';
    const savedChannel = localStorage.getItem('messengerCurrentChannel') || 'general';
    const savedToken = localStorage.getItem('authToken') || '';

    return {
      currentView: savedServer === 'home' ? 'home' : savedServer === 'settings' ? 'settings' : 'server',
      currentServer: savedServer,
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
      SpeakersActive: ["", ""],
      callStatus: 'inactive',
      currentServerIP: 'http://192.168.0.110:8000',
      userIDonServer: '',
      authToken: savedToken,
      currentUser: null,
      friends: [],
      pendingRequests: [],
      callTargetId: null,
      incomingOffer: null,
      chatMessages: [],
      chatConversationId: null,
      customEmojis: [],
    };
  });

  const signalingWs = useRef<WebSocket | null>(null);
  const [signalingPeers, setSignalingPeers] = useState<Array<{ id: string; name: string }>>([]);
  const onSignalingMessage = useRef<((msg: any) => void) | null>(null);

  const chatWs = useRef<WebSocket | null>(null);

  // ==================== API helpers ====================
  const apiGet = useCallback(async (path: string, token: string, serverIP: string) => {
    const res = await fetch(`${serverIP}${path}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  }, []);

  const apiPost = useCallback(async (path: string, token: string, serverIP: string, body: any) => {
    const res = await fetch(`${serverIP}${path}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(typeof data === 'object' ? Object.values(data).flat().join(', ') : String(data));
    }
    return res.json();
  }, []);

  // ==================== Load user info after login ====================
  useEffect(() => {
    if (!state.authToken) {
      setState(prev => ({ ...prev, currentUser: null, friends: [], pendingRequests: [], userIDonServer: '', currentChat: '' }));
      return;
    }
    const load = async () => {
      try {
        const user: ServerUser = await apiGet('/api/auth/me/', state.authToken, state.currentServerIP);
        setState(prev => ({ ...prev, currentUser: user, userIDonServer: String(user.id) }));
      } catch { }
      try {
        const friends: ServerUser[] = await apiGet('/api/auth/friends/', state.authToken, state.currentServerIP);
        setState(prev => ({ ...prev, friends }));
      } catch { }
      try {
        const pending: PendingRequest[] = await apiGet('/api/auth/friends/requests/pending/', state.authToken, state.currentServerIP);
        setState(prev => ({ ...prev, pendingRequests: pending }));
      } catch { }
      try {
        const emojis: CustomEmoji[] = await apiGet('/api/auth/emojis/', state.authToken, state.currentServerIP);
        setState(prev => ({ ...prev, customEmojis: emojis }));
      } catch { }
    };
    load();
  }, [state.authToken]);

  // ==================== Friends actions ====================
  const loadFriends = useCallback(async () => {
    try {
      const friends: ServerUser[] = await apiGet('/api/auth/friends/', state.authToken, state.currentServerIP);
      setState(prev => ({ ...prev, friends }));
    } catch { }
  }, [state.authToken, state.currentServerIP, apiGet]);

  const loadPendingRequests = useCallback(async () => {
    try {
      const pending: PendingRequest[] = await apiGet('/api/auth/friends/requests/pending/', state.authToken, state.currentServerIP);
      setState(prev => ({ ...prev, pendingRequests: pending }));
    } catch { }
  }, [state.authToken, state.currentServerIP, apiGet]);

  const loadCustomEmojis = useCallback(async () => {
    if (!state.authToken) return;
    try {
      const emojis: CustomEmoji[] = await apiGet('/api/auth/emojis/', state.authToken, state.currentServerIP);
      setState(prev => ({ ...prev, customEmojis: emojis }));
    } catch { }
  }, [state.authToken, state.currentServerIP, apiGet]);

  const sendFriendRequest = useCallback(async (userId: string) => {
    await apiPost('/api/auth/friends/request/', state.authToken, state.currentServerIP, { user_id: userId });
  }, [state.authToken, state.currentServerIP, apiPost]);

  const acceptFriendRequest = useCallback(async (friendshipId: number) => {
    await apiPost(`/api/auth/friends/request/${friendshipId}/accept/`, state.authToken, state.currentServerIP, {});
    await loadFriends();
    await loadPendingRequests();
  }, [state.authToken, state.currentServerIP, apiPost, loadFriends, loadPendingRequests]);

  const rejectFriendRequest = useCallback(async (friendshipId: number) => {
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
      setState(prev => ({ ...prev, chatMessages: [], chatConversationId: null }));
      return;
    }

    let cancelled = false;

    const initChat = async () => {
      try {
        // Get or create conversation with this user
        const convo = await apiPost(
          '/api/conversations/create/',
          state.authToken,
          state.currentServerIP,
          { user_id: state.currentChat }
        );
        if (cancelled) return;

        const convoId = convo.id;
        setState(prev => ({ ...prev, chatConversationId: convoId }));

        // Load message history
        const msgs: ChatMessage[] = await apiGet(
          `/api/conversations/${convoId}/messages/`,
          state.authToken,
          state.currentServerIP
        );
        if (cancelled) return;
        setState(prev => ({ ...prev, chatMessages: msgs }));

        // Connect chat WebSocket
        const wsUrl = state.currentServerIP.replace(/^http/, 'ws');
        const ws = new WebSocket(`${wsUrl}/ws/chat/${convoId}/?token=${state.authToken}`);

        ws.onopen = () => {
          chatWs.current = ws;
        };

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === 'message_deleted') {
            setState(prev => ({
              ...prev,
              chatMessages: prev.chatMessages.filter(m => m.id !== data.id),
            }));
          } else if (data.type === 'message_pinned') {
            setState(prev => ({
              ...prev,
              chatMessages: prev.chatMessages.map(m =>
                m.id === data.id ? { ...m, is_pinned: data.is_pinned } : m
              ),
            }));
          } else {
            const msg: ChatMessage = data;
            setState(prev => {
              const msgs = [...prev.chatMessages, msg];
              if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
              return { ...prev, chatMessages: msgs };
            });
          }
        };

        ws.onclose = () => {
          if (chatWs.current === ws) chatWs.current = null;
        };
      } catch {
      }
    };

    initChat();

    return () => {
      cancelled = true;
      if (chatWs.current) {
        chatWs.current.close();
        chatWs.current = null;
      }
    };
  }, [state.currentChat, state.authToken, state.currentServerIP]);

  const sendChatMessage = useCallback((text: string, attachmentIds?: number[], replyToId?: number) => {
    if (chatWs.current?.readyState !== WebSocket.OPEN) return;
    const payload: Record<string, unknown> = {};
    if (text.trim()) payload.message = text;
    if (attachmentIds && attachmentIds.length > 0) payload.attachment_ids = attachmentIds;
    if (replyToId) payload.reply_to_id = replyToId;
    if (payload.message || payload.attachment_ids) {
      chatWs.current.send(JSON.stringify(payload));
    }
  }, []);

  const deleteMessage = useCallback(async (messageId: number) => {
    await fetch(`${state.currentServerIP}/api/messages/${messageId}/`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${state.authToken}` },
    });
  }, [state.currentServerIP, state.authToken]);

  const pinMessage = useCallback(async (messageId: number) => {
    await fetch(`${state.currentServerIP}/api/messages/${messageId}/pin/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.authToken}` },
    });
  }, [state.currentServerIP, state.authToken]);

  const reportMessage = useCallback(async (messageId: number) => {
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
      setState(prev => ({
        ...prev,
        chatMessages: [...older, ...prev.chatMessages],
      }));
      return true;
    } catch {
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

    const wsUrl = state.currentServerIP.replace(/^http/, 'ws');
    const ws = new WebSocket(`${wsUrl}/ws/signaling/?token=${state.authToken}`);

    ws.onopen = () => {
      signalingWs.current = ws;
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'peers') {
        setSignalingPeers(data.peers);
        return;
      }
      if (onSignalingMessage.current) {
        onSignalingMessage.current(data);
      }
    };

    ws.onclose = () => {
      signalingWs.current = null;
    };

    return () => {
      ws.close();
      signalingWs.current = null;
    };
  }, [state.authToken, state.currentServerIP]);

  const sendSignal = (data: any) => {
    if (signalingWs.current?.readyState === WebSocket.OPEN) {
      signalingWs.current.send(JSON.stringify(data));
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
  }, [state.theme]);

  useEffect(() => { localStorage.setItem('messengerCurrentServer', state.currentServer); }, [state.currentServer]);
  useEffect(() => { localStorage.setItem('messengerCurrentChat', state.currentChat); }, [state.currentChat]);
  useEffect(() => { localStorage.setItem('messengerCurrentChannel', state.currentChannel); }, [state.currentChannel]);
  useEffect(() => { localStorage.setItem('messengerLanguage', state.language); }, [state.language]);

  // ==================== State setters ====================
  const setCurrentView = (view: ViewType) => setState(prev => ({ ...prev, currentView: view }));

  const setCurrentServer = (serverId: string) => {
    setState(prev => ({
      ...prev,
      currentServer: serverId,
      currentView: serverId === 'home' ? 'home' : serverId === 'settings' ? 'settings' : 'server',
      currentChat: serverId === 'home' ? '' : prev.currentChat,
      isMobileSidebarOpen: false,
      mobileActivePanel: 'chat-list' as MobilePanel,
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
  const setSpeakersActive = (v: Array<string>) => setState(prev => ({ ...prev, SpeakersActive: v }));
  const setCallStatus = (s: 'active' | 'ringing' | 'connection' | 'inactive') => setState(prev => ({ ...prev, callStatus: s }));
  const setCurrentServerIP = (ip: string) => setState(prev => ({ ...prev, currentServerIP: ip }));
  const setUserIDonServer = (id: string) => setState(prev => ({ ...prev, userIDonServer: id }));
  const setCallTargetId = (id: string | null) => setState(prev => ({ ...prev, callTargetId: id }));
  const setIncomingOffer = (offer: any | null) => setState(prev => ({ ...prev, incomingOffer: offer }));

  const setAuthToken = (token: string) => {
    localStorage.setItem('authToken', token);
    setState(prev => ({ ...prev, authToken: token }));
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
      sendFriendRequest,
      acceptFriendRequest,
      rejectFriendRequest,
      searchUsers,
      sendChatMessage,
      deleteMessage,
      pinMessage,
      reportMessage,
      loadOlderMessages,
      loadCustomEmojis,
    }}>
      {children}
    </AppContext.Provider>
  );
};
