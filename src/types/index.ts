export interface User {
  id: string;
  name: string;
  avatar: string;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  email?: string;
  bio?: string;
}

export interface VerificationInfo {
  level: number;
  has_email: boolean;
  has_phone: boolean;
  clean_3_months: boolean;
  clean_1_year: boolean;
}

export interface ServerUser {
  id: string;
  username: string;
  nickname: string;
  avatar: string;
  bio: string;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  email?: string;
  phone?: string;
  date_joined?: string;
  verification_level?: number;
  verification?: VerificationInfo;
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

export type CallStatus = 'completed' | 'missed' | 'declined' | 'cancelled' | 'no_answer';

export interface CallInfo {
  status: CallStatus;
  duration?: number; // seconds
  video?: boolean;
}

// ── Rich messages (polls / checklists / contacts / locations) ────────────────
export type RichMessageType = 'poll' | 'todo' | 'contact' | 'location';

export interface RichUserBrief {
  id: string;
  username: string;
  nickname: string;
  avatar: string;
}

export interface PollOption {
  id: string;
  text: string;
  count: number;
  /** This client's own selection. Absent from WS broadcasts — kept locally. */
  me: boolean;
  voters: RichUserBrief[];
}

export interface PollPayload {
  question: string;
  options: PollOption[];
  multiple: boolean;
  anonymous: boolean;
  closed: boolean;
  closes_at?: string | null;
  total_votes: number;
  total_voters: number;
  voted: boolean;
}

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  done_by: RichUserBrief | null;
  done_at: string | null;
}

export interface TodoPayload {
  title: string;
  items: TodoItem[];
  done_count: number;
  total: number;
}

export type ContactPayload =
  | { kind: 'user'; user_id: string; username: string; nickname: string; avatar: string }
  | { kind: 'manual'; name: string; phone: string };

export interface LocationPayload {
  lat: number;
  lng: number;
  label?: string;
  live: boolean;
  live_until: string | null;
  updated_at: string;
}

export type RichPayload = PollPayload | TodoPayload | ContactPayload | LocationPayload;

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
  // 'call' is synthesised client-side from the message content (see
  // enrichCallMessage); the rest come from the server.
  message_type?: 'text' | 'call' | RichMessageType;
  call_info?: CallInfo;
  payload?: RichPayload | null;
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
  muted_until?: string | null;
}

export interface GuildCategory {
  id: string;
  name: string;
  position: number;
}

export interface GuildChannel {
  id: string;
  name: string;
  type: 'text' | 'voice';
  topic: string;
  position: number;
  category_id?: string | null;
  user_limit?: number;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  me: boolean;
}

export interface Guild {
  id: string;
  name: string;
  description: string;
  tag: string;
  tags: string[];
  icon: string;
  banner: string;
  owner_id: string;
  invite_code: string;
  boost_level: number;
  verification_level: string;
  default_notifications: string;
  explicit_content_filter: string;
  require_2fa: boolean;
  is_discoverable: boolean;
  is_personal_channel: boolean;
  is_official?: boolean;
  is_private?: boolean;
  comments_enabled: boolean;
  my_role: GuildMemberRole;
  my_muted_until: string | null;
  my_notifications_muted: boolean;
  members: GuildMember[];
  channels: GuildChannel[];
  categories: GuildCategory[];
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
  reactions?: MessageReaction[];
  views?: number;
  comments_count?: number;
  message_type?: 'text' | RichMessageType;
  payload?: RichPayload | null;
  tags?: string[];
}

export interface PostComment {
  id: string;
  author: {
    id: string;
    username: string;
    nickname: string;
    avatar: string;
  };
  content: string;
  created_at: string;
}

// Server-bar layout (ordering + folders), synced per user via /api/server-layout/.
export type LayoutEntry =
  | { kind: 'guild'; id: string }
  | { kind: 'folder'; id: string; name: string; color?: string; items: string[] };

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
  deafened: boolean;
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
  isMicActive: boolean;
  isHeadphonesActive: boolean;
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
  serverLayout: LayoutEntry[];
  currentGuild: Guild | null;
  currentGuildChannel: GuildChannel | null;
  guildMessages: GuildMessage[];
  currentVoiceChannel: GuildChannel | null;
  voiceParticipants: VoiceParticipant[];
  voiceChannelParticipants: Record<string, VoiceParticipant[]>;
}
