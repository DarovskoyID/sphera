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
//   • with symbols read as the letters they hide — "с*ка", "б**дь", "f*ck"
//   • fuzzily (bounded edit distance) — "конеденциальности", "atkluchi"
// Masking always writes back over ranges of the ORIGINAL string, so offsets and
// whitespace shape are preserved regardless of how the text was normalized.

import { useSyncExternalStore } from 'react';
import {
  PROFANITY_ROOTS, PROFANITY_WORDS, EXPLICIT_ROOTS, EXPLICIT_WORDS,
  CTA_KEYWORDS, CALL_TO_ACTION_RE, CODE_KEYWORDS, CODE_REQUEST_RE,
  DISABLE_VERBS, DISABLE_NOUNS, EXCEPTIONS,
  CJK_PROFANITY, CJK_EXPLICIT, CJK_CTA, CJK_CODE,
  TRANSLIT_PROFANITY, TRANSLIT_EXPLICIT, TRANSLIT_DISABLE_VERBS, TRANSLIT_DISABLE_NOUNS,
} from '../data/censorWords';
import { modelSaysAppeal } from './censorModel';

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

// Bumped whenever anything that can change a verdict changes: the settings, or
// who counts as a friend. Cached results carry the epoch they were computed
// under, so a stale one is never handed back — no cache needs clearing.
let epoch = 0;

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
  epoch++;
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
  epoch++;
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

/**
 * The same question for a photo or video, where your own counts.
 *
 * Text you wrote needs no cover: you typed it a second ago and you are looking
 * at it either way. A photo is different — it scrolls back past you later, on
 * a screen someone else may be able to see, and the cover costs one tap. What
 * settled it is the asymmetry people actually hit: the picture you sent was
 * covered for the person you sent it to and wide open in your own window.
 *
 * The friends rule is untouched. Under "only from non-friends" a friend's
 * media is still shown; it is only the exemption for *yourself* that goes.
 */
export function explicitMediaApplies(cfg: CensorConfig, authorId?: string): boolean {
  if (cfg.explicit_scope === 'off') return false;
  if (cfg.explicit_scope === 'everyone') return true;
  if (authorId === undefined) return true;
  return !friendIds.has(String(authorId));
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

// Phonetic Latin → Cyrillic. Longest sequences first, so "shch" is consumed
// before "sh" and "ya" before "a".
//
// This is a SEPARATE mechanism from the lookalike tables above, and the
// difference is the whole point. Those map by shape — "и" is folded to "u"
// because it looks like one. Transliteration maps by sound: "u" is "у". Both
// are needed, and neither substitutes for the other. Without this view "suka"
// folded to "сика" and matched nothing at all.
const TRANSLIT: Array<[string, string]> = [
  ['shch', 'щ'], ['sch', 'щ'], ['zh', 'ж'], ['kh', 'х'], ['ch', 'ч'], ['sh', 'ш'],
  ['ts', 'ц'], ['yo', 'ё'], ['yu', 'ю'], ['ya', 'я'], ['ye', 'е'], ['ju', 'ю'],
  ['ja', 'я'], ['jo', 'ё'], ['je', 'е'],
  ['a', 'а'], ['b', 'б'], ['v', 'в'], ['g', 'г'], ['d', 'д'], ['e', 'е'], ['z', 'з'],
  ['i', 'и'], ['j', 'й'], ['k', 'к'], ['l', 'л'], ['m', 'м'], ['n', 'н'], ['o', 'о'],
  ['p', 'п'], ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'], ['f', 'ф'], ['h', 'х'],
  ['c', 'к'], ['w', 'в'], ['x', 'кс'], ['q', 'к'],
];

const TRANSLIT_VOWELS = 'аеёиоуыэюя';
const HAS_LATIN = /[a-z]/;

/** Sound-alike Cyrillic reading of a Latin string. */
function translit(base: string): string {
  let out = '';
  let i = 0;
  while (i < base.length) {
    let hit = false;
    // Multigraphs win, and they have to be tried before the single-letter rule
    // below — otherwise the "y" of "blyat" is eaten on its own and "ya" never
    // gets the chance to become "я".
    for (const [from, to] of TRANSLIT) {
      if (base.startsWith(from, i)) { out += to; i += from.length; hit = true; break; }
    }
    if (hit) continue;
    // A leftover "y" is the one letter whose reading depends on where it sits:
    // a vowel before it makes it the glide "й" ("huy"), otherwise it is "ы".
    if (base[i] === 'y') {
      out += TRANSLIT_VOWELS.includes(out[out.length - 1]) ? 'й' : 'ы';
    } else {
      out += base[i];
    }
    i += 1;
  }
  return out;
}

/**
 * Three folded views of a string. A root matches if it appears in any of them.
 *
 * The first two are the lookalike folds, which catch "xyй" (Latin x/y),
 * "с0сать" (zero for о) and "fuсk" (Cyrillic с). The third reads Latin
 * phonetically, which is what catches plain transliteration — "suka",
 * "pizdec", "poshel na huy".
 */
function variants(s: string): [string, string, string] {
  const hit = variantCache.get(s);
  if (hit) return hit;

  const base = fold(s);
  let cyr = '';
  let lat = '';
  for (const ch of base) {
    const leet = LEET[ch];
    cyr += LAT_TO_CYR[ch] ?? (leet ? LAT_TO_CYR[leet] ?? leet : ch);
    lat += CYR_TO_LAT[ch] ?? leet ?? ch;
  }
  // Transliteration only means anything for a string that has Latin in it.
  // The result goes back through `fold` so it lands in exactly the same
  // canonical space as the keywords: NFKD turns "й" into "и", so a keyword
  // written "хуй" is stored as "хуи" and a translit reading of "huy" has to
  // arrive as "хуи" too, or the two never meet.
  const tr = HAS_LATIN.test(base) ? fold(translit(base)) : cyr;
  // Collapse doubles too — evasion by letter doubling ("сууука" survives the
  // 3+ collapse above as "суука") should still land on the root.
  const squeeze = (v: string) => v.replace(/(.)\1+/gu, '$1');
  const out: [string, string, string] = [squeeze(cyr), squeeze(lat), squeeze(tr)];
  remember(variantCache, s, out, 4000);
  return out;
}

// Folding is pure and the same handful of words come round again and again —
// every token of every visible message, once per active list. It is the single
// hottest thing in the render path, so the result is kept.
const variantCache = new Map<string, [string, string, string]>();

/**
 * Insert into a bounded cache, evicting the oldest entry once it is full.
 * A Map iterates in insertion order, which is enough of an LRU here: these
 * caches exist to survive a burst of re-renders, not to model long-term use.
 */
function remember<K, V>(cache: Map<K, V>, key: K, value: V, limit: number) {
  if (cache.size >= limit) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
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

// ── symbols standing in for letters ──────────────────────────────────────────
// "с*ка", "б**дь", "пи*дец", "f*ck". Pass 2 already rejoins a word split by
// punctuation, but that reads the symbol as a separator and deletes it, which
// turns "с*ка" into "ска" — a word that matches nothing. Here the symbol is
// read the other way, as a letter someone declined to type: it becomes a slot
// that matches any one character.
//
// Both readings are tried, because both are real. Nothing else changes: a
// candidate with no slot in it is left to the passes above.

// Not \u0001 - that is the mask sentinel, and the two must never collide.
const ANY = '\u0002';

/** A run of symbols short enough to be hiding letters rather than punctuating. */
const MASK_RUN_RE = /^[*@#$%&+!?._\-–—•·^~]{1,3}$/u;

/** Longest typed piece, and longest whole run, still read as one hidden word. */
const MAX_WILD_PART = 5;
const MAX_WILD_LEN = 16;

/**
 * How many letters a run may be hiding in total.
 *
 * Two covers what people actually write ("б**дь"). Beyond that the shape stops
 * being a word with letters knocked out and becomes a spelled-out sequence —
 * "S.M.A.R.T.", "до-ре-ми-фа-соль" — which, given enough slots, can be read as
 * almost anything.
 */
const MAX_WILD_SLOTS = 2;

/**
 * Equal, treating a slot as any character — but only while the slots stay a
 * minority of the word.
 *
 * Without that budget a slot-heavy window matches almost anything: "1.2.3-beta"
 * folds to a candidate whose middle reads "?e?", which is two thirds guesswork
 * and duly matched "sex". Half the word has to have actually been typed —
 * enough room for "б**дь", not enough for a three-letter root read out of two
 * guesses.
 */
function eqWild(a: string, b: string): boolean {
  if (a.length !== b.length || b.length < 3) return false;
  let slots = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === ANY) {
      // A slot on the edge of the match is guesswork about a letter that was
      // never even nearly typed: "-ми" is not evidence of a word ending in
      // "ми". The hidden letter has to sit between two typed ones.
      if (i === 0 || i === a.length - 1) return false;
      slots++;
      continue;
    }
    if (a[i] !== b[i]) return false;
  }
  return slots > 0 && slots <= Math.floor(b.length / 2);
}

function containsWild(hay: string, kw: string): boolean {
  if (kw.length > hay.length) return false;
  for (let i = 0; i + kw.length <= hay.length; i++) {
    if (eqWild(hay.slice(i, i + kw.length), kw)) return true;
  }
  return false;
}

/**
 * Does a candidate carrying slots match a list entry?
 *
 * Deliberately exact apart from the slots — no typo tolerance on top. A slot
 * already matches anything, and stacking edit distance on that would start
 * masking ordinary words that happen to sit next to a dash.
 */
function isBadWild(cyr: string, lat: string, lists: Lists): boolean {
  if (!cyr.includes(ANY)) return false;
  return lists.subs.some(r => {
    const [rc, rl] = kwVariants(r);
    return containsWild(cyr, rc) || containsWild(lat, rl);
  }) || lists.words.some(w => {
    const [wc, wl] = kwVariants(w);
    return eqWild(cyr, wc) || eqWild(lat, wl);
  });
}

// Keywords must be folded through the exact same pipeline as the input,
// otherwise they can never match it: NFKD turns "й" into "и"+breve, so the
// literal "обойд" would be compared against a folded "обоиди". Cached, since
// the lists are constant.
const kwCache = new Map<string, [string, string, string]>();
function kwVariants(kw: string): [string, string, string] {
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
 * Does the phonetic reading of `s` carry one of these stems?
 *
 * Kept apart from `hits` because it is fed its own, narrower lists: reading an
 * English word phonetically lands it somewhere in Cyrillic whether it means to
 * or not, so the general stem lists cannot be reused here. See the
 * TRANSLIT_* lists for what that rules out and why.
 */
function hitsTranslit(s: string, roots: string[]): boolean {
  if (!s || !roots.length) return false;
  const tr = variants(s)[2];
  if (!tr) return false;
  // Nobody transliterates the soft sign, so "фильтр" arrives as "filtr" and
  // has to be compared against a stem with the ь taken out. Dropping it on the
  // keyword side handles every such word at once instead of one at a time.
  return roots.some(r => fuzzyContains(tr, noSoftSign(kwVariants(r)[0])));
}

const noSoftSign = (v: string) => (v.includes('ь') || v.includes('ъ') ? v.replace(/[ьъ]/g, '') : v);

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

/**
 * The lists in force: stems (substring match), keywords (whole-word match),
 * and the narrower stems matched against a phonetic reading of Latin text.
 */
interface Lists { subs: string[]; words: string[]; translit: string[] }

function activeLists(cfg: CensorConfig, authorId?: string): Lists {
  const subs: string[] = [];
  const words: string[] = [];
  const tr: string[] = [];
  if (cfg.blur_profanity) {
    subs.push(...PROFANITY_ROOTS); words.push(...PROFANITY_WORDS); tr.push(...TRANSLIT_PROFANITY);
  }
  if (explicitApplies(cfg, authorId)) {
    subs.push(...EXPLICIT_ROOTS); words.push(...EXPLICIT_WORDS); tr.push(...TRANSLIT_EXPLICIT);
  }
  if (cfg.blur_calls_to_action) words.push(...CTA_KEYWORDS);
  if (cfg.blur_code_requests) words.push(...CODE_KEYWORDS);
  return { subs, words, translit: tr };
}

/** Should this word (or joined run) be masked? Exceptions always win. */
function isBad(s: string, lists: Lists): boolean {
  if (!s) return false;
  const [cyr] = variants(s);
  if (EXCEPTION_SET.has(cyr)) return false;
  return hits(s, lists.subs) || hitsWhole(s, lists.words) || hitsTranslit(s, lists.translit);
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

/**
 * A character deliberately written *as* a censor mark, standing in for a
 * letter.
 *
 * Narrower than the set the word-level pass uses, and for two reasons. A dot
 * or a hyphen is ordinary punctuation, so this pass would wake up on nearly
 * every sentence ever typed — measured at 3 ms a message, which a screenful
 * of them cannot afford. And it is not needed: those characters are already
 * handled a line above, where every separator is stripped out. Nobody hides a
 * letter behind a comma; they reach for an asterisk.
 *
 * Two copies of it: the global one is stateful, so the cheap "is there one at
 * all" test gets its own.
 */
const MASK_CHAR_G = /[*#@$%&•]/gu;
const MASK_CHAR_RE = /[*#@$%&•]/u;

/** Longest run of stand-ins credited; past this the message is mostly noise. */
const MAX_RUN_SLOTS = 8;

/** Slot reading of a whole message, at most this long — appeals are short. */
const MAX_SLOT_SCAN = 400;

/**
 * The message as letters and slots: each stand-in symbol becomes a slot,
 * spaces and ordinary punctuation are dropped as before.
 *
 * Folding runs per letter-run rather than over the whole string, because
 * `variants` collapses repeated characters — a run of five slots would come
 * back as one, and with it the room for the five letters it is hiding.
 */
function slotFlat(text: string, pick: 0 | 1): string {
  let out = '';
  let last = 0;
  const re = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const slots = (text.slice(last, m.index).match(MASK_CHAR_G) || []).length;
    out += ANY.repeat(Math.min(slots, MAX_RUN_SLOTS)) + variants(m[0])[pick];
    last = m.index + m[0].length;
  }
  const tail = (text.slice(last).match(MASK_CHAR_G) || []).length;
  return out + ANY.repeat(Math.min(tail, MAX_RUN_SLOTS));
}

/**
 * Does any contiguous stretch of `hay` spell `kw`, with every slot free to
 * stand for one character or for none?
 *
 * Both readings at once is the point. "откл*ч*" hides two letters inside the
 * word; "отк*л***" pads it with stand-ins that correspond to nothing. Trying
 * only one reading — which is all the old code did, deleting every symbol —
 * misses whichever case it did not assume.
 *
 * Run as a small automaton over the message: `reach[j]` is the most real
 * letters any path has used to match the first `j` characters of the keyword,
 * or -1 where no path exists. Position 0 restarts on every character, which is
 * what makes this a substring search.
 */
function spells(hay: string, kw: string): boolean {
  const m = kw.length;
  if (!m) return false;
  // Half the keyword has to have actually been typed. Slots match anything, so
  // without this a row of asterisks would spell every word on the list.
  const needLiterals = Math.max(3, Math.ceil(m / 2));
  if (m < 3) return false;

  let reach = new Int32Array(m + 1).fill(-1);
  reach[0] = 0;
  const next = new Int32Array(m + 1);

  for (let i = 0; i < hay.length; i++) {
    const c = hay[i];
    next.fill(-1);
    next[0] = 0;
    for (let j = 0; j <= m; j++) {
      const here = reach[j];
      if (here < 0) continue;
      if (c === ANY) {
        // Skip the slot, or spend it on the next keyword character.
        if (here > next[j]) next[j] = here;
        if (j < m && here > next[j + 1]) next[j + 1] = here;
      } else if (j < m && c === kw[j]) {
        if (here + 1 > next[j + 1]) next[j + 1] = here + 1;
      }
    }
    reach.set(next);
    if (reach[m] >= needLiterals) return true;
  }
  return reach[m] >= needLiterals;
}

/** Does the slot reading of the message carry one of these stems? */
function hitsSlots(hays: [string, string], roots: string[]): boolean {
  for (const pick of [0, 1] as const) {
    const hay = hays[pick];
    for (const r of roots) if (spells(hay, kwVariants(r)[pick])) return true;
  }
  return false;
}

// ── result caches ────────────────────────────────────────────────────────────
// Both entry points run on every render of every visible message, and the work
// is not cheap: tokenizing, folding, and fuzzy-matching against several hundred
// keywords. The text of a message never changes, so the answer is kept against
// the config epoch it was computed under.

interface Cached<T> { epoch: number; value: T }

const fullBlurCache = new Map<string, Cached<boolean>>();
const maskCache = new Map<string, Cached<string>>();

function cacheKey(text: string, authorId?: string): string {
  // The author id is a uuid, so a '/' cannot appear in it and the two parts
  // can never run together in a way that lets two different inputs collide.
  return `${authorId ?? ''}/${text}`;
}

/**
 * The slot reading of the whole message: a verb and a noun, both spelled
 * through stand-in symbols.
 *
 * Guarded on cost, because unlike the passes above this one walks the message
 * once per keyword. A message with no stand-ins in it has nothing here that
 * the plain pass did not already see, and a long one is not an appeal to
 * switch the filter off — those are short.
 */
function slotPassSays(text: string): boolean {
  if (text.length > MAX_SLOT_SCAN || !MASK_CHAR_RE.test(text)) return false;
  const hays: [string, string] = [slotFlat(text, 0), slotFlat(text, 1)];
  return hitsSlots(hays, DISABLE_VERBS) && hitsSlots(hays, DISABLE_NOUNS);
}

/** True when the whole message should be masked (disable-the-filter appeals). */
export function isFullBlur(text: string, cfg: CensorConfig = getCensorConfig()): boolean {
  if (!cfg.blur_enabled || !cfg.blur_disable_requests || !text) return false;

  const hit = fullBlurCache.get(text);
  if (hit && hit.epoch === epoch) return hit.value;

  // Strip every separator: defeats "о т к л ю ч и", "от-клю-чи", "от_клю_чи".
  const flat = text.slice(0, MAX_SCAN).replace(/[^\p{L}\p{N}]+/gu, '');
  // A verb AND a noun are both required, which is what makes it safe to read
  // the message phonetically too: "otkluchi filtr" masks, an English sentence
  // that happens to land on one of the stems does not.
  const value =
    (hits(flat, DISABLE_VERBS) && hits(flat, DISABLE_NOUNS))
    || (hitsTranslit(flat, TRANSLIT_DISABLE_VERBS) && hitsTranslit(flat, TRANSLIT_DISABLE_NOUNS))
    // And again reading the stand-in symbols as the letters they hide, rather
    // than as separators to throw away: "отк*ю** в на*тр*йках". Needing a verb
    // AND a noun is what makes this safe to run so loosely — one stray match
    // is not enough on its own.
    || slotPassSays(text)
    // Last, the classifier — for the appeals that carry no complete stem at
    // all, which is the one thing everything above depends on. "otkl v
    // nastroikah" gets past every rule here and does not get past this.
    || modelSaysAppeal(text);
  remember(fullBlurCache, text, { epoch, value }, 2000);
  return value;
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

  const key = cacheKey(text, authorId);
  const hit = maskCache.get(key);
  if (hit && hit.epoch === epoch) return hit.value;

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

  // Pass 2 — words re-joined across separators (spacing / markdown splitting),
  // and the same runs read the other way, with each separating symbol kept as
  // a slot for the letter it is hiding ("с*ка", "б**дь").
  for (let i = 0; i < tokens.length; i++) {
    let joined = tokens[i].raw;
    let wildCyr = variants(tokens[i].raw)[0];
    let wildLat = variants(tokens[i].raw)[1];
    // Someone hiding a letter writes a short word with a symbol in it. A run
    // whose pieces are long words is a hyphenated phrase — "по-настоящему",
    // which otherwise reads as "по?н" and lands on a root. So the slot view is
    // only offered while the run still looks like one short word.
    let wildSlots = 0;
    let wildOk = tokens[i].raw.length <= MAX_WILD_PART;

    for (let j = i + 1; j < tokens.length; j++) {
      const gap = text.slice(tokens[j - 1].end, tokens[j].start);
      if (!linkable(gap, tokens[j - 1], tokens[j])) break;
      joined += tokens[j].raw;
      if (joined.length >= 3 && isBad(joined, lists)) {
        maskRange(chars, tokens[i].start, tokens[j].end);
      }

      if (wildOk && MASK_RUN_RE.test(gap) && tokens[j].raw.length <= MAX_WILD_PART
          && wildSlots + gap.length <= MAX_WILD_SLOTS) {
        wildSlots += gap.length;
        wildCyr += ANY.repeat(gap.length) + variants(tokens[j].raw)[0];
        wildLat += ANY.repeat(gap.length) + variants(tokens[j].raw)[1];
        if (wildCyr.length <= MAX_WILD_LEN && isBadWild(wildCyr, wildLat, lists)) {
          maskRange(chars, tokens[i].start, tokens[j].end);
        }
      } else {
        // A gap that is not a mask run ends the slot reading; the plain join
        // above carries on regardless.
        wildOk = false;
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

  const value = chars.join('');
  remember(maskCache, key, { epoch, value }, 2000);
  return value;
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
  if (!cfg.blur_enabled || !explicitMediaApplies(cfg, opts.authorId)) return false;
  const lists: Lists = { subs: EXPLICIT_ROOTS, words: EXPLICIT_WORDS, translit: TRANSLIT_EXPLICIT };
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
