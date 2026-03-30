import React, { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import type {AppState, ViewType, MobilePanel} from '../types';

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
    const savedChat = localStorage.getItem('messengerCurrentChat') || '1';
    const savedChannel = localStorage.getItem('messengerCurrentChannel') || 'general';

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
      currentServerIP: 'http://localhost:8888',
      userIDonServer: '',
    };
  });

  useEffect(() => {
    if (state.theme === 'dark') {
      document.body.classList.add('dark-theme');
    } else {
      document.body.classList.remove('dark-theme');
    }
    localStorage.setItem('messengerTheme', state.theme);
  }, [state.theme]);

  useEffect(() => {
    localStorage.setItem('messengerCurrentServer', state.currentServer);
  }, [state.currentServer]);

  useEffect(() => {
    localStorage.setItem('messengerCurrentChat', state.currentChat);
  }, [state.currentChat]);

  useEffect(() => {
    localStorage.setItem('messengerCurrentChannel', state.currentChannel);
  }, [state.currentChannel]);

  useEffect(() => {
    localStorage.setItem('messengerLanguage', state.language);
  }, [state.language]);

  const setCurrentView = (view: ViewType) => {
    setState(prev => ({ ...prev, currentView: view }));
  };

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

  const setCurrentChannel = (channel: string) => {
    setState(prev => ({ ...prev, currentChannel: channel }));
  };

  const setCurrentSettingsPage = (page: string) => {
    setState(prev => ({ ...prev, currentSettingsPage: page, mobileActivePanel: 'chat-view' as MobilePanel }));
  };

  const toggleTheme = () => {
    setState(prev => ({ ...prev, theme: prev.theme === 'dark' ? 'light' : 'dark' }));
  };

  const setLanguage = (lang: 'en' | 'ru') => {
    setState(prev => ({ ...prev, language: lang }));
  };

  const toggleMobileSidebar = () => {
    setState(prev => ({ ...prev, isMobileSidebarOpen: !prev.isMobileSidebarOpen }));
  };

  const setMobileActivePanel = (panel: MobilePanel) => {
    setState(prev => ({ ...prev, mobileActivePanel: panel }));
  };

  const setCallActive = (active: boolean) => {
    setState(prev => ({ ...prev, isCallActive: active }));
  };

  const setDemonstrationActive = (DemonstrationActive: boolean) => {
    setState(prev => ({ ...prev, isDemonstrationActive: DemonstrationActive }));
  }

  const setVideoActive = (VideoActive: boolean) => {
    setState(prev => ({ ...prev, isVideoActive: VideoActive }));
  }

  const setSpeakersActive = (SpeakersActive: Array<string>) => {
    setState(prev => ({ ...prev, SpeakersActive }));
  }

  const setCallStatus = (status: 'active' | 'ringing' | 'connection' | 'inactive') => {
    setState(prev => ({ ...prev, callStatus: status }));
  }

  const setCurrentServerIP = (serverIP: string) => {
    setState(prev => ({ ...prev, currentServerIP: serverIP }));
  }

  const setUserIDonServer = (userIDonServer: string) => {
    setState(prev => ({ ...prev, userIDonServer }));
  }

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
    }}>
      {children}
    </AppContext.Provider>
  );
};
