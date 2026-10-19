import type { UserBrief } from './ui';

export interface Conn {
  token: string;
  serverIP: string;
}

export interface SignatureInfo {
  id: string;
  name: string;
  email: string;
  method: 'code' | 'file';
  signed_at: string;
  signed_hash: string;
  user_id: string | null;
  cert_subject: string;
  cert_fingerprint: string;
  cert_valid_to: string | null;
  note: string;
  matches_protocol: boolean;
}

export interface Protocol {
  id: string;
  code: string;
  title: string;
  scope: string;
  scope_title: string;
  status: 'draft' | 'sealed';
  message_count: number;
  participants: { id: string; username: string; name: string }[];
  content_hash: string;
  chain_ok: boolean | null;
  chain_note: string;
  has_timestamp: boolean;
  timestamp_at: string | null;
  period_from: string | null;
  period_to: string | null;
  created_at: string;
  sealed_at: string | null;
  owner: UserBrief;
  is_owner: boolean;
  signatures: SignatureInfo[];
  requests?: { id: string; email: string; user: UserBrief | null; signed_at: string | null }[];
}

export interface PublicInfo {
  code: string;
  title: string;
  sealed_at: string | null;
  content_hash: string;
  message_count: number;
  period_from: string | null;
  period_to: string | null;
  chain_ok: boolean | null;
  chain_note: string;
  has_timestamp: boolean;
  timestamp_at: string | null;
  participants: { name: string; username: string }[];
  signatures: { name: string; signed_at: string; method: string; matches_protocol: boolean; cert_subject: string; note: string }[];
  hash_matches: boolean | null;
}

export interface ChatScope {
  scope: string;
  title: string;
  participants: UserBrief[];
}

export interface Settings {
  record_chain: boolean;
  org_name: string;
  org_details: string;
  tsa_url: string;
  chain_links: number;
}

export interface Status {
  recording: boolean;
  can_manage: boolean;
  org_name: string;
  timestamps: boolean;
}

async function call<T>(conn: Conn, path: string, init: RequestInit = {}): Promise<T> {
  const isForm = init.body instanceof FormData;
  const res = await fetch(`${conn.serverIP}/api/legal/${path}`, {
    ...init,
    headers: {
      ...(conn.token ? { Authorization: `Bearer ${conn.token}` } : {}),
      ...(init.body && !isForm ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.detail || body.error || `HTTP ${res.status}`), { status: res.status, body });
  return body as T;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  status: (c: Conn) => call<Status>(c, 'status/'),
  settings: (c: Conn) => call<Settings>(c, 'settings/'),
  saveSettings: (c: Conn, body: Partial<Settings>) => call<Settings>(c, 'settings/', json('PUT', body)),
  conversations: (c: Conn) => call<ChatScope[]>(c, 'conversations/'),
  list: (c: Conn, offset = 0) => call<Protocol[]>(c, `packages/?offset=${offset}`),
  create: (c: Conn, body: { scope: string; title?: string; period_from?: string | null; period_to?: string | null }) =>
    call<Protocol>(c, 'packages/', json('POST', body)),
  get: (c: Conn, id: string, signal?: AbortSignal) => call<Protocol>(c, `packages/${id}/`, { signal }),
  remove: (c: Conn, id: string) => call<void>(c, `packages/${id}/`, json('DELETE')),
  seal: (c: Conn, id: string) => call<Protocol>(c, `packages/${id}/seal/`, json('POST', {})),
  requestCode: (c: Conn, id: string) => call<{ ok: boolean; email: string }>(c, `packages/${id}/code/`, json('POST', {})),
  signWithCode: (c: Conn, id: string, code: string) => call<SignatureInfo>(c, `packages/${id}/sign/`, json('POST', { code })),
  signWithFile: (c: Conn, id: string, file: File) => {
    const form = new FormData();
    form.append('signature', file, file.name);
    return call<SignatureInfo>(c, `packages/${id}/sign/`, { method: 'POST', body: form });
  },
  askSignature: (c: Conn, id: string, body: { user_id?: string; email?: string }) =>
    call<{ ok: boolean }>(c, `packages/${id}/request-signature/`, json('POST', body)),
  chain: (c: Conn, scope: string) => call<{ ok: boolean | null; note: string; links: number; recording: boolean }>(c, `chain/?scope=${encodeURIComponent(scope)}`),
  users: (c: Conn, q: string) => call<UserBrief[]>(c, `users/?q=${encodeURIComponent(q)}`),
  verify: (serverIP: string, code: string, hash?: string) =>
    call<PublicInfo>({ serverIP, token: '' }, `public/verify/${encodeURIComponent(code)}/${hash ? `?hash=${hash}` : ''}`),
};

export function downloadUrl(conn: Conn, id: string, fmt: 'html' | 'json' | 'tsr') {
  return `${conn.serverIP.replace(/\/$/, '')}/api/legal/packages/${id}/download/${fmt}/`;
}

/** Protocols are behind the bearer token: fetch, then hand the bytes to the browser. */
export async function downloadProtocol(conn: Conn, id: string, fmt: 'html' | 'json' | 'tsr', code: string) {
  const res = await fetch(downloadUrl(conn, id, fmt), { headers: { Authorization: `Bearer ${conn.token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  if (fmt === 'html') {
    // Opens the printable protocol; the browser prints it to PDF.
    window.open(url, '_blank', 'noopener');
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = `protocol-${code}.${fmt}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** SHA-256 of a file the user picked, to compare with the protocol's hash. */
export async function fileHash(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function verifyLinkFromLocation(): string | null {
  const q = new URLSearchParams(window.location.search).get('verify');
  return q && /^[A-Z0-9-]{6,20}$/i.test(q) ? q.toUpperCase() : null;
}

export function clearVerifyLink() {
  const url = new URL(window.location.href);
  url.searchParams.delete('verify');
  window.history.replaceState(null, '', url.toString());
}
