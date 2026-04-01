import React, { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import type { AppState, ViewType, MobilePanel, ServerUser, PendingRequest } from '../types';

interface AppContextType extends AppState {
  setCurrentView: (view: ViewType) => void;
  setCurrentServer: (serverId: string) => void;
  setCurrentChat: (chatId: string) => void;
  setCurrentChannel: (channel: string) => void;
  setCurrentSettingsPage: (page: string) => void;
  toggleTheme: () => void;
  setLanguage: (lang: 'en' | 'ru') => void;
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
    const savedLanguage = localStorage.getItem('messengerLanguage') as 'en' | 'ru' || 'en';
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
      currentServerIP: 'http://localhost:8000',
      userIDonServer: '',
      authToken: savedToken,
      currentUser: null,
      friends: [],
      pendingRequests: [],
      callTargetId: null,
    };
  });

  const signalingWs = useRef<WebSocket | null>(null);
  const [signalingPeers, setSignalingPeers] = useState<Array<{ id: string; name: string }>>([]);
  const onSignalingMessage = useRef<((msg: any) => void) | null>(null);

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
      } catch (e) {
        console.error('Failed to load user:', e);
      }
      try {
        const friends: ServerUser[] = await apiGet('/api/auth/friends/', state.authToken, state.currentServerIP);
        setState(prev => ({ ...prev, friends }));
      } catch (e) {
        console.error('Failed to load friends:', e);
      }
      try {
        const pending: PendingRequest[] = await apiGet('/api/auth/friends/requests/pending/', state.authToken, state.currentServerIP);
        setState(prev => ({ ...prev, pendingRequests: pending }));
      } catch (e) {
        console.error('Failed to load pending requests:', e);
      }
    };
    load();
  }, [state.authToken]);

  // ==================== Friends actions ====================
  const loadFriends = useCallback(async () => {
    try {
      const friends: ServerUser[] = await apiGet('/api/auth/friends/', state.authToken, state.currentServerIP);
      setState(prev => ({ ...prev, friends }));
    } catch (e) { console.error(e); }
  }, [state.authToken, state.currentServerIP, apiGet]);

  const loadPendingRequests = useCallback(async () => {
    try {
      const pending: PendingRequest[] = await apiGet('/api/auth/friends/requests/pending/', state.authToken, state.currentServerIP);
      setState(prev => ({ ...prev, pendingRequests: pending }));
    } catch (e) { console.error(e); }
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

  // ==================== Signaling WebSocket ====================
  useEffect(() => {
    if (!state.authToken || !state.isCallActive) {
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
      console.log('Signaling WS connected');
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
      console.log('Signaling WS disconnected');
      signalingWs.current = null;
    };

    return () => {
      ws.close();
      signalingWs.current = null;
    };
  }, [state.authToken, state.currentServerIP, state.isCallActive]);

  const sendSignal = (data: any) => {
    if (signalingWs.current?.readyState === WebSocket.OPEN) {
      signalingWs.current.send(JSON.stringify(data));
    } else {
      console.error('Signaling WS not connected');
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
      isMobileSidebarOpen: false,
      mobileActivePanel: 'chat-list' as MobilePanel,
    }));
  };

  const setCurrentChat = (chatId: string) => {
    setState(prev => ({ ...prev, currentChat: chatId, mobileActivePanel: 'chat-view' as MobilePanel }));
  };

  const setCurrentChannel = (channel: string) => setState(prev => ({ ...prev, currentChannel: channel }));

  const setCurrentSettingsPage = (page: string) => {
    setState(prev => ({ ...prev, currentSettingsPage: page, mobileActivePanel: 'chat-view' as MobilePanel }));
  };

  const toggleTheme = () => setState(prev => ({ ...prev, theme: prev.theme === 'dark' ? 'light' : 'dark' }));
  const setLanguage = (lang: 'en' | 'ru') => setState(prev => ({ ...prev, language: lang }));
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
    }}>
      {children}
    </AppContext.Provider>
  );
};
