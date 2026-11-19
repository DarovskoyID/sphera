// Bridge between the web UI and the native shells (Kotlin / Swift) that host it
// in a WebView.
//
// The web side owns a small set of preferences that only the shell can act on —
// whether pinch-to-zoom is allowed, whether notifications should be delivered by
// the system rather than the browser, and so on. The UI writes them here; the
// shell reads them and applies them to the window it owns.
//
// ── Reading the preferences from the shell ───────────────────────────────────
// Three ways, all carrying the same JSON object. Pick whichever fits.
//
//   1. Synchronous getter (recommended — always current):
//        Android (Kotlin):
//          webView.evaluateJavascript("window.SferaNative.getPrefs()") { json ->
//              val prefs = JSONObject(json.trim('"').replace("\\\"", "\""))
//          }
//        iOS (Swift):
//          webView.evaluateJavaScript("window.SferaNative.getPrefs()") { result, _ in }
//
//   2. localStorage, read once at startup, before the page is even loaded:
//        key "sfera.native.prefs" -> the same JSON object
//
//   3. Push callbacks, fired immediately on every change:
//        Android: add a @JavascriptInterface object named `SferaNativeBridge`
//                 with `fun onPrefsChanged(json: String)`.
//        iOS:     add a WKScriptMessageHandler named `sferaPrefs`; the message
//                 body is the preferences object.
//
// A `sfera:nativePrefsChanged` DOM event carries the same payload, for anything
// on the web side that wants to listen.
//
// ── Telling the web UI it is inside the shell ────────────────────────────────
// Append a product token to the WebView's user agent:
//     settings.userAgentString = settings.userAgentString + " SferaApp/1"
// `isNativeShell()` keys off that, so the UI can show shell-only settings and
// keep the session alive indefinitely. See docs/ANDROID_WEBVIEW.md.

/** Preferences the native shell applies to the window it owns. */
export interface NativePrefs {
  /** Allow pinch-to-zoom and text scaling. */
  allowScale: boolean;
  /** Deliver notifications through the system tray instead of the browser. */
  pushNotifications: boolean;
  /** Vibrate on notifications, long-presses and call events. */
  haptics: boolean;
  /** Hold the screen awake during a call. */
  keepScreenOn: boolean;
  /** Hide the status and navigation bars (immersive full screen). */
  immersive: boolean;
}

const PREFS_KEY = 'sfera.native.prefs';
/** Written alongside the object so an older shell build keeps working. */
const LEGACY_SCALE_KEY = 'sfera.allowScale';

export const defaultNativePrefs: NativePrefs = {
  allowScale: false,
  pushNotifications: true,
  haptics: true,
  keepScreenOn: true,
  immersive: false,
};

export type NativeTheme = 'light' | 'dark';

declare global {
  interface Window {
    SferaNative?: {
      getPrefs: () => string;
      getAllowScale: () => boolean;
    };
    SferaNativeBridge?: {
      onPrefsChanged?: (json: string) => void;
      onNotify?: (json: string) => void;
      onHaptic?: (json: string) => void;
    };
    SferaScaleBridge?: { onAllowScaleChanged?: (allow: boolean) => void };
    chrome?: { webview?: { postMessage: (msg: unknown) => void } };
    webkit?: { messageHandlers?: Record<string, { postMessage: (msg: unknown) => void }> };
  }
}

let prefs: NativePrefs = { ...defaultNativePrefs };

/** The current preferences. */
export function getNativePrefs(): NativePrefs {
  return { ...prefs };
}

/**
 * True when the page is running inside one of the native shells.
 *
 * The user agent token is the reliable signal — the JavaScript interfaces are
 * injected asynchronously and may not exist yet on the first frame.
 */
export function isNativeShell(): boolean {
  if (typeof window === 'undefined') return false;
  if (/SferaApp\//i.test(navigator.userAgent || '')) return true;
  return !!(window.SferaNativeBridge || window.webkit?.messageHandlers?.sferaPrefs);
}

function publish() {
  if (typeof window === 'undefined') return;
  const json = JSON.stringify(prefs);

  try { localStorage.setItem(PREFS_KEY, json); } catch { /* full or blocked */ }
  try { localStorage.setItem(LEGACY_SCALE_KEY, prefs.allowScale ? 'true' : 'false'); } catch { /* ignore */ }

  // 1. Synchronous getters for evaluateJavascript / evaluateJavaScript.
  window.SferaNative = {
    getPrefs: () => JSON.stringify(prefs),
    getAllowScale: () => prefs.allowScale,
  };

  // 3a. Android @JavascriptInterface push callbacks.
  try { window.SferaNativeBridge?.onPrefsChanged?.(json); } catch { /* ignore */ }
  try { window.SferaScaleBridge?.onAllowScaleChanged?.(prefs.allowScale); } catch { /* ignore */ }

  // 3b. iOS WKScriptMessageHandler push callbacks.
  try { window.webkit?.messageHandlers?.sferaPrefs?.postMessage(prefs); } catch { /* ignore */ }
  try { window.webkit?.messageHandlers?.sferaAllowScale?.postMessage(prefs.allowScale); } catch { /* ignore */ }

  try {
    window.dispatchEvent(new CustomEvent('sfera:nativePrefsChanged', { detail: { ...prefs } }));
  } catch { /* ignore */ }
}

/**
 * Merge a patch into the preferences and notify the shell.
 *
 * A patch that changes nothing is dropped rather than republished: settings are
 * re-applied on every render pass, and the shell should not be woken for them.
 */
export function setNativePrefs(patch: Partial<NativePrefs>): void {
  let changed = false;
  const next = { ...prefs };
  for (const key of Object.keys(defaultNativePrefs) as (keyof NativePrefs)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    if (next[key] !== !!value) { next[key] = !!value; changed = true; }
  }
  if (!changed) return;
  prefs = next;
  publish();
}

/** The zoom preference on its own — the first one that existed, still used. */
export function getAllowScale(): boolean {
  return prefs.allowScale;
}

/** @see setNativePrefs */
export function setAllowScale(value: boolean): void {
  setNativePrefs({ allowScale: value });
}

/** What the shell is asked to raise in the system tray. */
export interface NativeNotification {
  kind: string;
  title: string;
  body: string;
  /** Ring until dismissed, rather than a transient banner. */
  ongoing?: boolean;
}

/**
 * Hand a notification to the shell's system tray.
 *
 * Returns false when nobody took it — outside the app, or with the preference
 * off — and the caller should fall back to the browser Notification API.
 */
export function nativeNotify(notification: NativeNotification): boolean {
  if (typeof window === 'undefined') return false;
  if (!isNativeShell() || !prefs.pushNotifications) return false;

  const payload = { ...notification, haptics: prefs.haptics };
  try {
    if (window.SferaNativeBridge?.onNotify) {
      window.SferaNativeBridge.onNotify(JSON.stringify(payload));
      return true;
    }
  } catch { /* fall through */ }
  try {
    const handler = window.webkit?.messageHandlers?.sferaNotify;
    if (handler) { handler.postMessage(payload); return true; }
  } catch { /* fall through */ }
  return false;
}

/** Ask the shell to vibrate; falls back to the web Vibration API. */
export function nativeHaptic(pattern: number | number[] = 15): void {
  if (typeof window === 'undefined' || !prefs.haptics) return;
  try {
    if (window.SferaNativeBridge?.onHaptic) {
      window.SferaNativeBridge.onHaptic(JSON.stringify(pattern));
      return;
    }
  } catch { /* fall through */ }
  try { navigator.vibrate?.(pattern); } catch { /* unsupported */ }
}

function rgbToHex(value: string): string {
  const match = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([.\d]+))?/i);
  if (!match) return '';
  if (match[4] !== undefined && Number(match[4]) === 0) return '';
  return [match[1], match[2], match[3]]
    .map((part) => Math.max(0, Math.min(255, Number(part))).toString(16).padStart(2, '0'))
    .join('')
    .replace(/^/, '#');
}

function readThemeColor(theme: NativeTheme): string {
  if (typeof window === 'undefined') return theme === 'dark' ? '#101012' : '#f5f6fa';

  const candidates = [
    document.querySelector('.app-container'),
    document.querySelector('.main-content'),
    document.querySelector('.chat-area'),
    document.body,
    document.documentElement,
  ];

  for (const element of candidates) {
    if (!(element instanceof Element)) continue;
    const color = rgbToHex(getComputedStyle(element).backgroundColor);
    if (color) return color;
  }

  return theme === 'dark' ? '#101012' : '#f5f6fa';
}

export function postNativeTheme(theme: NativeTheme): void {
  if (typeof window === 'undefined') return;

  const send = () => {
    const color = readThemeColor(theme);
    try {
      window.chrome?.webview?.postMessage({ type: 'theme', theme, color });
    } catch { /* ignore */ }
    // The Android and iOS shells tint their system bars from the same value.
    try { window.SferaNativeBridge?.onPrefsChanged?.(JSON.stringify({ ...prefs, theme, themeColor: color })); } catch { /* ignore */ }
    try { window.webkit?.messageHandlers?.sferaTheme?.postMessage({ theme, color }); } catch { /* ignore */ }
  };

  send();
  requestAnimationFrame(send);
  window.setTimeout(send, 80);
}

/**
 * Restore the preferences and install the getters. Call once at startup, before
 * the first render, so the shell never reads a default it will have to undo.
 */
export function initNativeBridge(): void {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const stored = JSON.parse(raw);
      if (stored && typeof stored === 'object') {
        for (const key of Object.keys(defaultNativePrefs) as (keyof NativePrefs)[]) {
          if (typeof stored[key] === 'boolean') prefs[key] = stored[key];
        }
      }
    } else {
      // Upgrade from the era when zoom was the only preference.
      const legacy = localStorage.getItem(LEGACY_SCALE_KEY);
      if (legacy !== null) prefs.allowScale = legacy === 'true';
    }
  } catch { /* defaults */ }

  if (typeof window !== 'undefined') {
    window.SferaNative = {
      getPrefs: () => JSON.stringify(prefs),
      getAllowScale: () => prefs.allowScale,
    };
    if (isNativeShell()) document.documentElement.classList.add('native-shell');
  }
}
