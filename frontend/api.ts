import type { LogEvent } from './kit';
import type { UserBrief } from './ui';

export interface Conn {
  token: string;
  serverIP: string;
}

export interface Status {
  configured: boolean;
  portal: string;
  scopes: string[];
  can_act: boolean;
  can_manage: boolean;
}

export interface Settings {
  webhook_url: string;
  portal: string;
  application_token: string;
  default_responsible_id: number | null;
  inbound_path: string;
  notify_users: UserBrief[];
  allowed_users: UserBrief[];
  scopes: string[];
  configured: boolean;
  last_error: string;
}

export type Kind = 'lead' | 'deal' | 'task';

export interface CreateBody {
  title: string;
  name?: string;
  phone?: string;
  email?: string;
  comment?: string;
  amount?: string;
  responsible_id?: number | null;
  deadline?: string;
}

export interface PortalUser { id: number; name: string }

export interface SearchItem { id: number; title: string; amount?: string; phones?: string[]; emails?: string[]; url: string }
export interface SearchResult { leads: SearchItem[]; deals: SearchItem[]; contacts: SearchItem[] }

async function call<T>(conn: Conn, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${conn.serverIP}/api/bitrix/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${conn.token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.detail || body.error || `HTTP ${res.status}`), { status: res.status, body });
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const api = {
  status: (c: Conn) => call<Status>(c, 'status/'),
  settings: (c: Conn) => call<Settings>(c, 'settings/'),
  saveSettings: (c: Conn, body: Record<string, unknown>) => call<Settings>(c, 'settings/', json('PUT', body)),
  portalUsers: (c: Conn, q = '') => call<PortalUser[]>(c, `portal-users/?q=${encodeURIComponent(q)}`),
  create: (c: Conn, kind: Kind, body: CreateBody) => call<{ id: number; url: string }>(c, `create/${kind}/`, json('POST', body)),
  comment: (c: Conn, entity: string, id: number, text: string) => call<{ ok: boolean }>(c, `comment/${entity}/${id}/`, json('POST', { text })),
  search: (c: Conn, q: string) => call<SearchResult>(c, `search/?q=${encodeURIComponent(q)}`),
  events: (c: Conn, direction?: 'in' | 'out') => call<LogEvent[]>(c, `events/${direction ? `?direction=${direction}` : ''}`),
  users: (c: Conn, q: string) => call<UserBrief[]>(c, `users/?q=${encodeURIComponent(q)}`),
};
