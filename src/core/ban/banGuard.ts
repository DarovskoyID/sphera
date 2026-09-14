// System-wide ban: a screen that replaces the whole interface.
//
// The server is the real enforcement — every request of a banned account is
// refused (BanGuardMiddleware, WebSocket guards, gateway). This screen only has
// to be honest and hard to get out of by accident or through devtools:
//   * App renders nothing else while a ban is known, so removing the screen
//     leaves an empty page, not a working app;
//   * the screen lives in a closed shadow root and is put back (with the rule
//     that hides the rest of the page) if an element or style is removed;
//   * the ban arrives in real time (signaling / gateway frames) and from any
//     API response, so it cannot be stale.

import { useSyncExternalStore } from 'react';
import { API_BASE_URL } from '../../config/network';

export interface BanInfo {
  reason: string;
  banned_at?: string | null;
}

const LS_KEY = 'sfera.ban';
const TAG = 'sfera-ban-screen';
const listeners = new Set<() => void>();

function load(): BanInfo | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as BanInfo) : null;
  } catch {
    return null;
  }
}

let ban: BanInfo | null = load();

function emit() {
  listeners.forEach(l => l());
}

export function useBan(): BanInfo | null {
  return useSyncExternalStore(
    l => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => ban,
  );
}

export function setBanned(info: Partial<BanInfo> | null | undefined) {
  const next: BanInfo = { reason: String(info?.reason ?? ''), banned_at: info?.banned_at ?? null };
  if (ban && ban.reason === next.reason && ban.banned_at === next.banned_at) {
    mount();
    return;
  }
  ban = next;
  try { localStorage.setItem(LS_KEY, JSON.stringify(ban)); } catch { /* storage blocked */ }
  mount();
  emit();
}

export function clearBan() {
  ban = null;
  try { localStorage.removeItem(LS_KEY); } catch { /* storage blocked */ }
  unmount();
  emit();
}

// ── network hooks ────────────────────────────────────────────────────────────

let fetchPatched = false;

/** Any API answer `403 {error: 'account_banned'}` turns the ban screen on. */
export function installBanGuard() {
  if (fetchPatched || typeof window === 'undefined') return;
  fetchPatched = true;
  const original = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await original(...args);
    if (res.status === 403) {
      res.clone().json().then(body => {
        if (body && body.error === 'account_banned') setBanned(body);
      }).catch(() => { /* not JSON */ });
    }
    return res;
  };
  if (ban) mount();
  // Realtime frames are the fast path; this covers a socket that is down.
  window.setInterval(() => { if (!ban) void fetchBanStatus(); }, 30000);
}

function session(): { token: string; server: string } {
  try {
    return {
      token: localStorage.getItem('authToken') || '',
      server: localStorage.getItem('sfera_selected_server') || API_BASE_URL,
    };
  } catch {
    return { token: '', server: API_BASE_URL };
  }
}

async function fetchBanStatus(): Promise<{ banned: boolean } | null> {
  const { token, server } = session();
  if (!token) return null;
  try {
    const res = await fetch(`${server}/api/auth/ban-status/`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Ionik-Client': '1' },
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (body?.banned === true) setBanned(body);
    return body;
  } catch {
    return null;
  }
}

/** Realtime frames from signaling, chat and module sockets. */
export function handleBanFrame(frame: { type?: unknown; [k: string]: unknown }): boolean {
  if (frame?.type === 'account_banned') {
    setBanned(frame as Partial<BanInfo>);
    return true;
  }
  return false;
}

// ── the screen ───────────────────────────────────────────────────────────────

let host: HTMLElement | null = null;
let hideStyle: HTMLStyleElement | null = null;
let observer: MutationObserver | null = null;
let watchdog: number | null = null;
let poll: number | null = null;

const HOST_STYLE = [
  'position:fixed', 'inset:0', 'z-index:2147483647', 'display:block', 'visibility:visible',
  'opacity:1', 'pointer-events:auto', 'transform:none', 'filter:none', 'clip-path:none',
].join('!important;') + '!important';

function lang(): 'ru' | 'en' {
  try {
    const l = localStorage.getItem('messengerLanguage') || navigator.language || '';
    return l.startsWith('ru') ? 'ru' : 'en';
  } catch {
    return 'en';
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function render(root: ShadowRoot) {
  const ru = lang() === 'ru';
  const info = ban ?? { reason: '' };
  const when = info.banned_at ? new Date(info.banned_at).toLocaleString(ru ? 'ru-RU' : undefined) : '';
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px;
        background: #0e0e10; color: #e4e4e7; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .card { max-width: 420px; width: 100%; text-align: center; }
      .icon { width: 56px; height: 56px; margin: 0 auto 20px; border-radius: 50%; display: flex; align-items: center;
        justify-content: center; background: #27272a; color: #ef4444; }
      h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; color: #fafafa; }
      p { margin: 0 0 16px; color: #a1a1aa; }
      .reason { margin: 0 0 16px; padding: 12px 14px; border-radius: 8px; background: #18181b; border: 1px solid #27272a;
        text-align: left; white-space: pre-wrap; word-break: break-word; color: #e4e4e7; }
      .label { display: block; margin-bottom: 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: #71717a; }
      .when { font-size: 12px; color: #71717a; margin-bottom: 20px; }
      button { padding: 8px 18px; border-radius: 6px; border: 1px solid #3f3f46; background: transparent; color: #e4e4e7;
        font: inherit; cursor: pointer; }
      button:hover { background: #18181b; }
    </style>
    <div class="wrap" role="alertdialog" aria-modal="true" aria-labelledby="t">
      <div class="card">
        <div class="icon" aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>
          </svg>
        </div>
        <h1 id="t">${ru ? 'Аккаунт заблокирован' : 'Account banned'}</h1>
        <p>${ru
          ? 'Администратор Сферы заблокировал ваш аккаунт. Пока блокировка действует, пользоваться Сферой нельзя.'
          : 'The Sfera administrator has banned your account. You cannot use Sfera while the ban is in place.'}</p>
        <div class="reason"><span class="label">${ru ? 'Причина' : 'Reason'}</span>${
          escapeHtml(info.reason) || (ru ? 'Не указана' : 'Not specified')}</div>
        ${when ? `<div class="when">${ru ? 'Дата блокировки' : 'Banned on'}: ${escapeHtml(when)}</div>` : ''}
        <button type="button" id="out">${ru ? 'Выйти из аккаунта' : 'Sign out'}</button>
      </div>
    </div>`;
  root.getElementById('out')?.addEventListener('click', signOut);
}

function signOut() {
  // Leaves the ban behind on this device only; signing in again brings it back.
  try {
    localStorage.removeItem('authToken');
    localStorage.removeItem(LS_KEY);
  } catch { /* storage blocked */ }
  window.location.reload();
}

function ensureInDom() {
  if (!ban) return;
  if (!host || !host.isConnected) {
    host = document.createElement(TAG);
    const root = host.attachShadow({ mode: 'closed' });
    render(root);
    document.documentElement.appendChild(host);
  }
  if (host.getAttribute('style') !== HOST_STYLE) host.setAttribute('style', HOST_STYLE);
  if (host.hidden) host.hidden = false;
  if (!hideStyle || !hideStyle.isConnected) {
    hideStyle = document.createElement('style');
    document.documentElement.appendChild(hideStyle);
  }
  const css = `body{visibility:hidden!important;overflow:hidden!important}${TAG}{${HOST_STYLE}}`;
  if (hideStyle.textContent !== css) hideStyle.textContent = css;
}

function mount() {
  if (typeof document === 'undefined') return;
  if (host) {
    // Re-render with the latest reason.
    host.remove();
    host = null;
  }
  ensureInDom();
  if (!observer) {
    observer = new MutationObserver(() => ensureInDom());
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden', 'class'] });
  }
  if (watchdog === null) watchdog = window.setInterval(ensureInDom, 1000);
  if (poll === null) poll = window.setInterval(checkStillBanned, 30000);
}

function unmount() {
  observer?.disconnect();
  observer = null;
  if (watchdog !== null) window.clearInterval(watchdog);
  if (poll !== null) window.clearInterval(poll);
  watchdog = poll = null;
  host?.remove();
  hideStyle?.remove();
  host = hideStyle = null;
}

/** Lifted bans end the screen on their own: the server says so. */
async function checkStillBanned() {
  const body = await fetchBanStatus();
  if (body && body.banned === false) {
    clearBan();
    window.location.reload();
  }
}
