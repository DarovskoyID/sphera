// Адрес сайта не зашит в код: сборка получает его из секрета SFERA_DOMAIN
// (VITE_SFERA_DOMAIN, см. scripts/linux/start-common.sh). Веб-сборка без него
// ходит на тот хост, с которого открыта.
const PAGE_HOST =
  typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? location.hostname : '';
export const APP_HOST: string = import.meta.env.VITE_SFERA_DOMAIN || PAGE_HOST;

export const API_PROTOCOL = 'https';
// API идёт по стандартному 443 (без явного порта). Нестандартный 8000 режут
// многие мобильные операторы / публичный Wi-Fi / корпоративные фаерволы —
// из-за этого логин падал с «ошибкой сети», хотя push-уведомления (FCM, 443)
// проходили. Сервер отдаёт тот же Django и на 443 (nginx-прокси).
export const API_PORT = 443;
export const API_BASE_URL = `${API_PROTOCOL}://${APP_HOST}`;

// WebSocket-трафик идёт не напрямую на Daphne, а на балансировщик нагрузки
// (см. loadbalancer/), который слушает на отдельном порту и распределяет
// соединения между нодами ws-gateway.
export const WS_PORT = 8001;
export const WS_BASE_URL = `wss://${APP_HOST}:${WS_PORT}`;

// Преобразует базовый URL сервера API (https://host) в адрес WebSocket
// через балансировщик (wss://host:8001). Используется во всех WS-подключениях.
export function wsUrlFor(serverIP: string): string {
  try {
    const u = new URL(serverIP);
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${u.hostname}:${WS_PORT}`;
  } catch {
    // Фолбэк на случай нестандартного значения: меняем только схему.
    return serverIP.replace(/^http/, 'ws');
  }
}

export const TURN_HOST = APP_HOST;
export const TURN_PORT = 3478;
export const TURN_USERNAME = 'sferauser';
export const TURN_CREDENTIAL = 'sferaturn123';

export const SERVER_IPS: string[] = [API_BASE_URL];

export const getIceServers = (entry?: ServerEntry | null): RTCIceServer[] => {
  const host = entry?.turn_host || TURN_HOST;
  const port = entry?.turn_port || TURN_PORT;
  const user = entry?.turn_username || TURN_USERNAME;
  const cred = entry?.turn_credential || TURN_CREDENTIAL;
  return [
    { urls: `stun:${host}:${port}` },
    {
      urls: [
        `turn:${host}:${port}?transport=udp`,
        `turn:${host}:${port}?transport=tcp`,
      ],
      username: user,
      credential: cred,
    },
  ];
};

/**
 * Запрашивает у бэкенда сбалансированный набор ICE-серверов (round-robin TURN-
 * нода из пула, /api/turn/). Возвращает null при любой ошибке — вызывающий
 * откатывается на статический getIceServers(), так что звонки не ломаются.
 */
export async function fetchPoolIceServers(
  serverIP: string,
  token: string,
): Promise<RTCIceServer[] | null> {
  try {
    const res = await fetch(`${serverIP}/api/turn/`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data?.iceServers) && data.iceServers.length ? data.iceServers : null;
  } catch {
    return null;
  }
}

// ── Dynamic server list (localStorage-backed) ──────────────────────────────

export interface ServerEntry {
  url: string;
  name: string;
  turn_host?: string;
  turn_port?: number;
  turn_username?: string;
  turn_credential?: string;
}

const LS_SERVERS_KEY = 'sfera_servers';
const LS_SELECTED_KEY = 'sfera_selected_server';

const DEFAULT_SERVERS: ServerEntry[] = [
  { url: API_BASE_URL, name: 'Main', turn_host: TURN_HOST, turn_port: TURN_PORT, turn_username: TURN_USERNAME, turn_credential: TURN_CREDENTIAL },
];

export function loadServers(): ServerEntry[] {
  try {
    const raw = localStorage.getItem(LS_SERVERS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ServerEntry[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        const main = DEFAULT_SERVERS[0];
        return parsed.map(s => s.url === main.url ? { ...main, ...s, turn_host: main.turn_host, turn_port: main.turn_port, turn_username: main.turn_username, turn_credential: main.turn_credential } : s);
      }
    }
  } catch { /* ignore */ }
  return [...DEFAULT_SERVERS];
}

export function saveServers(servers: ServerEntry[]) {
  localStorage.setItem(LS_SERVERS_KEY, JSON.stringify(servers));
}

export function loadSelectedServer(): string {
  return localStorage.getItem(LS_SELECTED_KEY) || API_BASE_URL;
}

export function saveSelectedServer(url: string) {
  localStorage.setItem(LS_SELECTED_KEY, url);
}

export function getSelectedServerEntry(): ServerEntry | null {
  const url = loadSelectedServer();
  const servers = loadServers();
  return servers.find(s => s.url === url) || null;
}

export function getResolvedTurn(entry?: ServerEntry | null) {
  return {
    host: entry?.turn_host || TURN_HOST,
    port: entry?.turn_port || TURN_PORT,
    username: entry?.turn_username || TURN_USERNAME,
    credential: entry?.turn_credential || TURN_CREDENTIAL,
    isDefault: !entry?.turn_host,
  };
}

export async function pingStun(host: string, port: number, username?: string, credential?: string): Promise<boolean | 'local'> {
  const isLocal = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  return new Promise(resolve => {
    try {
      const iceServers: RTCIceServer[] = [{ urls: `stun:${host}:${port}` }];
      if (username && credential) {
        iceServers.push({
          urls: [`turn:${host}:${port}?transport=udp`, `turn:${host}:${port}?transport=tcp`],
          username,
          credential,
        });
      }
      const pc = new RTCPeerConnection({ iceServers });
      let done = false;
      const finish = (result: boolean | 'local') => { if (!done) { done = true; clearTimeout(timer); pc.close(); resolve(result); } };
      const timer = setTimeout(() => finish(isLocal ? 'local' : false), 5000);
      pc.createDataChannel('');
      pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(() => finish(false));
      pc.onicecandidate = e => {
        if (done || !e.candidate) return;
        if (e.candidate.type === 'srflx' || e.candidate.type === 'relay') finish(true);
      };
      pc.onicegatheringstatechange = () => {
        if (!done && pc.iceGatheringState === 'complete') finish(isLocal ? 'local' : false);
      };
    } catch { resolve(false); }
  });
}

export async function pingServer(url: string): Promise<number | null> {
  const start = performance.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    await fetch(`${url}/api/auth/me/`, { method: 'HEAD', mode: 'no-cors', signal: controller.signal });
    clearTimeout(timer);
    return Math.round(performance.now() - start);
  } catch {
    return null;
  }
}
