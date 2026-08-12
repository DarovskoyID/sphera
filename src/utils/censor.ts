// Content censorship ("blur") helpers.
//
// Message text everywhere in the app runs through here so that offending words
// are replaced with asterisks, and whole messages that try to talk the reader
// into disabling this filter get fully masked. Which categories are active is
// mirrored from the user's privacy settings into localStorage (same pattern as
// notification prefs) so the render path can read it without the SettingsCtx.
//
// ── Evasion resistance ──────────────────────────────────────────────────────
// Naive substring matching is trivially defeated, so matching never runs on the
// raw text. Every candidate is first folded through `variants()` (case,
// diacritics, zero-width chars, homoglyphs, leetspeak, stretched letters) and is
// additionally tested:
//   • joined across separators  — "о т к л ю ч и", "с*у*ка", "х.у.й"
//   • fuzzily (bounded edit distance) — "конеденциальности", "atkluchi"
// Masking always writes back over ranges of the ORIGINAL string, so offsets and
// whitespace shape are preserved regardless of how the text was normalized.

import { useSyncExternalStore } from 'react';
import {
  PROFANITY_ROOTS, PROFANITY_WORDS, EXPLICIT_ROOTS, EXPLICIT_WORDS,
  CTA_KEYWORDS, CALL_TO_ACTION_RE, CODE_KEYWORDS, CODE_REQUEST_RE,
  DISABLE_VERBS, DISABLE_NOUNS, EXCEPTIONS,
  CJK_PROFANITY, CJK_EXPLICIT, CJK_CTA, CJK_CODE,
} from '../data/censorWords';

/** Who the explicit-content filter applies to. */
export type ExplicitScope = 'everyone' | 'non_friends' | 'off';

export interface CensorConfig {
  // Master switch. When off, nothing is masked.
  blur_enabled: boolean;
  // Individual categories (word-level masking → asterisks).
  blur_profanity: boolean;        // маты / swearing
  blur_calls_to_action: boolean;  // призывы к действию (subscribe, buy now…)
  blur_code_requests: boolean;    // просьбы скинуть код (phishing for OTPs)
  // Explicit content is scoped rather than a plain on/off: it can apply to
  // everyone, only to people who are not friends, or to nobody.
  explicit_scope: ExplicitScope;
  // Whole-message masking: messages telling the reader to turn this filter off.
  blur_disable_requests: boolean;
}

const KEY = 'censorPrefs';

export const defaultCensorConfig: CensorConfig = {
  blur_enabled: true,
  blur_profanity: true,
  blur_calls_to_action: true,
  blur_code_requests: true,
  explicit_scope: 'everyone',
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

/**
 * Map the three "scan messages" checkboxes from the settings API onto a scope.
 * They predate this filter and are stored as separate booleans; "everyone"
 * wins if more than one is somehow set, and nothing set means off.
 */
export function scopeFromScanFlags(f: {
  scan_messages_everyone?: boolean;
  scan_messages_non_friends?: boolean;
  scan_messages_off?: boolean;
}): ExplicitScope {
  if (f.scan_messages_off) return 'off';
  if (f.scan_messages_everyone) return 'everyone';
  if (f.scan_messages_non_friends) return 'non_friends';
  return 'off';
}

// ── audience ─────────────────────────────────────────────────────────────────
// The "only from non-friends" scope needs to know who the reader's friends are.
// AppContext pushes that here whenever the friend list changes, so the render
// path can resolve the scope synchronously without subscribing to app state
// (which would re-render every message on every incoming event).

let friendIds = new Set<string>();
let selfId = '';

export function setCensorAudience(currentUserId: string, friends: string[]) {
  const next = new Set(friends.map(String));
  const same = next.size === friendIds.size && [...next].every(id => friendIds.has(id));
  if (same && String(currentUserId) === selfId) return;
  friendIds = next;
  selfId = String(currentUserId);
  listeners.forEach(fn => fn());
}

/**
 * Does the explicit filter apply to this author? Unknown authors count as
 * non-friends (fail closed), but the reader's own text is never masked.
 */
export function explicitApplies(cfg: CensorConfig, authorId?: string): boolean {
  if (cfg.explicit_scope === 'off') return false;
  if (cfg.explicit_scope === 'everyone') return true;
  if (authorId === undefined) return true;
  const id = String(authorId);
  return id !== selfId && !friendIds.has(id);
}

// ── mask sentinel ────────────────────────────────────────────────────────────
// Masking writes this control char instead of '*' so that the markdown renderer
// downstream cannot re-interpret the mask as syntax (`**` → bold). The leaf
// renderer swaps sentinel runs for real asterisks at the very end.

export const MASK_SENTINEL = '\u0001';
const SENTINEL_RUN_RE = /\u0001+/g;

/** Strip sentinels a user may have typed, so nobody can fake a mask. */
export function stripSentinels(text: string): string {
  return text.includes(MASK_SENTINEL) ? text.split(MASK_SENTINEL).join('') : text;
}

/** Swap sentinel runs for visible asterisks. */
export function sentinelToStars(text: string): string {
  return text.replace(SENTINEL_RUN_RE, (m) => '*'.repeat(m.length));
}

// ── normalization ────────────────────────────────────────────────────────────

// Zero-width / invisible characters used to break words apart.
const INVISIBLE_RE = /[­​-‏‪-‮⁠-⁤﻿]/g;

// Latin ⇄ Cyrillic lookalikes. Folding runs in both directions (two variants)
// so a mixed-script word matches whichever script its root is written in.
const LAT_TO_CYR: Record<string, string> = {
  a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о',
  p: 'р', t: 'т', u: 'и', x: 'х', y: 'у', 3: 'з', 4: 'ч', 6: 'б',
};
const CYR_TO_LAT: Record<string, string> = {
  а: 'a', в: 'b', с: 'c', е: 'e', н: 'h', к: 'k', м: 'm', о: 'o',
  р: 'p', т: 't', и: 'u', х: 'x', у: 'y', ё: 'e', й: 'u',
};
// Digits/symbols standing in for letters.
const LEET: Record<string, string> = {
  0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g',
  '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't',
};

/** Base fold: lowercase, drop diacritics + invisibles, collapse stretched runs. */
function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(INVISIBLE_RE, '')
    .toLowerCase()
    // "аааааааад" → "ад"; runs of 3+ collapse to one, doubles are kept
    // (they are legitimate in "класс", "сообщение", "аллах").
    .replace(/(.)\1{2,}/gu, '$1');
}

/**
 * Two script-folded views of a string. A root matches if it appears in either,
 * so "xyй" (Latin x/y), "с0сать" (zero for о) and "fuсk" (Cyrillic с) all land
 * on their canonical form.
 */
function variants(s: string): [string, string] {
  const base = fold(s);
  let cyr = '';
  let lat = '';
  for (const ch of base) {
    const leet = LEET[ch];
    cyr += LAT_TO_CYR[ch] ?? (leet ? LAT_TO_CYR[leet] ?? leet : ch);
    lat += CYR_TO_LAT[ch] ?? leet ?? ch;
  }
  // Collapse doubles too — evasion by letter doubling ("сууука" survives the
  // 3+ collapse above as "суука") should still land on the root.
  return [cyr.replace(/(.)\1+/gu, '$1'), lat.replace(/(.)\1+/gu, '$1')];
}

// ── fuzzy matching ───────────────────────────────────────────────────────────

/** Levenshtein distance, bailing out as soon as it exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Typo tolerance scales with keyword length; short roots stay exact. */
function tolerance(kw: string): number {
  if (kw.length >= 12) return 2;
  if (kw.length >= 7) return 1;
  return 0;
}

/**
 * True when `hay` contains `kw` exactly, or a window within `tolerance(kw)`
 * edits of it — this is what catches "конеденциальности" / "конфедециальности".
 */
function fuzzyContains(hay: string, kw: string): boolean {
  if (hay.includes(kw)) return true;
  const t = tolerance(kw);
  if (!t || hay.length < kw.length - t) return false;
  for (let len = kw.length - t; len <= kw.length + t; len++) {
    for (let i = 0; i + len <= hay.length; i++) {
      if (editDistance(hay.slice(i, i + len), kw, t) <= t) return true;
    }
  }
  return false;
}

// Keywords must be folded through the exact same pipeline as the input,
// otherwise they can never match it: NFKD turns "й" into "и"+breve, so the
// literal "обойд" would be compared against a folded "обоиди". Cached, since
// the lists are constant.
const kwCache = new Map<string, [string, string]>();
function kwVariants(kw: string): [string, string] {
  let v = kwCache.get(kw);
  if (!v) { v = variants(kw); kwCache.set(kw, v); }
  return v;
}

/**
 * Does either script-variant of `s` carry one of `roots` as a SUBSTRING?
 * Used for word stems that must match inside inflected forms ("хуй" in
 * "нахуйчик"). Only ever fed curated stems — a short generic word here would
 * false-positive on innocent text.
 */
function hits(s: string, roots: string[]): boolean {
  if (!s) return false;
  const [cyr, lat] = variants(s);
  return roots.some(r => {
    const [rc, rl] = kwVariants(r);
    return fuzzyContains(cyr, rc) || fuzzyContains(lat, rl);
  });
}

/**
 * Does either script-variant of `s` equal one of `kws` as a WHOLE word
 * (within typo tolerance)? Used for short/generic keywords like "код" or
 * "otp", where substring matching would hit "кодовую" and "посмотри"
 * (whose Latin fold "пocmotpu" contains "otp").
 */
function hitsWhole(s: string, kws: string[]): boolean {
  if (!s) return false;
  const [cyr, lat] = variants(s);
  return kws.some(kw => {
    const [kc, kl] = kwVariants(kw);
    const t = tolerance(kc);
    return cyr === kc || lat === kl
      || (t > 0 && (editDistance(cyr, kc, t) <= t || editDistance(lat, kl, t) <= t));
  });
}

// ── word lists ───────────────────────────────────────────────────────────────
// The lists themselves live in ../data/censorWords.ts — edit them there.
// Exceptions are folded once at load so lookups can compare folded forms.

const EXCEPTION_SET = new Set(EXCEPTIONS.map(w => variants(w)[0]));

/** The stem list (substring match) and keyword list (whole-word match) in force. */
interface Lists { subs: string[]; words: string[] }

function activeLists(cfg: CensorConfig, authorId?: string): Lists {
  const subs: string[] = [];
  const words: string[] = [];
  if (cfg.blur_profanity) { subs.push(...PROFANITY_ROOTS); words.push(...PROFANITY_WORDS); }
  if (explicitApplies(cfg, authorId)) { subs.push(...EXPLICIT_ROOTS); words.push(...EXPLICIT_WORDS); }
  if (cfg.blur_calls_to_action) words.push(...CTA_KEYWORDS);
  if (cfg.blur_code_requests) words.push(...CODE_KEYWORDS);
  return { subs, words };
}

/** Should this word (or joined run) be masked? Exceptions always win. */
function isBad(s: string, lists: Lists): boolean {
  if (!s) return false;
  const [cyr] = variants(s);
  if (EXCEPTION_SET.has(cyr)) return false;
  return hits(s, lists.subs) || hitsWhole(s, lists.words);
}

/**
 * Chinese terms in force, longest first.
 *
 * Longest-first matters: "妈的" sits inside "他妈的", and masking the longer
 * span first means the shorter one finds nothing left to re-mask, so the
 * asterisk run comes out the length of the phrase people actually wrote.
 */
function activeCjkTerms(cfg: CensorConfig, authorId?: string): string[] {
  const terms: string[] = [];
  if (cfg.blur_profanity) terms.push(...CJK_PROFANITY);
  if (explicitApplies(cfg, authorId)) terms.push(...CJK_EXPLICIT);
  if (cfg.blur_calls_to_action) terms.push(...CJK_CTA);
  if (cfg.blur_code_requests) terms.push(...CJK_CODE);
  return terms.sort((a, b) => b.length - a.length);
}

/** Cheap pre-check: no Han characters means the whole pass can be skipped. */
const CJK_RE = /\p{Script=Han}/u;

function activePhraseRes(cfg: CensorConfig): RegExp[] {
  const res: RegExp[] = [];
  if (cfg.blur_calls_to_action) res.push(...CALL_TO_ACTION_RE);
  if (cfg.blur_code_requests) res.push(...CODE_REQUEST_RE);
  return res;
}

// ── full-message blur ────────────────────────────────────────────────────────

const MAX_SCAN = 4000; // guard against pathological input

/** True when the whole message should be masked (disable-the-filter appeals). */
export function isFullBlur(text: string, cfg: CensorConfig = getCensorConfig()): boolean {
  if (!cfg.blur_enabled || !cfg.blur_disable_requests || !text) return false;
  // Strip every separator: defeats "о т к л ю ч и", "от-клю-чи", "от_клю_чи".
  const flat = text.slice(0, MAX_SCAN).replace(/[^\p{L}\p{N}]+/gu, '');
  return hits(flat, DISABLE_VERBS) && hits(flat, DISABLE_NOUNS);
}

/** Replace the whole message with asterisks, keeping its whitespace shape. */
export function fullMask(text: string): string {
  return text.replace(/\S/g, '*');
}

// ── word-level masking ───────────────────────────────────────────────────────

interface Token { start: number; end: number; raw: string }

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ start: m.index, end: m.index + m[0].length, raw: m[0] });
  return out;
}

/**
 * May two adjacent tokens be treated as one word?
 *   • "thin" gap — punctuation/markdown only, no spaces: "с*у*ка", "х.у.й"
 *   • spaced gap — only when both sides are 1–2 chars: "о т к л ю ч и"
 * Anything else (normal words separated by spaces) is never joined, so ordinary
 * sentences cannot accidentally spell a root across a word boundary.
 */
function linkable(gap: string, a: Token, b: Token): boolean {
  if (/[\p{L}\p{N}]/u.test(gap)) return false;
  if (!/\s/.test(gap)) return gap.length <= 4;
  return a.raw.length <= 2 && b.raw.length <= 2;
}

// Stands in for a character whose fold is not exactly one UTF-16 unit (ﬁ → fi).
// It appears in no keyword and is not `\s`, so it can neither be matched nor
// bridge a phrase regex's `\s+`; its only job is to hold the position.
const FOLD_PLACEHOLDER = '\u0000';

/**
 * Lowercase and strip diacritics, one UTF-16 unit in, one out.
 *
 * That 1:1 guarantee is what makes a match index in the result usable as an
 * index into `chars` — which is why that array is split per UTF-16 unit rather
 * than per code point. `tokenize` reports regex offsets, and those are UTF-16
 * too; mixing the two units put every offset after an emoji one place out.
 */
function flatFold(chars: string[]): string {
  return chars
    .map(ch => {
      const f = ch.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
      return f.length === 1 ? f : FOLD_PLACEHOLDER;
    })
    .join('');
}

function maskRange(chars: string[], start: number, end: number) {
  for (let i = start; i < end; i++) if (!/\s/.test(chars[i])) chars[i] = MASK_SENTINEL;
}

/**
 * Word-level masking. Returns the text with offending ranges replaced by
 * MASK_SENTINEL (call `sentinelToStars` for a display-ready string).
 *
 * `authorId` decides whether the explicit-content list applies, per the scope
 * chosen in settings. Omit it only where the author is genuinely unknown.
 */
export function censorToSentinel(text: string, cfg: CensorConfig = getCensorConfig(), authorId?: string): string {
  if (!cfg.blur_enabled || !text) return text;
  const lists = activeLists(cfg, authorId);
  // Split per UTF-16 unit, not per code point: `tokenize` and the phrase
  // regexes both report UTF-16 offsets, and indexing a code-point array with
  // them shifts every position after an emoji.
  const chars = text.split('');
  const tokens = tokenize(text);

  // Pass 1 — each word on its own.
  for (const t of tokens) {
    if (isBad(t.raw, lists)) maskRange(chars, t.start, t.end);
  }

  // Pass 2 — words re-joined across separators (spacing / markdown splitting).
  for (let i = 0; i < tokens.length; i++) {
    let joined = tokens[i].raw;
    for (let j = i + 1; j < tokens.length; j++) {
      const gap = text.slice(tokens[j - 1].end, tokens[j].start);
      if (!linkable(gap, tokens[j - 1], tokens[j])) break;
      joined += tokens[j].raw;
      if (joined.length >= 3 && isBad(joined, lists)) {
        maskRange(chars, tokens[i].start, tokens[j].end);
      }
    }
  }

  // Passes 3 and 4 both work on a 1:1 folded view of the text — strictly one
  // character in, one out (lowercase + drop diacritics) — so a match index in
  // `folded` is also a valid index into the original string.
  const phraseRes = activePhraseRes(cfg);
  const cjkTerms = CJK_RE.test(text) ? activeCjkTerms(cfg, authorId) : [];
  if (phraseRes.length || cjkTerms.length) {
    const folded = flatFold(chars);

    // Pass 3 — multi-word phrases.
    for (const re of phraseRes) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(folded)) !== null) {
        maskRange(chars, m.index, m.index + m[0].length);
        if (m[0].length === 0) re.lastIndex++;
      }
    }

    // Pass 4 — Chinese. There is no whitespace to tokenize on, so terms are
    // located directly and only their own characters are masked; the sentence
    // around them stays readable.
    for (const term of cjkTerms) {
      let from = 0;
      for (;;) {
        const at = folded.indexOf(term, from);
        if (at === -1) break;
        maskRange(chars, at, at + term.length);
        from = at + term.length;
      }
    }
  }

  return chars.join('');
}

/**
 * Should this photo/video be hidden behind a reveal overlay?
 *
 * There is no nudity classifier on the client, so "18+" is inferred from the
 * signals we actually have: explicit wording in the caption the media was sent
 * with, or in the file name. Media that carries no such signal is shown — real
 * content-based detection would have to happen server-side.
 */
export function isExplicitMedia(
  opts: { filename?: string; text?: string; authorId?: string },
  cfg: CensorConfig = getCensorConfig(),
): boolean {
  if (!cfg.blur_enabled || !explicitApplies(cfg, opts.authorId)) return false;
  const lists: Lists = { subs: EXPLICIT_ROOTS, words: EXPLICIT_WORDS };
  const scan = (s?: string) => {
    if (!s) return false;
    // File names arrive as "my.hot_pic-2.jpg", so split on separators too.
    const stem = s.replace(/\.[a-z0-9]{2,4}$/i, '');
    if (tokenize(stem).some(t => isBad(t.raw, lists))) return true;
    // Chinese has nothing for the tokenizer to split on, so it is matched
    // whole — otherwise a caption like "色情照片" reads as one harmless word.
    if (!CJK_RE.test(stem)) return false;
    const folded = flatFold(stem.split(''));
    return CJK_EXPLICIT.some(term => folded.includes(term));
  };
  return scan(opts.text) || scan(opts.filename);
}

/** Word-level masking with visible asterisks. */
export function censorWords(text: string, cfg: CensorConfig = getCensorConfig(), authorId?: string): string {
  return sentinelToStars(censorToSentinel(text, cfg, authorId));
}

/**
 * Plain-string censorship for non-markdown render spots (comments, search
 * highlights, previews). Returns whether the message was fully masked plus the
 * text to display.
 */
export function censorPlain(text: string, cfg: CensorConfig = getCensorConfig(), authorId?: string): { blurred: boolean; text: string } {
  if (!cfg.blur_enabled || !text) return { blurred: false, text };
  const clean = stripSentinels(text);
  if (isFullBlur(clean, cfg)) return { blurred: true, text: fullMask(clean) };
  return { blurred: false, text: censorWords(clean, cfg, authorId) };
}
