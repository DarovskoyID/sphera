import type { RichMessageType } from '@sfera/sdk';
import type { Diary, DiaryEntry } from './types';

export interface Conn {
  token: string;
  serverIP: string;
}

async function call<T>(conn: Conn, path: string, init: RequestInit = {}): Promise<T> {
  const isForm = init.body instanceof FormData;
  const res = await fetch(`${conn.serverIP}/api/diary/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${conn.token}`,
      ...(init.body && !isForm ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status, body });
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  list: (c: Conn) => call<Diary[]>(c, 'diaries/'),
  create: (c: Conn, name: string) => call<Diary>(c, 'diaries/', json('POST', { name })),
  remove: (c: Conn, id: string, password: string) => call<void>(c, `diaries/${id}/`, json('DELETE', { password })),
  rename: (c: Conn, id: string, name: string) => call<Diary>(c, `diaries/${id}/`, json('PATCH', { name })),

  entries: (c: Conn, id: string, beforeTs?: string) =>
    call<DiaryEntry[]>(c, `diaries/${id}/entries/${beforeTs ? `?before_ts=${encodeURIComponent(beforeTs)}` : ''}`),
  addEntry: (c: Conn, id: string, body: { content: string; tags: string[]; attachment_ids: string[] }) =>
    call<DiaryEntry>(c, `diaries/${id}/entries/`, json('POST', body)),
  addRich: (c: Conn, id: string, type: RichMessageType, payload: unknown, tags: string[]) =>
    call<DiaryEntry>(c, `diaries/${id}/rich/`, json('POST', { type, payload, tags })),
  upload: async (c: Conn, id: string, file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return call<{ id: string }>(c, `diaries/${id}/upload/`, { method: 'POST', body: form });
  },

  edit: (c: Conn, entryId: string, body: { content?: string; payload?: unknown }) =>
    call<DiaryEntry>(c, `entries/${entryId}/`, json('PATCH', body)),
  removeEntry: (c: Conn, entryId: string) => call<void>(c, `entries/${entryId}/`, json('DELETE')),
  vote: (c: Conn, entryId: string, optionIds: string[]) =>
    call<unknown>(c, `entries/${entryId}/poll/vote/`, json('POST', { option_ids: optionIds })),
  closePoll: (c: Conn, entryId: string) => call<unknown>(c, `entries/${entryId}/poll/close/`, json('POST', {})),
  toggleTodo: (c: Conn, entryId: string, itemId: string) =>
    call<unknown>(c, `entries/${entryId}/todo/toggle/`, json('POST', { item_id: itemId })),
  stopLive: (c: Conn, entryId: string) => call<unknown>(c, `entries/${entryId}/location/`, json('POST', { stop: true })),
};
