import type { UserBrief } from './ui';

export type Kind = 'internal' | 'private' | 'external';

export interface Conference {
  id: string;
  slug: string;
  title: string;
  description: string;
  kind: Kind;
  owner: UserBrief;
  invited: UserBrief[];
  starts_at: string | null;
  guest_lobby: boolean;
  created_at: string;
  ended_at: string | null;
  is_host: boolean;
  participants: number;
}

export interface JoinInfo {
  conference: { id: string; slug: string; title: string; kind: Kind };
  identity: string;
  name: string;
  host: boolean;
  media: { mode: 'mesh' } | { mode: 'livekit'; url: string; token: string };
  ws_path: string;
}

export interface PublicInfo {
  slug: string;
  kind: Kind;
  active: boolean;
  login_required: boolean;
  title?: string;
  owner?: string;
  starts_at?: string | null;
  guest_lobby?: boolean;
}

export interface Conn {
  token: string;
  serverIP: string;
}

async function call<T>(conn: Conn, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${conn.serverIP}/api/conference/${path}`, {
    ...init,
    headers: {
      ...(conn.token ? { Authorization: `Bearer ${conn.token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status, body });
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export interface CreateBody {
  title: string;
  kind: Kind;
  description?: string;
  starts_at?: string | null;
  invitee_ids?: string[];
  guest_lobby?: boolean;
}

export const api = {
  list: (c: Conn, scope: 'active' | 'ended' = 'active') => call<Conference[]>(c, `conferences/?scope=${scope}`),
  create: (c: Conn, body: CreateBody) => call<Conference>(c, 'conferences/', json('POST', body)),
  get: (c: Conn, slug: string) => call<Conference>(c, `conferences/${slug}/`),
  update: (c: Conn, slug: string, body: Partial<CreateBody> & { reopen?: boolean }) => call<Conference>(c, `conferences/${slug}/`, json('PATCH', body)),
  remove: (c: Conn, slug: string) => call<void>(c, `conferences/${slug}/`, json('DELETE')),
  end: (c: Conn, slug: string) => call<Conference>(c, `conferences/${slug}/end/`, json('POST', {})),
  join: (c: Conn, slug: string, guestPass?: string) => call<JoinInfo>(c, `conferences/${slug}/join/`, json('POST', guestPass ? { guest_pass: guestPass } : {})),
  publicInfo: (serverIP: string, slug: string) => call<PublicInfo>({ serverIP, token: '' }, `public/${slug}/`),
  guest: (serverIP: string, slug: string, name: string) =>
    call<{ guest_pass: string; guest_id: string; name: string }>({ serverIP, token: '' }, `public/${slug}/guest/`, json('POST', { name })),
  settings: (c: Conn) => call<MediaSettings>(c, 'settings/'),
  saveSettings: (c: Conn, body: Partial<MediaSettings>) => call<MediaSettings>(c, 'settings/', json('PUT', body)),
  users: (c: Conn, q: string) => call<UserBrief[]>(c, `users/?q=${encodeURIComponent(q)}`),
};

export interface MediaSettings {
  livekit_url: string;
  livekit_api_key: string;
  livekit_api_secret: string;
  mode: 'livekit' | 'mesh';
  from_env: boolean;
}

/** Link that opens the conference in the app, for members and for guests. */
export function conferenceLink(slug: string) {
  const url = new URL(window.location.href);
  url.hash = '';
  url.search = '';
  url.searchParams.set('conf', slug);
  return url.toString();
}

export function slugFromLocation(): string | null {
  const q = new URLSearchParams(window.location.search).get('conf');
  if (q && /^[A-Za-z0-9]{6,24}$/.test(q)) return q;
  const m = /#\/?conf\/([A-Za-z0-9]{6,24})/.exec(window.location.hash);
  return m ? m[1] : null;
}

export function clearLocationSlug() {
  const url = new URL(window.location.href);
  url.searchParams.delete('conf');
  if (/#\/?conf\//.test(url.hash)) url.hash = '';
  window.history.replaceState(null, '', url.toString());
}
