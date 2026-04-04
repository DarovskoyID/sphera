export interface User {
  id: string;
  name: string;
  avatar: string;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  email?: string;
  bio?: string;
}

export interface ServerUser {
  id: string;
  username: string;
  nickname: string;
  avatar: string;
  bio: string;
  status: 'online' | 'idle' | 'dnd' | 'offline';
}

export interface PendingRequest {
  id: number;
  from_user: ServerUser;
  to_user: ServerUser;
  status: string;
  created_at: string;
}

export interface ChatAttachment {
  id: number;
  filename: string;
  content_type: string;
  file_size: number;
  url: string;
}

export interface ChatMessage {
  id: number;
  author: {
    id: string;
    username: string;
    nickname?: string;
    avatar: string;
    status?: string;
  };
  content: string;
  created_at: string;
  attachments?: ChatAttachment[];
  reply_to?: {
    id: number;
    content: string;
    author: { id: string; username: string; nickname?: string };
  } | null;
  is_pinned?: boolean;
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

export type MobilePanel = 'chat-list' | 'chat-view';

export interface CustomEmoji {
  id: number;
  name: string;
  image_url: string;
  created_by: string;
}

export interface AppState {
  currentView: ViewType;
  currentServer: string;
  currentChat: string;
  currentChannel: string;
  currentSettingsPage: string;
  theme: 'light' | 'dark';
  language: string;
  isMobileSidebarOpen: boolean;
  mobileActivePanel: MobilePanel;
  isCallActive: boolean;
  isDemonstrationActive: boolean;
  isVideoActive: boolean;
  callStatus: 'active' | 'ringing' | 'connection' | 'inactive';
  SpeakersActive: Array<string>;
  currentServerIP: string;
  userIDonServer: string;
  authToken: string;
  currentUser: ServerUser | null;
  friends: ServerUser[];
  pendingRequests: PendingRequest[];
  callTargetId: string | null;
  incomingOffer: any | null;
  chatMessages: ChatMessage[];
  chatConversationId: number | null;
  customEmojis: CustomEmoji[];
}
