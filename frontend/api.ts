import type { UserBrief } from './ui';

export interface Conn {
  token: string;
  serverIP: string;
}

export interface Status {
  enabled: boolean;
  pending: boolean;
  required_for_all: boolean;
  must_enable: boolean;
  backup_codes_left: number;
  can_manage: boolean;
  issuer: string;
  confirmed_at: string | null;
  last_used_at: string | null;
}

export interface Setup {
  secret: string;
  uri: string;
  digits: number;
  period: number;
  issuer: string;
}

export interface ServerSettings {
  required_for_all: boolean;
  issuer: string;
  users_total: number;
  users_with_totp: number;
}

export type Person = UserBrief & { totp: boolean; is_superuser: boolean };

async function call<T>(conn: Conn, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${conn.serverIP}/api/totp/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${conn.token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status, body });
  return body as T;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  status: (c: Conn) => call<Status>(c, 'status/'),
  setup: (c: Conn) => call<Setup>(c, 'setup/', json('POST', {})),
  confirm: (c: Conn, code: string) => call<Status & { backup_codes: string[] }>(c, 'confirm/', json('POST', { code })),
  disable: (c: Conn, code: string) => call<Status>(c, 'disable/', json('POST', { code })),
  newBackupCodes: (c: Conn, code: string) => call<{ backup_codes: string[] }>(c, 'backup-codes/', json('POST', { code })),
  settings: (c: Conn) => call<ServerSettings>(c, 'settings/'),
  saveSettings: (c: Conn, body: Partial<ServerSettings>) => call<ServerSettings>(c, 'settings/', json('PUT', body)),
  people: (c: Conn, q = '') => call<Person[]>(c, `people/${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  resetPerson: (c: Conn, userId: string) => call<{ ok: boolean }>(c, `people/${userId}/reset/`, json('POST', {})),
};

/** The QR image for an otpauth:// link, drawn in the browser. */
export async function qrDataUrl(uri: string): Promise<string> {
  const QR = await import('qrcode');
  return QR.toDataURL(uri, { margin: 1, width: 232, errorCorrectionLevel: 'M' });
}
