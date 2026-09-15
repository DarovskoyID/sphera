import type { LogEvent } from './kit';
import type { UserBrief } from './ui';

export interface Conn {
  token: string;
  serverIP: string;
}

export interface Status {
  configured: boolean;
  account_name: string;
  domain: string;
  can_act: boolean;
  can_manage: boolean;
}

export interface Settings {
  domain: string;
  access_token: string;
  oauth: boolean;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  pipeline_id: number | null;
  webhook_path: string;
  notify_users: UserBrief[];
  allowed_users: UserBrief[];
  account_name: string;
  configured: boolean;
  last_error: string;
}

export interface Pipeline {
  id: number;
  name: string;
  statuses: { id: number; name: string; color?: string }[];
}

export interface SearchResult {
  leads: { id: number; name: string; price: number | null; status_id: number; pipeline_id: number; url: string }[];
  contacts: { id: number; name: string; url: string; phones: string[]; emails: string[] }[];
}

async function call<T>(conn: Conn, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${conn.serverIP}/api/amocrm/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${conn.token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.detail || body.error || `HTTP ${res.status}`), { status: res.status, body });
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export interface LeadBody {
  name: string;
  price?: string;
  contact_name?: string;
  phone?: string;
  email?: string;
  note?: string;
  pipeline_id?: number | null;
  task_text?: string;
  task_due?: number;
}

export const api = {
  status: (c: Conn) => call<Status>(c, 'status/'),
  settings: (c: Conn) => call<Settings>(c, 'settings/'),
  saveSettings: (c: Conn, body: Record<string, unknown>) => call<Settings>(c, 'settings/', json('PUT', body)),
  pipelines: (c: Conn) => call<Pipeline[]>(c, 'pipelines/'),
  createLead: (c: Conn, body: LeadBody) => call<{ id: number; contact_id: number; url: string }>(c, 'leads/', json('POST', body)),
  addNote: (c: Conn, leadId: number, text: string) => call<{ ok: boolean }>(c, `leads/${leadId}/notes/`, json('POST', { text })),
  search: (c: Conn, q: string) => call<SearchResult>(c, `search/?q=${encodeURIComponent(q)}`),
  events: (c: Conn, direction?: 'in' | 'out') => call<LogEvent[]>(c, `events/${direction ? `?direction=${direction}` : ''}`),
  users: (c: Conn, q: string) => call<UserBrief[]>(c, `users/?q=${encodeURIComponent(q)}`),
};
