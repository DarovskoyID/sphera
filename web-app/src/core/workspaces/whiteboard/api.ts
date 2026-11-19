import type { UserBrief } from './ui';
import type { Board, BoardBrief, Doc, Op, Role } from './types';

export interface Conn {
  token: string;
  serverIP: string;
}

async function call<T>(conn: Conn, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${conn.serverIP}/api/whiteboard/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${conn.token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status, body });
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  boards: (c: Conn) => call<BoardBrief[]>(c, 'boards/'),
  create: (c: Conn, name: string, doc?: Doc) => call<Board>(c, 'boards/', json('POST', { name, doc })),
  board: (c: Conn, id: string) => call<Board>(c, `boards/${id}/`),
  rename: (c: Conn, id: string, name: string) => call<BoardBrief>(c, `boards/${id}/`, json('PATCH', { name })),
  remove: (c: Conn, id: string) => call<void>(c, `boards/${id}/`, json('DELETE')),
  ops: (c: Conn, id: string, ops: Op[], clientId: string) => call<{ version: number }>(c, `boards/${id}/ops/`, json('POST', { ops, client_id: clientId })),
  addMember: (c: Conn, id: string, userId: string, role: Role) => call<Board>(c, `boards/${id}/members/`, json('POST', { user_id: userId, role })),
  setRole: (c: Conn, id: string, userId: string, role: Role) => call<Board>(c, `boards/${id}/members/${userId}/`, json('PATCH', { role })),
  removeMember: (c: Conn, id: string, userId: string) => call<void>(c, `boards/${id}/members/${userId}/`, json('DELETE')),
  users: (c: Conn, q: string) => call<UserBrief[]>(c, `users/?q=${encodeURIComponent(q)}`),
};
