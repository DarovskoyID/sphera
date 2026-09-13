import type { AccountType, RichMessageType, RichPayload } from '@sfera/sdk';
export type { RichUserBrief } from '@sfera/sdk';

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
  account_type?: AccountType;
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
  edited?: boolean;
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

export interface VoiceParticipant {
  id: string;
  username: string;
  nickname: string;
  avatar: string;
  muted: boolean;
  deafened: boolean;
}
