/** Global account role. Guild roles ('owner' | 'admin' | 'member') are separate. */
export type AccountType = 'user' | 'bot' | 'admin';

export interface User {
  id: string;
  name: string;
  avatar: string;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  email?: string;
  bio?: string;
  account_type?: AccountType;
}

export interface VerificationInfo {
  level: number;
  has_email: boolean;
  has_phone: boolean;
  clean_3_months: boolean;
  clean_1_year: boolean;
}

/** One entry in a profile's list of links. */
export interface ProfileLink {
  label: string;
  url: string;
}

/** Most links a profile may carry — mirrors MAX_PROFILE_LINKS on the server. */
export const MAX_PROFILE_LINKS = 5;

export interface ServerUser {
  id: string;
  username: string;
  nickname: string;
  avatar: string;
  bio: string;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  account_type?: AccountType;
  /** The instance's single superuser (manages modules and chat safety). */
  is_superuser?: boolean;
  email?: string;
  phone?: string;
  date_joined?: string;
  verification_level?: number;
  verification?: VerificationInfo;
  // Profile-only. Absent from the short form embedded in messages and member
  // lists, and present on /api/auth/me/ and the profile endpoint.
  banner?: string;
  status_text?: string;
  links?: ProfileLink[];
  /** A parent manages this account — see the family centre. Only on /me/. */
  is_child?: boolean;
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
    account_type?: AccountType;
  };
  content: string;
  created_at: string;
  /** Local only: the server refused to deliver this message (e.g. a verification code). */
  blocked_reason?: string;
  attachments?: ChatAttachment[];
  reply_to?: {
    id: string;
    content: string;
    author: { id: string; username: string; nickname?: string };
    deleted?: boolean;
  } | null;
  is_pinned?: boolean;
  edited?: boolean;
  delivered_at?: string | null;
  read_at?: string | null;
  // 'call' is synthesised client-side from the message content (see
  // enrichCallMessage); the rest come from the server.
  message_type?: 'text' | 'call' | RichMessageType;
  call_info?: CallInfo;
  payload?: RichPayload | null;
}

export type ViewType = 'home' | 'server' | 'settings';

export type MobilePanel = 'chat-list' | 'chat-view' | 'guild-channels' | 'guild-chat' | 'guild-members';

export interface CustomEmoji {
  id: string;
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
  isMicActive: boolean;
  isHeadphonesActive: boolean;
  callStatus: 'active' | 'ringing' | 'connection' | 'inactive';
  SpeakersActive: Array<string>;
  currentServerIP: string;
  userIDonServer: string;
  authToken: string;
  currentUser: ServerUser | null;
  friends: ServerUser[];
  /** The friend list has been fetched at least once (success or failure). */
  friendsLoaded: boolean;
  blockedContacts: ServerUser[];
  pendingRequests: PendingRequest[];
  sentRequests: ServerUser[];
  callTargetId: string | null;
  incomingOffer: any | null;
  chatMessages: ChatMessage[];
  chatConversationId: string | null;
  chatBlockedByOther: boolean;
  /** A conversation is being opened: its history has not arrived yet. */
  chatLoading: boolean;
  customEmojis: CustomEmoji[];
}

