// Accessibility preferences. Applied globally by toggling classes / CSS
// variables on <html>, so they affect the whole app — desktop and mobile.

export interface A11yPrefs {
  high_contrast: boolean;
  screen_reader: boolean;
  reduce_motion: boolean;
  /** Kept for backward-compat / server sync: derived from text_scale > 1. */
  large_text: boolean;
  /** UI zoom factor chosen with the "Text size" slider. 1 = default. */
  text_scale: number;
  keyboard_outlines: boolean;
}

const KEY = 'a11yPrefs';
export const TEXT_SCALE_MIN = 1;
export const TEXT_SCALE_MAX = 1.5;

export const defaultA11yPrefs: A11yPrefs = {
  high_contrast: false,
  screen_reader: false,
  reduce_motion: false,
  large_text: false,
  text_scale: 1,
  keyboard_outlines: false,
};

export function getA11yPrefs(): A11yPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultA11yPrefs;
    const parsed = JSON.parse(raw) as Partial<A11yPrefs>;
    const merged = { ...defaultA11yPrefs, ...parsed };
    // Migrate the old on/off "large_text" toggle to the numeric scale.
    if (parsed.text_scale == null && parsed.large_text) merged.text_scale = 1.15;
    merged.text_scale = Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, merged.text_scale || 1));
    merged.large_text = merged.text_scale > 1.001;
    return merged;
  } catch {
    return defaultA11yPrefs;
  }
}

// `zoom` is how the whole UI is scaled (the app uses fixed px sizes). It is not
// universally supported (older iOS/Firefox); applying the counter-sizing there
// would shrink the root and shift the layout. Detect support once and gate the
// scaling CSS on the `ui-zoom-ok` class so unsupported browsers stay unbroken.
let _zoomOk: boolean | null = null;
function zoomSupported(): boolean {
  if (_zoomOk !== null) return _zoomOk;
  if (typeof document === 'undefined' || !document.body) return false;
  try {
    const t = document.createElement('div');
    t.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:10px;height:10px;zoom:2';
    document.body.appendChild(t);
    _zoomOk = Math.round(t.getBoundingClientRect().width) === 20;
    t.remove();
  } catch { _zoomOk = false; }
  return _zoomOk;
}

export function saveA11yPrefs(partial: Partial<A11yPrefs>) {
  const next = { ...getA11yPrefs(), ...partial };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  applyA11y(next);
  return next;
}

/** Toggle the global classes / variables that the CSS hooks into. */
export function applyA11y(prefs: A11yPrefs = getA11yPrefs()): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('a11y-high-contrast', prefs.high_contrast);
  root.classList.toggle('a11y-reduce-motion', prefs.reduce_motion);
  root.classList.toggle('a11y-focus-outlines', prefs.keyboard_outlines);
  root.classList.toggle('a11y-screen-reader', prefs.screen_reader);
  // Text scaling: expose the factor as a CSS var and gate the zoom CSS on
  // browser support + whether the user actually raised the scale above 1.
  const scale = Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, prefs.text_scale || 1));
  root.style.setProperty('--text-scale', String(scale));
  root.classList.toggle('ui-zoom-ok', zoomSupported());
  root.classList.toggle('ui-textscale', scale > 1.001);
  ensureLiveRegion(prefs.screen_reader);
}

// Re-apply once the DOM is ready so zoom-support detection (which needs
// document.body) and the mobile base scale land even if the first call ran early.
if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => applyA11y(), { once: true });
  }
}

// ---- Screen-reader live region --------------------------------------------

let liveRegion: HTMLElement | null = null;

function ensureLiveRegion(enabled: boolean): void {
  if (typeof document === 'undefined') return;
  if (!enabled) {
    if (liveRegion) { liveRegion.remove(); liveRegion = null; }
    return;
  }
  if (liveRegion) return;
  const el = document.createElement('div');
  el.id = 'a11y-live-region';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  // Visually hidden but available to assistive tech.
  el.style.cssText =
    'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;';
  document.body.appendChild(el);
  liveRegion = el;
}

/** Announce a message to screen readers (only when the feature is enabled). */
export function announce(message: string): void {
  if (!getA11yPrefs().screen_reader || !liveRegion || !message) return;
  // Clearing first makes repeated/identical messages re-announce.
  liveRegion.textContent = '';
  window.setTimeout(() => { if (liveRegion) liveRegion.textContent = message; }, 50);
}
