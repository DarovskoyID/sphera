import { ENTRY_PIN_KEY } from './entryPoint';

/** A legacy plaintext cache is never a proof of a mesh message. */
export function legacyMessageCacheKey(server: string, user: string | undefined, conversation: string,
  token: string, meshHistory: boolean, storage?: Pick<Storage, 'getItem'>): string | null {
  try {
    if (meshHistory || (storage ?? localStorage).getItem(ENTRY_PIN_KEY) !== null) return null;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!user || !uuid.test(user) || !uuid.test(conversation)) return null;
    const address = new URL(server);
    if (address.username || address.password || address.pathname !== '/' || address.search || address.hash ||
        (address.protocol !== 'https:' && !(address.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)))) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(payload.padEnd(payload.length + ((4 - payload.length % 4) % 4), '=')));
    if (!claims || claims.user_id !== user || 'mesh_session' in claims) return null;
    return JSON.stringify(['sfera-messages-v3', address.origin, user, conversation]);
  } catch { return null; }
}
