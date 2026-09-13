import type { RichMessageType, RichPayload } from '@sfera/sdk';

export interface Diary {
  id: string;
  name: string;
  created_at: string;
}

export interface DiaryAttachment {
  id: string;
  filename: string;
  content_type: string;
  file_size: number;
  url: string;
}

export interface DiaryEntry {
  id: string;
  diary_id: string;
  author: { id: string; username: string; nickname?: string; avatar?: string };
  content: string;
  created_at: string;
  edited: boolean;
  tags: string[];
  attachments: DiaryAttachment[];
  message_type?: RichMessageType | 'text';
  payload?: RichPayload | null;
}

export const MAX_DIARIES = 3;
