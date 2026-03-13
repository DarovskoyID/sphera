import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import type {AppState, ViewType} from '../types';

interface AppContextType extends AppState {
  setCurrentView: (view: ViewType) => void;
  setCurrentServer: (serverId: string) => void;
  setCurrentChat: (chatId: string) => void;
  setCurrentChannel: (channel: string) => void;
  setCurrentSettingsPage: (page: string) => void;
  toggleTheme: () => void;
  setLanguage: (lang: 'en' | 'ru') => void;
  toggleMobileSidebar: () => void;
  setCallActive: (active: boolean) => void;
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
      isCallActive: false
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
      currentView: serverId === 'home' ? 'home' : serverId === 'settings' ? 'settings' : 'server'
    }));
  };

  const setCurrentChat = (chatId: string) => {
    setState(prev => ({ ...prev, currentChat: chatId }));
  };

  const setCurrentChannel = (channel: string) => {
    setState(prev => ({ ...prev, currentChannel: channel }));
  };

  const setCurrentSettingsPage = (page: string) => {
    setState(prev => ({ ...prev, currentSettingsPage: page }));
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

  const setCallActive = (active: boolean) => {
    setState(prev => ({ ...prev, isCallActive: active }));
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
      setCallActive
    }}>
      {children}
    </AppContext.Provider>
  );
};
