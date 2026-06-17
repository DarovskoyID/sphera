// Global keyboard shortcuts. Bindings are stored in localStorage and edited in
// Settings → Hotkeys. A runner hook (useKeybindings) attaches the global
// listeners and dispatches the matching action.

export type ActionId =
  | 'toggle_mic'
  | 'toggle_deafen'
  | 'push_to_talk'
  | 'toggle_theme'
  | 'open_settings'
  | 'focus_search';

export interface KeyBinding {
  id: string;
  action: ActionId;
  keys: string; // normalized combo, e.g. "Ctrl+Shift+M"
}

const KEY = 'keybindings';
const UPDATE_EVENT = 'keybindings:update';

export const defaultKeybindings: KeyBinding[] = [
  { id: 'mic', action: 'toggle_mic', keys: 'Ctrl+Shift+M' },
  { id: 'deafen', action: 'toggle_deafen', keys: 'Ctrl+Shift+D' },
  { id: 'ptt', action: 'push_to_talk', keys: 'Ctrl+Space' },
];

/** Actions that can be bound. Labels are bilingual to avoid touching i18n files. */
export const ACTION_CATALOG: { id: ActionId; ru: string; en: string }[] = [
  { id: 'toggle_mic', ru: 'Вкл/Выкл микрофон', en: 'Toggle microphone' },
  { id: 'toggle_deafen', ru: 'Вкл/Выкл звук', en: 'Toggle sound (deafen)' },
  { id: 'push_to_talk', ru: 'Нажми и говори', en: 'Push to talk' },
  { id: 'toggle_theme', ru: 'Сменить тему', en: 'Toggle theme' },
  { id: 'open_settings', ru: 'Открыть настройки', en: 'Open settings' },
  { id: 'focus_search', ru: 'Перейти к поиску', en: 'Focus search' },
];

export function actionLabel(action: ActionId, isRu: boolean): string {
  const a = ACTION_CATALOG.find(x => x.id === action);
  return a ? (isRu ? a.ru : a.en) : action;
}

export function getKeybindings(): KeyBinding[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return defaultKeybindings;
}

export function saveKeybindings(list: KeyBinding[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(UPDATE_EVENT));
}

export function resetKeybindings(): KeyBinding[] {
  saveKeybindings(defaultKeybindings);
  return defaultKeybindings;
}

export function onKeybindingsUpdate(cb: () => void): () => void {
  window.addEventListener(UPDATE_EVENT, cb);
  return () => window.removeEventListener(UPDATE_EVENT, cb);
}

/** Convert a keyboard event into a normalized combo string. Returns null while
    only modifier keys are held (we wait for the main key). */
export function eventToCombo(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k === 'Control' || k === 'Alt' || k === 'Shift' || k === 'Meta') return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  let main: string;
  if (k === ' ') main = 'Space';
  else if (k.length === 1) main = k.toUpperCase();
  else main = k; // ArrowUp, F5, Enter, Escape, ...
  parts.push(main);
  return parts.join('+');
}

/** The non-modifier key of a combo (for push-to-talk keyup matching). */
export function comboMainKey(combo: string): string {
  const parts = combo.split('+');
  return parts[parts.length - 1];
}

export function comboDisplay(combo: string): string {
  return combo.split('+').join(' + ');
}

// --- Deafen (mute all audio/video output) ----------------------------------

let deafened = false;

export function isDeafened(): boolean {
  return deafened;
}

export function toggleDeafen(): boolean {
  deafened = !deafened;
  document.querySelectorAll('audio, video').forEach(el => {
    (el as HTMLMediaElement).muted = deafened;
  });
  return deafened;
}
