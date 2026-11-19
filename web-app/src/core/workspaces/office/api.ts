import type { UserBrief } from './ui';
import type { Comment, Data, DocBrief, DocFull, Kind, Op, Revision, Role } from './types';

export interface Conn {
  token: string;
  serverIP: string;
}

async function call<T>(conn: Conn, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${conn.serverIP}/api/office/${path}`, {
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
  docs: (c: Conn, kind?: Kind) => call<DocBrief[]>(c, `docs/${kind ? `?kind=${kind}` : ''}`),
  create: (c: Conn, kind: Kind, title: string, data?: Data) => call<DocFull>(c, 'docs/', json('POST', { kind, title, data })),
  doc: (c: Conn, id: string) => call<DocFull>(c, `docs/${id}/`),
  rename: (c: Conn, id: string, title: string) => call<DocBrief>(c, `docs/${id}/`, json('PATCH', { title })),
  remove: (c: Conn, id: string) => call<void>(c, `docs/${id}/`, json('DELETE')),
  ops: (c: Conn, id: string, ops: Op[], clientId: string) =>
    call<{ version: number }>(c, `docs/${id}/ops/`, json('POST', { ops, client_id: clientId })),
  history: (c: Conn, id: string) => call<Revision[]>(c, `docs/${id}/history/`),
  restore: (c: Conn, id: string, revisionId: string) => call<DocFull>(c, `docs/${id}/history/${revisionId}/restore/`, json('POST', {})),
  comments: (c: Conn, id: string, openOnly = false) => call<Comment[]>(c, `docs/${id}/comments/${openOnly ? '?open=1' : ''}`),
  comment: (c: Conn, id: string, anchor: string, text: string) => call<Comment>(c, `docs/${id}/comments/`, json('POST', { anchor, text })),
  resolveComment: (c: Conn, id: string, commentId: string, resolved: boolean) =>
    call<Comment>(c, `docs/${id}/comments/${commentId}/`, json('PATCH', { resolved })),
  removeComment: (c: Conn, id: string, commentId: string) => call<void>(c, `docs/${id}/comments/${commentId}/`, json('DELETE')),
  addMember: (c: Conn, id: string, userId: string, role: Role) => call<DocFull>(c, `docs/${id}/members/`, json('POST', { user_id: userId, role })),
  setRole: (c: Conn, id: string, userId: string, role: Role) => call<DocFull>(c, `docs/${id}/members/${userId}/`, json('PATCH', { role })),
  removeMember: (c: Conn, id: string, userId: string) => call<void>(c, `docs/${id}/members/${userId}/`, json('DELETE')),
  users: (c: Conn, q: string) => call<UserBrief[]>(c, `users/?q=${encodeURIComponent(q)}`),
};

export type Format = 'html' | 'md' | 'csv';

/** Documents sit behind the bearer token: fetch the bytes, then hand them to the browser. */
export async function download(conn: Conn, id: string, fmt: Format, title: string) {
  const res = await fetch(`${conn.serverIP.replace(/\/$/, '')}/api/office/docs/${id}/download/${fmt}/`, {
    headers: { Authorization: `Bearer ${conn.token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  if (fmt === 'html') {
    window.open(url, '_blank', 'noopener');
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^\p{L}\p{N} \-_]/gu, '').trim() || 'document'}.${fmt}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
