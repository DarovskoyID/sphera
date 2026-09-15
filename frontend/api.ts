import type { LogEvent } from './kit';
import type { UserBrief } from './ui';

export interface Conn {
  token: string;
  serverIP: string;
}

export interface Status {
  configured: boolean;
  can_act: boolean;
  can_manage: boolean;
  entities: { counterparty: string; product: string; document: string };
}

export interface Settings {
  base_url: string;
  username: string;
  password: string;
  counterparty_entity: string;
  product_entity: string;
  document_entity: string;
  document_counterparty_field: string;
  inn_field: string;
  inbound_path: string;
  notify_users: UserBrief[];
  allowed_users: UserBrief[];
  entity_sets: string[];
  configured: boolean;
  last_error: string;
}

export interface Brief {
  key: string;
  entity: string;
  title: string;
  subtitle: string;
}

export interface RecordData {
  brief: Brief;
  fields: { name: string; value: string | number | boolean }[];
  documents?: Brief[];
}

async function call<T>(conn: Conn, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${conn.serverIP}/api/onec/${path}`, {
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
  entitySets: (c: Conn) => call<string[]>(c, 'entity-sets/'),
  search: (c: Conn, entity: string, q: string) => call<Brief[]>(c, `search/?entity=${encodeURIComponent(entity)}&q=${encodeURIComponent(q)}`),
  record: (c: Conn, entity: string, key: string) => call<RecordData>(c, `records/${encodeURIComponent(entity)}/${key}/`),
  createCounterparty: (c: Conn, body: { name: string; inn?: string; comment?: string }) => call<Brief>(c, 'counterparties/', json('POST', body)),
  events: (c: Conn, direction?: 'in' | 'out') => call<LogEvent[]>(c, `events/${direction ? `?direction=${direction}` : ''}`),
  users: (c: Conn, q: string) => call<UserBrief[]>(c, `users/?q=${encodeURIComponent(q)}`),
};

/** "Catalog_Контрагенты" → "Контрагенты" for people. */
export function entityLabel(name: string) {
  return name.replace(/^[A-Za-z]+_/, '').replace(/([а-яё])([А-ЯЁ])/g, '$1 $2');
}
