/**
 * List of server IP addresses to try when connecting.
 * The app will attempt each in parallel and use the first
 * one that responds. Add or remove entries as needed.
 *
 * When the page itself is loaded over HTTPS, every entry below is
 * automatically upgraded to https:// so the browser doesn't block the
 * request as Mixed Content.  WebSocket URLs are derived later via
 * `replace(/^http/, 'ws')`, which produces wss:// in the same way.
 */

// Use the same origin the page was loaded from so nginx proxies /api/ and /ws/
// to Django — works for both HTTPS (bottomweb.ru:8082) and local HTTP (localhost:8084).
const origin = typeof window !== 'undefined' ? window.location.origin : '';
const isRealOrigin = origin
  && origin !== 'null'
  && !origin.startsWith('file://')
  && !origin.includes('appassets.androidplatform.net');
export const SERVER_IPS: string[] = isRealOrigin
  ? [origin]
  : ['https://bottomweb.ru:8082'];
