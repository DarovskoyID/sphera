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
export const SERVER_IPS: string[] = [
  typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:8000',
];
