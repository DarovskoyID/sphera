export interface User {
  id: string;
  name: string;
  avatar: string;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  email?: string;
  bio?: string;
}

export interface Message {
  id: string;
  author: string;
  authorId: string;
  avatar: string;
  content: string;
  timestamp: string;
  isOwn: boolean;
}

export interface DirectMessage {
  id: string;
  name: string;
  avatar: string;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  lastMessage: string;
  lastMessageTime: string;
  unread: number;
  isActive?: boolean;
}

export interface ServerChannel {
  id: string;
  name: string;
  abbr: string;
  description: string;
  banner: string;
  accent: string;
  members: number;
  online: number;
  notifications?: number;
  channels: string[];
  voiceChannels: string[];
}

export type ViewType = 'home' | 'server' | 'settings';

export interface AppState {
  currentView: ViewType;
  currentServer: string;
  currentChat: string;
  currentChannel: string;
  currentSettingsPage: string;
  theme: 'light' | 'dark';
  language: 'en' | 'ru';
  isMobileSidebarOpen: boolean;
  isCallActive: boolean;
}
