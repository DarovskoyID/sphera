import type { RichMessageType, RichPayload } from '@sfera/sdk';

export interface FeedChannel {
  id: string;
  name: string;
  description: string;
  tags: string[];
  icon: string;
  banner: string;
  owner_id: string;
  invite_code: string;
  is_discoverable: boolean;
  comments_enabled: boolean;
  is_official: boolean;
  subscriber_count: number;
  my_role: 'owner' | 'subscriber' | '';
  my_notifications_muted: boolean;
}

export interface PostAttachment {
  id: string;
  filename: string;
  content_type: string;
  file_size: number;
  url: string;
}

export interface Post {
  id: string;
  channel_id?: string;
  author: { id: string; username: string; nickname: string; avatar: string; status: string; account_type?: string };
  content: string;
  created_at: string;
  is_pinned: boolean;
  edited?: boolean;
  reply_to?: null;
  attachments?: PostAttachment[];
  reactions?: { emoji: string; count: number; me: boolean }[];
  views?: number;
  comments_count?: number;
  message_type?: 'text' | RichMessageType;
  payload?: RichPayload | null;
  tags?: string[];
}

export interface PostComment {
  id: string;
  author: { id: string; username: string; nickname: string; avatar: string };
  content: string;
  created_at: string;
}

export interface ExploreChannel {
  id: string;
  name: string;
  description: string;
  icon: string;
  banner: string;
  subscriber_count: number;
  invite_code: string;
  tags: string[];
  is_official: boolean;
  is_member: boolean;
}

export interface PostHit {
  id: string;
  content: string;
  created_at: string;
  channel: { id: string; name: string; icon: string; invite_code: string; is_member: boolean };
  author: { username: string; nickname: string };
}
