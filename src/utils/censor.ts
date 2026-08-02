// Content censorship ("blur") helpers.
//
// Message text everywhere in the app runs through here so that offending words
// are replaced with asterisks, and whole messages that try to talk the reader
// into disabling this filter get fully masked. Which categories are active is
// mirrored from the user's privacy settings into localStorage (same pattern as
// notification prefs) so the render path can read it without the SettingsCtx.

import { useSyncExternalStore } from 'react';

export interface CensorConfig {
  // Master switch. When off, nothing is masked.
  blur_enabled: boolean;
  // Individual categories (word-level masking → asterisks).
  blur_profanity: boolean;        // маты / swearing
  blur_explicit: boolean;         // откровенный / sexual content
  blur_calls_to_action: boolean;  // призывы к действию (subscribe, buy now…)
  blur_code_requests: boolean;    // просьбы скинуть код (phishing for OTPs)
  // Whole-message masking: messages telling the reader to turn this filter off.
  blur_disable_requests: boolean;
}

const KEY = 'censorPrefs';

export const defaultCensorConfig: CensorConfig = {
  blur_enabled: true,
  blur_profanity: true,
  blur_explicit: true,
  blur_calls_to_action: true,
  blur_code_requests: true,
  blur_disable_requests: true,
};

// ── config store (localStorage + in-memory cache + subscribers) ──────────────

let cached: CensorConfig | null = null;
const listeners = new Set<() => void>();

function read(): CensorConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultCensorConfig;
    return { ...defaultCensorConfig, ...JSON.parse(raw) };
  } catch {
    return defaultCensorConfig;
  }
}

export function getCensorConfig(): CensorConfig {
  if (!cached) cached = read();
  return cached;
}

export function saveCensorConfig(partial: Partial<CensorConfig>) {
  const next = { ...getCensorConfig(), ...partial };
  // Skip a churn-y re-render/save when nothing actually changed.
  if (cached && (Object.keys(next) as (keyof CensorConfig)[]).every(k => next[k] === cached![k])) return;
  cached = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  listeners.forEach(fn => fn());
}

/** React hook: current config, re-rendering when it changes. */
export function useCensorConfig(): CensorConfig {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    getCensorConfig,
    getCensorConfig,
  );
}

// ── detection ────────────────────────────────────────────────────────────────

// Word roots — a token is masked if (lowercased) it contains one of these.
// Kept deliberately specific to avoid masking innocent words.
const PROFANITY_ROOTS = [
  // Russian mat (roots cover declensions/prefixes)
  'хуй', 'хуё', 'хуе', 'хуя', 'пизд', 'пезд', 'ебл', 'еба', 'ебё', 'ебу', 'ёба', 'ебан', 'выеб', 'наеб', 'уеб', 'заеб', 'въеб', 'долбоеб', 'долбоёб',
  'бляд', 'блят', 'блядь', 'сука', 'суки', 'суке', 'суку', 'мудак', 'мудач', 'мудо', 'пидор', 'пидар', 'пидр', 'гандон', 'гондон',
  'залуп', 'дроч', 'манда', 'елда', 'мраз', 'ссан', 'говн', 'гнид', 'хер', 'херн', 'нахуй', 'похуй', 'охуе', 'охуё',
  // English
  'fuck', 'shit', 'bitch', 'cunt', 'dick', 'asshole', 'bastard', 'motherfuck', 'bullshit', 'douche', 'wanker', 'faggot',
];

const EXPLICIT_ROOTS = [
  'порно', 'порн', 'секс', 'sex', 'porn', 'xxx', 'эрот', 'erotic', 'минет', 'blowjob', 'анал', 'anal',
  'оргазм', 'orgasm', 'вирт', 'интим', 'нюдс', 'nude', 'nudes', 'дилдо', 'dildo', 'вибратор', 'onlyfans',
  'голая', 'голые', 'голый', 'титьк', 'сиськ', 'boobs', 'наготу', 'genital', 'генитал',
];

// Phrase patterns → whole match replaced with asterisks (spaces preserved).
const CALL_TO_ACTION_RE = [
  /подпиш(?:ись|итесь|и)/giu,
  /перех(?:оди|одите)\s+по\s+ссылке/giu,
  /жми(?:те)?\s+(?:сюда|на|здесь|тут)/giu,
  /кликни(?:те)?(?:\s+(?:сюда|здесь|тут))?/giu,
  /(?:купи|купите|закажи|закажите|заказывай)\s+(?:сейчас|прямо\s+сейчас)?/giu,
  /(?:перейди|переходите|заходи|заходите)\s+(?:по\s+ссылке|на\s+сайт|сюда)/giu,
  /(?:за)?регистрируй(?:ся|тесь)/giu,
  /срочно\s+(?:купи|переходи|жми|заходи)/giu,
  /click\s+here/giu,
  /buy\s+now/giu,
  /(?:sign|log)\s*up\s+now/giu,
  /join\s+now/giu,
  /subscribe\s+now/giu,
  /limited\s+(?:time\s+)?offer/giu,
  /act\s+now/giu,
];

// Phrase patterns for "send me the code" phishing.
const CODE_REQUEST_RE = [
  /(?:скинь|пришли|отправь|назови|продиктуй|скажи|напиши|дай|введи|сообщи)(?:\s+(?:мне|нам))?\s+код(?:\s+(?:из\s+)?(?:смс|sms|сообщения|подтвержд\w*))?/giu,
  /код(?:\s+(?:из\s+)?(?:смс|sms|подтвержд\w*|активац\w*|авторизац\w*))/giu,
  /(?:verification|confirmation|one[-\s]?time|security|login|otp)\s+code/giu,
  /send\s+(?:me\s+)?(?:the\s+)?code/giu,
  /\botp\b/giu,
  /код\s+подтвержд\w*/giu,
];

// Whole-message masking: reader is being told to switch this filter off.
const DISABLE_VERB_RE = /(выключ|отключ|отруб|убер[иья]|сним|деактивир|disable|turn\s*off|switch\s*off|remove)/iu;
const DISABLE_NOUN_RE = /(фильтр|блюр|цензур|настройк|звёздочк|звездочк|blur|filter|censor|settings?|asterisk|маскиров)/iu;

function activeProfanityRoots(cfg: CensorConfig): string[] {
  const roots: string[] = [];
  if (cfg.blur_profanity) roots.push(...PROFANITY_ROOTS);
  if (cfg.blur_explicit) roots.push(...EXPLICIT_ROOTS);
  return roots;
}

function activePhraseRes(cfg: CensorConfig): RegExp[] {
  const res: RegExp[] = [];
  if (cfg.blur_calls_to_action) res.push(...CALL_TO_ACTION_RE);
  if (cfg.blur_code_requests) res.push(...CODE_REQUEST_RE);
  return res;
}

const mask = (s: string) => s.replace(/\S/g, '*');

/** True when the whole message should be masked (disable-the-filter appeals). */
export function isFullBlur(text: string, cfg: CensorConfig = getCensorConfig()): boolean {
  if (!cfg.blur_enabled || !cfg.blur_disable_requests || !text) return false;
  return DISABLE_VERB_RE.test(text) && DISABLE_NOUN_RE.test(text);
}

/** Replace the whole message with asterisks, keeping its whitespace shape. */
export function fullMask(text: string): string {
  return text.replace(/[^\s]/g, '*');
}

/** Word-level masking: swap offending tokens/phrases for asterisks. */
export function censorWords(text: string, cfg: CensorConfig = getCensorConfig()): string {
  if (!cfg.blur_enabled || !text) return text;

  let out = text;

  // Phrase patterns first (may span several words).
  for (const re of activePhraseRes(cfg)) {
    re.lastIndex = 0;
    out = out.replace(re, (m) => mask(m));
  }

  // Token patterns (profanity / explicit): mask any word containing a root.
  const roots = activeProfanityRoots(cfg);
  if (roots.length) {
    out = out.replace(/[\p{L}\p{N}]+/gu, (tok) => {
      const low = tok.toLowerCase();
      return roots.some(r => low.includes(r)) ? '*'.repeat(tok.length) : tok;
    });
  }

  return out;
}

/**
 * Plain-string censorship for non-markdown render spots (comments, search
 * highlights, previews). Returns whether the message was fully masked plus the
 * text to display.
 */
export function censorPlain(text: string, cfg: CensorConfig = getCensorConfig()): { blurred: boolean; text: string } {
  if (!cfg.blur_enabled || !text) return { blurred: false, text };
  if (isFullBlur(text, cfg)) return { blurred: true, text: fullMask(text) };
  return { blurred: false, text: censorWords(text, cfg) };
}
