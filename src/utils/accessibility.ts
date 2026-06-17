// Accessibility preferences. Applied globally by toggling classes / CSS
// variables on <html>, so they affect the whole app — desktop and mobile.

export interface A11yPrefs {
  high_contrast: boolean;
  screen_reader: boolean;
  reduce_motion: boolean;
  large_text: boolean;
  keyboard_outlines: boolean;
}

const KEY = 'a11yPrefs';

export const defaultA11yPrefs: A11yPrefs = {
  high_contrast: false,
  screen_reader: false,
  reduce_motion: false,
  large_text: false,
  keyboard_outlines: false,
};

export function getA11yPrefs(): A11yPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultA11yPrefs;
    return { ...defaultA11yPrefs, ...JSON.parse(raw) };
  } catch {
    return defaultA11yPrefs;
  }
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
  root.classList.toggle('a11y-large-text', prefs.large_text);
  root.classList.toggle('a11y-focus-outlines', prefs.keyboard_outlines);
  root.classList.toggle('a11y-screen-reader', prefs.screen_reader);
  ensureLiveRegion(prefs.screen_reader);
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
