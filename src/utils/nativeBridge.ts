// Bridge for exposing WebView-relevant preferences to the native shells
// (Swift / Kotlin). The "allow scale" preference is the first such value:
// the native app decides whether to allow pinch-to-zoom, and it reads this.
//
// THREE ways the native side can read the value (pick whichever is easiest):
//
//   1. Synchronous getter (recommended):
//        Android (Kotlin):
//          webView.evaluateJavascript("window.SferaNative.getAllowScale()") { v ->
//              val allow = v == "true"
//          }
//        iOS (Swift):
//          webView.evaluateJavaScript("window.SferaNative.getAllowScale()") { result, _ in
//              let allow = (result as? Bool) ?? (result as? String == "true")
//          }
//
//   2. localStorage (read on startup):
//        key "sfera.allowScale" -> "true" | "false"
//
//   3. Push callbacks (fired immediately on every change) — implement either
//      hook on the native side and it will be called:
//        Android: add a @JavascriptInterface object named `SferaScaleBridge`
//                 with `fun onAllowScaleChanged(allow: Boolean)`.
//        iOS:     add a WKScriptMessageHandler named `sferaAllowScale`;
//                 message body is a Bool.

const LS_KEY = 'sfera.allowScale';

export type NativeTheme = 'light' | 'dark';

declare global {
  interface Window {
    SferaNative?: { getAllowScale: () => boolean };
    SferaScaleBridge?: { onAllowScaleChanged?: (allow: boolean) => void };
    chrome?: { webview?: { postMessage: (msg: unknown) => void } };
    webkit?: { messageHandlers?: Record<string, { postMessage: (msg: unknown) => void }> };
  }
}

let allowScale = false;

/** Read the last known value (also restored from localStorage on load). */
export function getAllowScale(): boolean {
  return allowScale;
}

/** Update the value, persist it, expose it globally and notify native shells. */
export function setAllowScale(value: boolean): void {
  allowScale = !!value;
  try { localStorage.setItem(LS_KEY, allowScale ? 'true' : 'false'); } catch { /* ignore */ }

  if (typeof window !== 'undefined') {
    // 1. Synchronous getter for evaluateJavascript / evaluateJavaScript.
    window.SferaNative = { getAllowScale: () => allowScale };

    // 3a. Android @JavascriptInterface push callback.
    try { window.SferaScaleBridge?.onAllowScaleChanged?.(allowScale); } catch { /* ignore */ }

    // 3b. iOS WKScriptMessageHandler push callback.
    try { window.webkit?.messageHandlers?.sferaAllowScale?.postMessage(allowScale); } catch { /* ignore */ }

    // Also a DOM event, in case anything else wants to listen.
    try { window.dispatchEvent(new CustomEvent('sfera:allowScaleChanged', { detail: allowScale })); } catch { /* ignore */ }
  }
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
  };

  send();
  requestAnimationFrame(send);
  window.setTimeout(send, 80);
}

/** Initialise from localStorage and install the global getter (call at startup). */
export function initNativeBridge(): void {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw !== null) allowScale = raw === 'true';
  } catch { /* ignore */ }
  if (typeof window !== 'undefined') {
    window.SferaNative = { getAllowScale: () => allowScale };
  }
}
