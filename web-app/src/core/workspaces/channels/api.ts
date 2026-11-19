import type { RichMessageType, RichUserBrief } from '@sfera/sdk';
import type { ExploreChannel, FeedChannel, Post, PostAttachment, PostComment, PostHit } from './types';

export interface Conn {
  token: string;
  serverIP: string;
}

async function call<T>(c: Conn, path: string, init: RequestInit = {}): Promise<T> {
  const isForm = init.body instanceof FormData;
  const res = await fetch(`${c.serverIP}/api/channels/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${c.token}`,
      ...(init.body && !isForm ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status, body });
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

const send = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  mine: (c: Conn) => call<FeedChannel[]>(c, ''),
  create: (c: Conn, name: string, description = '') => call<FeedChannel>(c, '', send('POST', { name, description })),
  get: (c: Conn, id: string) => call<FeedChannel>(c, `${id}/`),
  update: (c: Conn, id: string, form: FormData) => call<FeedChannel>(c, `${id}/`, { method: 'PATCH', body: form }),
  remove: (c: Conn, id: string, password: string) => call<void>(c, `${id}/`, send('DELETE', { password })),
  join: (c: Conn, by: { invite_code?: string; channel_id?: string }) => call<FeedChannel>(c, 'join/', send('POST', by)),
  leave: (c: Conn, id: string) => call<void>(c, `${id}/leave/`, send('DELETE')),
  toggleNotifications: (c: Conn, id: string) => call<{ notifications_muted: boolean }>(c, `${id}/notifications/`, send('POST', {})),
  explore: (c: Conn, q: string, signal?: AbortSignal) =>
    call<ExploreChannel[]>(c, `explore/?q=${encodeURIComponent(q)}`, { signal }),
  searchPosts: (c: Conn, q: string, signal?: AbortSignal) =>
    call<PostHit[]>(c, `search/posts/?q=${encodeURIComponent(q)}`, { signal }),

  posts: (c: Conn, id: string, beforeTs?: string) =>
    call<Post[]>(c, `${id}/posts/${beforeTs ? `?before_ts=${encodeURIComponent(beforeTs)}` : ''}`),
  post: (c: Conn, id: string, content: string, attachmentIds: string[]) =>
    call<Post>(c, `${id}/posts/`, send('POST', { content, attachment_ids: attachmentIds })),
  rich: (c: Conn, id: string, type: RichMessageType, payload: unknown, tags?: string[]) =>
    call<Post>(c, `${id}/rich/`, send('POST', { type, payload, tags })),
  schedule: (c: Conn, id: string, content: string, delaySeconds: number, attachmentIds: string[]) =>
    call<{ id: string; send_at: string }>(c, `${id}/schedule/`, send('POST', { content, delay_seconds: delaySeconds, attachment_ids: attachmentIds })),
  upload: (c: Conn, id: string, file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return call<PostAttachment>(c, `${id}/upload/`, { method: 'POST', body: form });
  },

  edit: (c: Conn, postId: string, body: { content?: string; payload?: unknown }) => call<Post>(c, `posts/${postId}/`, send('PATCH', body)),
  removePost: (c: Conn, postId: string) => call<void>(c, `posts/${postId}/`, send('DELETE')),
  react: (c: Conn, postId: string, emoji: string) =>
    call<{ added: boolean; reactions: Post['reactions'] }>(c, `posts/${postId}/reactions/`, send('POST', { emoji })),
  view: (c: Conn, postId: string) => call<{ views: number }>(c, `posts/${postId}/view/`, send('POST', {})),
  comments: (c: Conn, postId: string) => call<PostComment[]>(c, `posts/${postId}/comments/`),
  comment: (c: Conn, postId: string, content: string) => call<PostComment>(c, `posts/${postId}/comments/`, send('POST', { content })),
  removeComment: (c: Conn, commentId: string) => call<void>(c, `comments/${commentId}/`, send('DELETE')),
  vote: (c: Conn, postId: string, optionIds: string[]) => call<{ poll: unknown }>(c, `posts/${postId}/poll/vote/`, send('POST', { option_ids: optionIds })),
  voters: (c: Conn, postId: string, optionId: string, offset = 0, limit = 50) =>
    call<{ voters: RichUserBrief[]; total: number }>(c, `posts/${postId}/poll/voters/?option=${encodeURIComponent(optionId)}&offset=${offset}&limit=${limit}`),
  closePoll: (c: Conn, postId: string) => call<{ poll: unknown }>(c, `posts/${postId}/poll/close/`, send('POST', {})),
  toggleTodo: (c: Conn, postId: string, itemId: string) => call<{ todo: unknown }>(c, `posts/${postId}/todo/toggle/`, send('POST', { item_id: itemId })),
  location: (c: Conn, postId: string, body: { lat?: number; lng?: number; stop?: boolean }) =>
    call<{ location: unknown }>(c, `posts/${postId}/location/`, send('POST', body)),
};
