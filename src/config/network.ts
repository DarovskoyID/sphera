export const APP_HOST = 'start-ionik.ru';

export const API_PROTOCOL = 'https';
export const API_PORT = 8000;
export const API_BASE_URL = `${API_PROTOCOL}://${APP_HOST}:${API_PORT}`;

export const TURN_HOST = APP_HOST;
export const TURN_PORT = 3478;
export const TURN_USERNAME = 'ionikuser';
export const TURN_CREDENTIAL = 'ionikturn123';

const browserOrigin = typeof window !== 'undefined' ? window.location.origin : '';
const browserHostname = typeof window !== 'undefined' ? window.location.hostname : '';
const isRealBrowserOrigin = Boolean(
  browserOrigin
  && browserOrigin !== 'null'
  && !browserOrigin.startsWith('file://')
  && !browserHostname.includes('appassets.androidplatform.net')
);

export const SERVER_IPS: string[] = isRealBrowserOrigin
  ? [browserOrigin]
  : [API_BASE_URL];

export const getIceServers = (): RTCIceServer[] => [
  { urls: `stun:${TURN_HOST}:${TURN_PORT}` },
  {
    urls: [
      `turn:${TURN_HOST}:${TURN_PORT}?transport=udp`,
      `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`,
    ],
    username: TURN_USERNAME,
    credential: TURN_CREDENTIAL,
  },
];
