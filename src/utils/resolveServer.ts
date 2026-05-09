import { SERVER_IPS } from '../config/servers';

const TIMEOUT_MS = 3000;

const pageIsHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';

/** Upgrade http:// → https:// when the page itself is loaded over HTTPS. */
export function upgradeProtocol(url: string): string {
  if (!pageIsHttps) return url;
  if (url.startsWith('http://')) return 'https://' + url.slice('http://'.length);
  return url;
}

/**
 * Probes each IP from SERVER_IPS in parallel.
 * Returns the first one that responds (any HTTP status counts —
 * a 401/404 still means the server is reachable).
 * Falls back to the first entry if all fail.
 */
export async function resolveServerIP(): Promise<string> {
  if (SERVER_IPS.length === 0) return '';
  if (SERVER_IPS.length === 1) return SERVER_IPS[0];

  const tryIP = (ip: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Timeout: ${ip}`));
      }, TIMEOUT_MS);

      fetch(`${ip}/api/auth/me/`, {
        method: 'GET',
        signal: controller.signal,
      })
        .then(() => { clearTimeout(timer); resolve(ip); })
        .catch(err => { clearTimeout(timer); reject(err); });
    });

  try {
    return await Promise.any(SERVER_IPS.map(tryIP));
  } catch {
    // All failed — fall back to first entry
    return SERVER_IPS[0];
  }
}
