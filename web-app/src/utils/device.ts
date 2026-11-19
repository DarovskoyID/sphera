// Stable per-install device identity used for the "Devices" / active sessions
// list. The server used to key devices by IP address, which both merged
// different devices behind the same NAT and duplicated one device across
// networks. Instead the client generates a persistent id and reports an
// accurate name/type, sent on every authenticated request via headers.

const DEVICE_ID_KEY = 'sfera.deviceId';

/** Persistent random id for this browser/app install. */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return 'unknown';
  }
}

export type DeviceType = 'mobile' | 'tablet' | 'desktop';

export interface DeviceInfo {
  /** Human-friendly label, e.g. "Chrome on Windows". */
  name: string;
  type: DeviceType;
}

/** Detect a friendly device name and type from the current environment. */
export function getDeviceInfo(): DeviceInfo {
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string; mobile?: boolean; brands?: { brand: string }[] };
    platform?: string;
  };
  const ua = navigator.userAgent || '';
  const platform = String(nav.userAgentData?.platform || nav.platform || '');
  const touchPoints = navigator.maxTouchPoints || 0;
  const isCapacitor = !!(window as unknown as { Capacitor?: unknown }).Capacitor;

  // ── OS ──────────────────────────────────────────────────────────────────
  let os = 'Unknown OS';
  if (/Windows|Win32|Win64/i.test(ua) || /Win/i.test(platform)) os = 'Windows';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPod/i.test(ua)) os = 'iOS';
  else if (/iPad/i.test(ua) || (/Mac/i.test(platform) && touchPoints > 1)) os = 'iPadOS';
  else if (/Mac/i.test(ua) || /Mac/i.test(platform)) os = 'macOS';
  else if (/CrOS/i.test(ua)) os = 'ChromeOS';
  else if (/Linux/i.test(ua) || /Linux/i.test(platform)) os = 'Linux';

  // ── Browser / app shell (order matters) ─────────────────────────────────
  let browser = 'Browser';
  if (/Electron/i.test(ua)) browser = 'Сфера Desktop';
  else if (isCapacitor) browser = 'Сфера App';
  else if (/Edg(A|iOS|)\//i.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/i.test(ua)) browser = 'Samsung Internet';
  else if (/Firefox|FxiOS/i.test(ua)) browser = 'Firefox';
  else if (/CriOS/i.test(ua)) browser = 'Chrome';
  else if (/Chrome|Chromium/i.test(ua)) browser = 'Chrome';
  else if (/Safari/i.test(ua)) browser = 'Safari';

  // ── Type ────────────────────────────────────────────────────────────────
  let type: DeviceType = 'desktop';
  if (os === 'iPadOS' || /Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) {
    type = 'tablet';
  } else if (
    nav.userAgentData?.mobile === true ||
    /Mobile|iPhone|iPod|Android/i.test(ua) ||
    (isCapacitor && touchPoints > 0)
  ) {
    type = 'mobile';
  }

  return { name: `${browser} on ${os}`, type };
}

/**
 * Device identity as URL query params. Sent on the /me request instead of
 * custom headers — custom headers trigger a CORS preflight that the server
 * would have to explicitly allow, whereas query params on a GET do not.
 */
export function deviceQuery(): string {
  const info = getDeviceInfo();
  const p = new URLSearchParams({
    device_id: getDeviceId(),
    device_name: info.name,
    device_type: info.type,
  });
  return p.toString();
}
