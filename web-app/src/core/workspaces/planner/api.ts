import type { UserBrief } from './ui';
import type { Column, Comment, Project, ProjectBrief, Role, Task } from './types';

export interface Conn {
  token: string;
  serverIP: string;
}

async function call<T>(conn: Conn, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${conn.serverIP}/api/planner/${path}`, {
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

export type TaskPatch = Partial<Omit<Task, 'assignees' | 'id'>> & { assignee_ids?: string[]; done?: boolean };

export const api = {
  projects: (c: Conn) => call<ProjectBrief[]>(c, 'projects/'),
  createProject: (c: Conn, name: string, color: string) => call<Project>(c, 'projects/', json('POST', { name, color })),
  project: (c: Conn, id: string) => call<Project>(c, `projects/${id}/`),
  updateProject: (c: Conn, id: string, body: { name?: string; color?: string }) => call<ProjectBrief>(c, `projects/${id}/`, json('PATCH', body)),
  deleteProject: (c: Conn, id: string) => call<void>(c, `projects/${id}/`, json('DELETE')),

  addMember: (c: Conn, id: string, userId: string, role: Role) => call<Project>(c, `projects/${id}/members/`, json('POST', { user_id: userId, role })),
  setMemberRole: (c: Conn, id: string, userId: string, role: Role) => call<Project>(c, `projects/${id}/members/${userId}/`, json('PATCH', { role })),
  removeMember: (c: Conn, id: string, userId: string) => call<void>(c, `projects/${id}/members/${userId}/`, json('DELETE')),

  addColumn: (c: Conn, id: string, title: string) => call<Column>(c, `projects/${id}/columns/`, json('POST', { title })),
  updateColumn: (c: Conn, columnId: string, body: Partial<Column>) => call<Column>(c, `columns/${columnId}/`, json('PATCH', body)),
  deleteColumn: (c: Conn, columnId: string) => call<void>(c, `columns/${columnId}/`, json('DELETE')),

  addTask: (c: Conn, projectId: string, body: TaskPatch) => call<Task>(c, `projects/${projectId}/tasks/`, json('POST', body)),
  updateTask: (c: Conn, taskId: string, body: TaskPatch) => call<Task & { next?: Task }>(c, `tasks/${taskId}/`, json('PATCH', body)),
  deleteTask: (c: Conn, taskId: string) => call<void>(c, `tasks/${taskId}/`, json('DELETE')),
  comments: (c: Conn, taskId: string) => call<Comment[]>(c, `tasks/${taskId}/comments/`),
  addComment: (c: Conn, taskId: string, text: string) => call<Comment[]>(c, `tasks/${taskId}/comments/`, json('POST', { text })),

  my: (c: Conn, params: { scope?: 'all'; from?: string; to?: string; open?: boolean }) => {
    const q = new URLSearchParams();
    if (params.scope) q.set('scope', params.scope);
    if (params.from) q.set('from', params.from);
    if (params.to) q.set('to', params.to);
    if (params.open) q.set('open', '1');
    return call<Task[]>(c, `my/?${q}`);
  },
  reminders: (c: Conn) => call<Task[]>(c, 'reminders/', json('POST', {})),
  users: (c: Conn, q: string) => call<UserBrief[]>(c, `users/?q=${encodeURIComponent(q)}`),
};
