// Feature extraction for the learned half of the censor.
//
// The rule-based filter in censor.ts matches stems it knows. This turns a
// message into the numeric vector the model scores instead, and it is shared
// verbatim by scripts/train-censor-model.mjs — if the two ever disagreed about
// what a message looks like, the trained weights would be meaningless.
//
// ── The canonical form ───────────────────────────────────────────────────────
// Everything is folded into one lowercase Latin alphabet: Cyrillic is
// transliterated, digits and symbols standing in for letters are read as those
// letters, and everything else is dropped. That is what lets a single model see
// "отключи", "otkluchi", "0tklu4i" and "отkл" as neighbours rather than as four
// unrelated strings — the obfuscations collapse before the model ever runs.

/** Cyrillic → Latin. One table, applied to both scripts' worth of input. */
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'j', з: 'z',
  и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sh',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  // Ukrainian and Belarusian letters, which turn up in evasion attempts as
  // homoglyphs for the Russian ones.
  і: 'i', ї: 'i', є: 'e', ґ: 'g', ў: 'u',
};

/** Digits and punctuation deliberately written in place of a letter. */
const LEET: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '6': 'b',
  '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i', '|': 'i',
};

/** Buckets the hashing trick maps n-grams into. Must match the trained model. */
export const FEATURE_BUCKETS = 16384;

/** N-gram sizes taken from the folded text. */
const NGRAMS = [3, 4, 5, 6];

/** Longest input considered; appeals to switch the filter off are short. */
export const MAX_MODEL_INPUT = 400;

/**
 * The canonical form of a message: lowercase Latin letters and nothing else.
 *
 * Runs of three or more identical letters collapse to one, which is what
 * defeats "оооотключи" without merging the ordinary double letters that real
 * words are full of.
 */
export function foldForModel(text: string): string {
  const lower = String(text || '').slice(0, MAX_MODEL_INPUT).toLowerCase()
    // Strip combining marks, so a letter wearing a diacritic as camouflage
    // folds onto the bare letter.
    .normalize('NFKD').replace(/\p{M}+/gu, '');

  let out = '';
  for (const ch of lower) {
    const mapped = TRANSLIT[ch] ?? LEET[ch] ?? (ch >= 'a' && ch <= 'z' ? ch : '');
    if (!mapped) continue;
    // Collapse a stretched letter, but only past a genuine doubling.
    if (mapped.length === 1 && out.length >= 2 && out[out.length - 1] === mapped && out[out.length - 2] === mapped) continue;
    out += mapped;
  }
  return out;
}

/** FNV-1a, folded into the bucket range. Cheap and adequate for hashing text. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % FEATURE_BUCKETS;
}

/**
 * The feature vector: which n-gram buckets the message lands in, as a sparse
 * map of bucket → weight, L2-normalized so a long message does not simply
 * outscore a short one.
 *
 * Presence rather than count. A word repeated five times is not five times the
 * evidence, and counting it made the model lean on padding.
 */
export function featurize(text: string): Map<number, number> {
  const folded = foldForModel(text);
  const buckets = new Set<number>();

  for (const n of NGRAMS) {
    for (let i = 0; i + n <= folded.length; i++) {
      buckets.add(hash(folded.slice(i, i + n)));
    }
  }

  const features = new Map<number, number>();
  if (!buckets.size) return features;
  const norm = 1 / Math.sqrt(buckets.size);
  for (const b of buckets) features.set(b, norm);
  return features;
}

/** The model's score for a feature vector, as a probability. */
export function score(features: Map<number, number>, weights: Float32Array, bias: number): number {
  let z = bias;
  for (const [bucket, value] of features) z += weights[bucket] * value;
  return 1 / (1 + Math.exp(-z));
}
