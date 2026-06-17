// Chat display + streamer-mode preferences applied globally via classes on
// <html>, consumed by src/styles/chat-prefs.css. Mirrored to localStorage so
// they survive reloads and apply before the backend settings round-trips.

export interface DisplayPrefs {
  chat_show_timestamps: boolean;
  chat_emoji_reactions: boolean;
  chat_compact_mode: boolean;
  streamer_mode: boolean;
  streamer_hide_info: boolean;
}

const KEY = 'displayPrefs';

export const defaultDisplayPrefs: DisplayPrefs = {
  chat_show_timestamps: true,
  chat_emoji_reactions: true,
  chat_compact_mode: false,
  streamer_mode: false,
  streamer_hide_info: false,
};

export function getDisplayPrefs(): DisplayPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultDisplayPrefs;
    return { ...defaultDisplayPrefs, ...JSON.parse(raw) };
  } catch {
    return defaultDisplayPrefs;
  }
}

export function saveDisplayPrefs(partial: Partial<DisplayPrefs>): DisplayPrefs {
  const next = { ...getDisplayPrefs(), ...partial };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  applyDisplayPrefs(next);
  return next;
}

export function applyDisplayPrefs(prefs: DisplayPrefs = getDisplayPrefs()): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('chat-hide-timestamps', !prefs.chat_show_timestamps);
  root.classList.toggle('chat-hide-reactions', !prefs.chat_emoji_reactions);
  root.classList.toggle('chat-compact', prefs.chat_compact_mode);
  root.classList.toggle('streamer-mode', prefs.streamer_mode);
  root.classList.toggle('streamer-hide-info', prefs.streamer_mode && prefs.streamer_hide_info);
}
