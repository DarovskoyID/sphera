// Centralised error manager.
//
// Converts raw errors — JS exceptions, failed fetch()/Response objects, DRF
// validation payloads — into a single, localised, user-safe message. Two rules
// drive it:
//
//   1. Never surface raw technical noise. Strings like
//      `Unexpected token '<', "<!DOCTYPE "... is not valid JSON` (what you get
//      when a gateway returns an HTML error page instead of JSON) are mapped to
//      a friendly, translated message.
//   2. Never reveal the *main* server's address. For any other (custom) server
//      the address is appended so the user can tell which one failed.

import { t, type Translations } from '../i18n';
import { API_BASE_URL, APP_HOST } from '../config/network';

// The manager runs outside React, so it keeps its own copy of the active
// language. Seeded from localStorage so errors thrown before AppContext mounts
// are still localised; AppContext pushes later updates via setErrorLang().
let _lang = 'en';
try {
  const saved = localStorage.getItem('messengerLanguage');
  if (saved) _lang = saved;
} catch { /* localStorage unavailable */ }
export function setErrorLang(lang: string) { _lang = lang; }

// Keys our own code throws as `new Error(key)` — translate them as-is.
const KNOWN_KEYS = new Set<string>([
  'error_network', 'error_unauthorized', 'error_forbidden',
  'error_not_found', 'error_server', 'error_bad_response',
  'error_user_exists', 'error_invalid_credentials', 'error_unknown',
]);

// Raw text → translation key. First match wins.
const RULES: Array<{ test: RegExp; key: keyof Translations }> = [
  // HTML / non-JSON response (gateway error page, 502/504, redirect to login…)
  { test: /unexpected token|<!doctype|<html|not valid json|unexpected end of (json|data)|json\.parse|syntaxerror/i, key: 'error_bad_response' },
  // Connectivity
  { test: /failed to fetch|networkerror|load failed|net::|err_(connection|network|name)|connection (error|refused)|timed? ?out|the operation was aborted|abort/i, key: 'error_network' },
  // Duplicate account (DRF unique-username message + a few localisations)
  { test: /already exists|уже существ|已存在|existe (déjà|ya)|bereits|já existe/i, key: 'error_user_exists' },
  // Bad login (simplejwt + common phrasings)
  { test: /no active account|given credentials|unable to log in|invalid credentials|incorrect password|wrong password|неверн(ый|ое)/i, key: 'error_invalid_credentials' },
];

function rawText(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (input instanceof Error) return input.message;
  if (typeof input === 'object') {
    // DRF-style payload: { field: [msg, …], … } or { detail: msg } / { error: msg }
    try {
      const vals = Object.values(input as Record<string, unknown>)
        .flat()
        .map(v => (v == null ? '' : String(v)))
        .filter(Boolean);
      if (vals.length) return vals.join(', ');
    } catch { /* fall through */ }
    return String(input);
  }
  return String(input);
}

/** Is the URL the main/default server? (which we must never reveal) */
export function isMainServer(serverIP?: string): boolean {
  if (!serverIP) return true; // unknown ⇒ assume main and hide, to be safe
  try {
    return new URL(serverIP).hostname === APP_HOST;
  } catch {
    return serverIP.includes(APP_HOST) || serverIP === API_BASE_URL;
  }
}

/** Remove any mention of the main host/URL from free text. */
function stripMainAddress(text: string): string {
  if (!text) return text;
  let out = text.split(API_BASE_URL).join('').split(APP_HOST).join('');
  // Drop any leftover absolute URL that still points at the main host.
  out = out.replace(/https?:\/\/[^\s]+/gi, m => (m.includes(APP_HOST) ? '' : m));
  return out.replace(/\s{2,}/g, ' ').trim();
}

export interface ErrorContext {
  /** Server the failed request targeted. Decides whether to show the address. */
  serverIP?: string;
  /** Called once when a 401 is seen, so the caller can log the user out. */
  onUnauthorized?: () => void;
}

/** Convert anything into a localised, user-safe message. */
export function toUserMessage(input: unknown, ctx: ErrorContext = {}): string {
  const raw = rawText(input).trim();

  // 1. Already a translation key thrown by our own code.
  if (raw && KNOWN_KEYS.has(raw)) {
    return decorate(t(_lang, raw as keyof Translations), ctx);
  }

  // 2. Pattern-match against known raw errors.
  for (const r of RULES) {
    if (r.test.test(raw)) return decorate(t(_lang, r.key), ctx);
  }

  // 3. Fallback: a sanitised version of the raw message, never empty.
  const safe = stripMainAddress(raw);
  return decorate(safe || t(_lang, 'error_unknown'), ctx);
}

/**
 * Append the server address only when it is NOT the main server. Idempotent:
 * a message that already carries the address (e.g. one re-processed after
 * readResponse threw it) is left untouched.
 */
function decorate(message: string, ctx: ErrorContext): string {
  const { serverIP } = ctx;
  if (serverIP && !isMainServer(serverIP) && !message.includes(serverIP)) {
    return `${message} (${serverIP})`;
  }
  return message;
}

/**
 * Safely read a fetch Response. On a non-OK status it throws an Error whose
 * message is already localised and address-safe. On success it returns the
 * parsed JSON (or null for empty bodies). Use in place of `await res.json()`.
 */
export async function readResponse(res: Response, ctx: ErrorContext = {}): Promise<any> {
  if (res.status === 401) {
    ctx.onUnauthorized?.();
    throw new Error(toUserMessage('error_unauthorized', ctx));
  }

  const text = await res.text();
  let data: any = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = null; } // Body is not JSON (HTML error page, plain text…).
  }

  if (!res.ok) {
    // Prefer a backend-supplied message (mapped + sanitised); fall back to the
    // HTTP status when the body was HTML or empty.
    const fromBody = data != null ? toUserMessage(data, ctx) : '';
    if (fromBody) throw new Error(fromBody);
    if (res.status === 403) throw new Error(toUserMessage('error_forbidden', ctx));
    if (res.status === 404) throw new Error(toUserMessage('error_not_found', ctx));
    if (res.status >= 500) throw new Error(toUserMessage('error_server', ctx));
    throw new Error(toUserMessage('error_bad_response', ctx));
  }

  return data;
}
