// Central notification helpers. Settings checkboxes write their state to
// localStorage (mirrored from the backend), and the WebSocket handlers in
// AppContext call into here so the toggles actually take effect.

export interface NotifPrefs {
  enable_all_notifications: boolean;
  notify_direct_messages: boolean;
  notify_mentions: boolean;
  notify_all_server_messages: boolean;
  notify_friend_requests: boolean;
  sound_message: boolean;
  sound_incoming_call: boolean;
  streamer_disable_notifs: boolean;
}

const KEY = 'notifPrefs';

export const defaultNotifPrefs: NotifPrefs = {
  enable_all_notifications: true,
  notify_direct_messages: true,
  notify_mentions: true,
  notify_all_server_messages: false,
  notify_friend_requests: true,
  sound_message: true,
  sound_incoming_call: true,
  streamer_disable_notifs: false,
};

export function getNotifPrefs(): NotifPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultNotifPrefs;
    return { ...defaultNotifPrefs, ...JSON.parse(raw) };
  } catch {
    return defaultNotifPrefs;
  }
}

export function saveNotifPrefs(partial: Partial<NotifPrefs>) {
  const next = { ...getNotifPrefs(), ...partial };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
}

/** Ask for the browser notification permission (no-op if unsupported/decided). */
export function ensureNotificationPermission(): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

type NotifKind = 'dm' | 'mention' | 'server' | 'friend';

const KIND_FIELD: Record<NotifKind, keyof NotifPrefs> = {
  dm: 'notify_direct_messages',
  mention: 'notify_mentions',
  server: 'notify_all_server_messages',
  friend: 'notify_friend_requests',
};

/** Show a desktop notification if the matching toggles are enabled. */
export function showDesktopNotification(kind: NotifKind, title: string, body: string): void {
  const prefs = getNotifPrefs();
  if (prefs.streamer_disable_notifs) return;
  if (!prefs.enable_all_notifications) return;
  if (!prefs[KIND_FIELD[kind]]) return;
  // Don't pop a notification for the tab the user is already looking at.
  if (typeof document !== 'undefined' && document.hasFocus()) return;
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: '/vite.svg', tag: `${kind}-${title}` });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* ignore */ }
}

/** Show a browser notification for an incoming call. */
export function showCallNotification(callerName: string, withVideo: boolean): void {
  const prefs = getNotifPrefs();
  if (prefs.streamer_disable_notifs) return;
  if (!prefs.enable_all_notifications) return;
  // The in-app ringing modal already covers the focused tab.
  if (typeof document !== 'undefined' && document.hasFocus()) return;
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification(callerName || 'Incoming call', {
      body: withVideo ? 'Incoming video call' : 'Incoming call',
      icon: '/vite.svg',
      tag: 'incoming-call',
      requireInteraction: true,
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* ignore */ }
}

let lastSoundAt = 0;

/** Play a short notification sound, respecting the sound_message toggle. */
export function playMessageSound(): void {
  const prefs = getNotifPrefs();
  if (prefs.streamer_disable_notifs) return;
  if (!prefs.sound_message) return;
  const now = Date.now();
  if (now - lastSoundAt < 1500) return; // throttle bursts
  lastSoundAt = now;
  try {
    const audio = new Audio('/rington.mp3');
    audio.volume = 0.25;
    audio.play().catch(() => {});
    // Keep it short — this is a ping, not the full ringtone.
    window.setTimeout(() => { audio.pause(); audio.currentTime = 0; }, 1200);
  } catch { /* ignore */ }
}

/** Whether the incoming-call ringtone should sound. */
export function callSoundEnabled(): boolean {
  return getNotifPrefs().sound_incoming_call;
}
