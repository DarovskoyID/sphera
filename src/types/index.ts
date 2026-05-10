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
  id: string;
  from_user: ServerUser;
  to_user: ServerUser;
  status: string;
  created_at: string;
}

export interface ChatAttachment {
  id: string;
  filename: string;
  content_type: string;
  file_size: number;
  url: string;
}

export interface ChatMessage {
  id: string;
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
    id: string;
    content: string;
    author: { id: string; username: string; nickname?: string };
    deleted?: boolean;
  } | null;
  is_pinned?: boolean;
  delivered_at?: string | null;
  read_at?: string | null;
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

export type GuildMemberRole = 'owner' | 'admin' | 'member';

export interface GuildMember {
  id: string;
  username: string;
  nickname: string;
  avatar: string;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  role: GuildMemberRole;
  custom_roles: string[];
}

export interface GuildChannel {
  id: string;
  name: string;
  type: 'text' | 'voice';
  topic: string;
  position: number;
}

export interface Guild {
  id: string;
  name: string;
  description: string;
  tag: string;
  icon: string;
  banner: string;
  owner_id: string;
  invite_code: string;
  boost_level: number;
  verification_level: string;
  default_notifications: string;
  explicit_content_filter: string;
  require_2fa: boolean;
  my_role: GuildMemberRole;
  members: GuildMember[];
  channels: GuildChannel[];
}

export interface GuildRole {
  id: string;
  name: string;
  color: string;
  permissions: string[];
  position: number;
}

export interface GuildEmoji {
  id: string;
  name: string;
  image: string;
}

export interface GuildSticker {
  id: string;
  name: string;
  description: string;
  image: string;
}

export interface GuildSound {
  id: string;
  name: string;
  url: string;
}

export interface GuildInviteData {
  id: string;
  code: string;
  creator: { id: string; username: string } | null;
  max_uses: number | null;
  uses: number;
  expires_at: string | null;
  created_at: string;
}

export interface GuildAuditLogEntry {
  id: string;
  action: string;
  actor: { id: string; username: string };
  target: { id: string; username: string } | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface GuildMessage {
  id: string;
  author: {
    id: string;
    username: string;
    nickname: string;
    avatar: string;
    status: string;
  };
  content: string;
  created_at: string;
  is_pinned: boolean;
  reply_to?: {
    id: string;
    content: string;
    author: { id: string; username: string; nickname?: string };
  } | null;
  attachments?: Array<{
    id: string;
    filename: string;
    content_type: string;
    file_size: number;
    url: string;
  }>;
}

export type ViewType = 'home' | 'server' | 'settings';

export type MobilePanel = 'chat-list' | 'chat-view' | 'guild-channels' | 'guild-chat' | 'guild-members';

export interface CustomEmoji {
  id: string;
  name: string;
  image_url: string;
  created_by: string;
}

export interface VoiceParticipant {
  id: string;
  username: string;
  nickname: string;
  avatar: string;
  muted: boolean;
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
  blockedContacts: ServerUser[];
  pendingRequests: PendingRequest[];
  sentRequests: ServerUser[];
  callTargetId: string | null;
  incomingOffer: any | null;
  chatMessages: ChatMessage[];
  chatConversationId: string | null;
  chatBlockedByOther: boolean;
  customEmojis: CustomEmoji[];
  guilds: Guild[];
  currentGuild: Guild | null;
  currentGuildChannel: GuildChannel | null;
  guildMessages: GuildMessage[];
  currentVoiceChannel: GuildChannel | null;
  voiceParticipants: VoiceParticipant[];
  voiceChannelParticipants: Record<string, VoiceParticipant[]>;
}
