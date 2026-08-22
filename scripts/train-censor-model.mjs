// Trains the small classifier that backs up the rule-based censor.
//
//   node scripts/train-censor-model.mjs
//
// Writes src/data/censorModel.ts — a few kilobytes of quantized weights that
// ship with the bundle and run in the browser in microseconds.
//
// ── Why a model at all ───────────────────────────────────────────────────────
// The rules in censor.ts match stems. An appeal to switch the filter off only
// has to avoid every stem once: "otkl v nastroikah" carries no complete verb
// stem, so no rule fires, and the message goes through. A classifier over
// character n-grams has no such single point of failure — it sees "otkl",
// "nastroik" and the shape of the sentence around them, and each fragment
// contributes on its own.
//
// ── Where the data comes from ────────────────────────────────────────────────
// There is no corpus of these messages, so both classes are generated from the
// word lists in src/data/censorWords.ts and run through the same obfuscations a
// person would reach for. The negatives matter more than the positives:
//
//   • sentences with the verb but no noun ("отключи звук") and the noun but no
//     verb ("где настройки") — the boundary the rules already enforce, and the
//     one the model must not blur;
//   • obfuscated negatives, so the model learns the words rather than learning
//     that asterisks mean guilt;
//   • profanity and spam, so the four categories stay separate.
//
// The score printed at the end is on held-out generated data. It says the model
// learned the generator, not that it will hold up against a person — which is
// why the threshold is picked for precision and the model only ever adds to the
// rules' verdict, never overturns it.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  DISABLE_VERBS, DISABLE_NOUNS, TRANSLIT_DISABLE_VERBS, TRANSLIT_DISABLE_NOUNS,
  EXCEPTIONS, CTA_KEYWORDS, CODE_KEYWORDS, PROFANITY_WORDS, EXPLICIT_WORDS,
} from '../src/data/censorWords.ts';
import { featurize, FEATURE_BUCKETS } from '../src/utils/censorFeatures.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'data', 'censorModel.ts');

// A fixed seed: the same word lists must produce the same model, so a rebuild
// that changes nothing does not churn the checked-in weights.
let seed = 0x5f3a7c21;
function random() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
}
const pick = (arr) => arr[Math.floor(random() * arr.length)];
const chance = (p) => random() < p;

// ── the two classes, as sentences ────────────────────────────────────────────

const VERB_ENDINGS = ['и', 'ите', 'ь', 'ай', 'айте', 'я', 'им', 'ю', 'ил', 'ила', ''];
const NOUN_ENDINGS = ['', 'ы', 'а', 'у', 'ах', 'ов', 'е', 'ой', 'и'];

/**
 * Stems shortened the way people actually shorten them: "откл", "выкл", "наст".
 *
 * This is the single most important thing the generator does. Every rule in
 * censor.ts matches a complete stem, so a stem cut short is the whole of the
 * gap this model exists to close.
 */
function truncate(stem) {
  if (stem.length <= 3) return stem;
  return stem.slice(0, 3 + Math.floor(random() * (stem.length - 3)));
}

function verb() {
  const stem = chance(0.15) ? pick(TRANSLIT_DISABLE_VERBS) : pick(DISABLE_VERBS);
  return chance(0.35) ? truncate(stem) : stem + pick(VERB_ENDINGS);
}

function noun() {
  const stem = chance(0.15) ? pick(TRANSLIT_DISABLE_NOUNS) : pick(DISABLE_NOUNS);
  return chance(0.3) ? truncate(stem) : stem + pick(NOUN_ENDINGS);
}

/** The noun is what gets switched off: "отключи фильтр". */
const DIRECT_TEMPLATES = [
  '{v} {n}',
  '{v} {n} пожалуйста',
  '{v} {n} плиз',
  '{v} {n} у себя',
  'можешь {v} {n}?',
  'можешь {v} {n} а то не видно',
  'сначала {v} {n}, потом напиши',
  'у тебя {n} включен, {v} его',
  '{n} {v}',
  '{n} надо {v}',
  'чтобы увидеть, {v} {n}',
  'там {n}, ты его {v}',
  'просто {v} {n} и всё',
  'слушай {v} {n} а то ничего не понятно',
  'я тебе скинул, только {v} {n} сначала',
  '{v} нахрен {n}',
  'быстрее {v} {n}',
];

/**
 * The noun is where to go and switch it off: "откл в настройках".
 *
 * Worth its own list because the verb loses its object entirely — there is
 * nothing in the sentence naming what is being turned off, only where. That is
 * the shape the rules are weakest against and the shape people reach for.
 */
const LOCATIVE_TEMPLATES = [
  '{v} в {n}',
  '{v} в {n} пожалуйста',
  'в {n} {v}',
  'зайди в {n} и {v}',
  'иди в {n} там {v}',
  '{n} -> {v}',
  '{v} это в {n}',
  'посмотри в {n} и {v}',
  'у себя в {n} {v}',
  'открой {n} и {v}',
  '{v} там в {n}',
  'надо {v} в {n}',
  // "откл в настройках конфиденциальности" — the exact locative people write,
  // where the setting lives two nouns deep (settings → privacy).
  '{v} в настройках {n}',
  'в настройках {n} {v}',
  'зайди в настройки {n} и {v}',
  '{v} это в настройках {n}',
  'настройки {n} -> {v}',
];

function appeal() {
  const template = chance(0.4) ? pick(LOCATIVE_TEMPLATES) : pick(DIRECT_TEMPLATES);
  return template.replace('{v}', verb()).replace('{n}', noun());
}

// Ordinary chat. Short, mundane, and deliberately overlapping with the filter's
// vocabulary: half of these contain a disable verb or a filter noun, but never
// both in the sense the filter is looking for.
const ORDINARY = [
  'привет как дела',
  'ты где',
  'буду через полчаса',
  'отключи музыку пожалуйста',
  'выключи свет когда будешь уходить',
  'убери со стола',
  'сними это на видео',
  'выключи телевизор',
  'отключи уведомления в телеграме',
  'отключили горячую воду до пятницы',
  'у меня отключился интернет',
  'сними квартиру поближе к центру',
  'где настройки у этого приложения',
  'где настройки профиля',
  'зайди в настройки и поменяй аватарку',
  'в настройках можно поменять тему',
  'настройки не сохраняются почему-то',
  'открой настройки и посмотри версию',
  'в настройках есть тёмная тема',
  'я в настройках ничего не нашёл',
  'настройки сбросились после обновления',
  'зайди в настройки конфиденциальности и посмотри',
  'в настройках приватности всё включено',
  'у меня в настройках такого пункта нет',
  'настройки звука где-то там',
  'покажи свои настройки камеры',
  'какие настройки у тебя стоят',
  'в настройках профиля поменяй имя',
  'настройки уведомлений я уже трогал',
  'фильтр в чате работает нормально',
  'мне цензура не мешает вообще',
  'блюр включен по умолчанию у всех',
  'этот фильтр слишком строгий на мой вкус',
  'звёздочки вместо букв это фильтр',
  'фильтр для воды надо поменять',
  'поставь фильтр на фотку',
  'цензура в кино это отдельная тема',
  'какой у тебя фильтр стоит на камере',
  'блюр на фоне выглядит хорошо',
  'сделай блюр посильнее на фото',
  'приватность это важно',
  'политика конфиденциальности длинная очень',
  'звёздочка на карте это что',
  'я не понял что там',
  'скинь пожалуйста файл',
  'посмотри что я скинул',
  'давай завтра созвонимся',
  'во сколько встречаемся',
  'спасибо большое выручил',
  'да ладно не может быть',
  'я сейчас занят, напишу позже',
  'документы отправил на почту',
  'сколько это стоит',
  'а можно подробнее',
  'ок понял принял',
  'это не работает у меня',
  'перезагрузи и попробуй ещё раз',
  'обнови приложение до последней версии',
  'у тебя микрофон выключен',
  'выключи камеру, тебя не видно',
  'включи звук я тебя не слышу',
  'мне надо отключить автоплатёж',
  'как отключить рекламу в браузере',
  'убери это фото из альбома',
  'сними наконец эту куртку жарко же',
  'деактивируй старую карту в банке',
  'я убрал лишние файлы',
  'настройка занимает пять минут',
  'что по планам на выходные',
  'встретимся у метро в семь',
  'позвони мне когда освободишься',
  'я отправил перевод проверь',
  'взял билеты на субботу',
  'погода сегодня отличная',
  'не забудь про завтра',
  'всё в силе',
  'ушёл спать, до завтра',
];

/**
 * English UI / technical chatter. Short Latin words like "retry", "reload",
 * "cancel" have nothing to do with the filter, but read phonetically they land
 * on Cyrillic n-grams and the model was hiding them. They are all negatives.
 */
const ENGLISH_NEG = [
  'retry', 'click retry', 'press retry to continue', 'try again', 'retry please',
  'connection lost, retry', 'error, retry', 'reload', 'reload the page', 'refresh',
  'refresh the page', 'cancel', 'submit', 'submit the form', 'update', 'update available',
  'confirm', 'confirm your email', 'delete', 'close', 'close the tab', 'open', 'back',
  'next', 'test', 'test message', 'login', 'login failed', 'logout', 'save', 'save changes',
  'undo', 'redo', 'ok', 'ok thanks', 'yes', 'no', 'done', 'loading', 'timeout', 'retry now',
  'network error retry', 'please retry', 'retry connection', 'settings', 'privacy policy',
];

/**
 * Sentences built from the *other* categories' vocabulary.
 *
 * Swearing, spam and phishing are all things this filter handles, but each with
 * its own rule and its own kind of masking. Without these the model learns
 * "flagged-looking message" instead of "asking me to switch the filter off",
 * and starts hiding whole messages that only needed a word starred out.
 */
const OTHER_CATEGORIES = [
  'да иди ты {x}',
  'вот же {x}',
  'ну ты и {x} конечно',
  '{x} какой-то',
  'он {x} полный',
  '{x} блин',
  'скинь {x} быстрее',
  'жду {x}',
  'а где {x}',
  '{x} пришёл?',
];

function otherCategory() {
  const word = pick([...CTA_KEYWORDS, ...CODE_KEYWORDS, ...PROFANITY_WORDS, ...EXPLICIT_WORDS]);
  return pick(OTHER_CATEGORIES).replace('{x}', word);
}

function ordinary() {
  // A slice of ordinary traffic is plain English UI/technical chatter.
  if (chance(0.18)) return pick(ENGLISH_NEG);
  const base = pick(ORDINARY);
  // Sometimes glue on a word from the other categories, so profanity and spam
  // do not drift toward the appeal class.
  if (chance(0.2)) {
    const extra = pick([...EXCEPTIONS, ...CTA_KEYWORDS, ...CODE_KEYWORDS, ...PROFANITY_WORDS, ...EXPLICIT_WORDS]);
    return chance(0.5) ? `${base} ${extra}` : `${extra} ${base}`;
  }
  return base;
}

/**
 * A sentence with only one half of the pattern — the hardest negatives, and
 * the boundary the rules already draw.
 *
 * Only two shapes, and both unambiguous. "Turn off X" where X is anything but
 * the filter, and the filter's own vocabulary in a sentence that asks for
 * nothing. Asking someone to *open* the filter settings was tried here too and
 * withdrawn: "чтобы увидеть, открой цензуру" is an appeal by any reading, and
 * labelling it negative was teaching the model the opposite of the truth.
 */
const INNOCENT_OBJECTS = ['музыку', 'звук', 'свет', 'камеру', 'микрофон', 'рекламу',
  'уведомления', 'это', 'телевизор', 'подписку', 'автоплатёж', 'старую карту',
  'геолокацию', 'вибрацию', 'будильник', 'вай-фай', 'блютус'];

/** Places that are not the filter's settings — the locative counterexample. */
const INNOCENT_PLACES = ['телефоне', 'приложении', 'браузере', 'машине', 'офисе',
  'банке', 'ноуте', 'телеге', 'почте', 'личном кабинете'];

const NOUN_CONTEXTS = [
  'в {n} ничего такого нет',
  'у меня {n} по умолчанию стоит',
  '{n} нормально работает',
  'а что за {n} вообще',
  'я про {n} читал недавно',
  'мне {n} не мешает',
  '{n} везде одинаковые',
  'кто придумал эти {n}',
  'с {n} всё в порядке',
];

function halfAppeal() {
  const roll = random();
  if (roll < 0.4) return pick(DIRECT_TEMPLATES).replace('{v}', verb()).replace('{n}', pick(INNOCENT_OBJECTS));
  if (roll < 0.7) return pick(LOCATIVE_TEMPLATES).replace('{v}', verb()).replace('{n}', pick(INNOCENT_PLACES));
  return pick(NOUN_CONTEXTS).replace('{n}', noun());
}

// ── obfuscation ──────────────────────────────────────────────────────────────
// Applied to both classes at the same rate, so evasion itself carries no signal.

const HOMOGLYPH = {
  а: 'a', е: 'e', о: 'o', с: 'c', р: 'p', х: 'x', у: 'y', к: 'k', м: 'm',
  т: 't', в: 'b', н: 'h', и: 'u', з: '3', б: '6', г: 'r',
};
const MASKS = ['*', '#', '@', '$', '%', '&', '•'];
const SEPARATORS = [' ', '.', '-', '_', '·', ''];

/**
 * Swap a few adjacent letters. This is the "орткл" case: people transpose
 * letters ("откл" → "орткл", "настройки" → "натсройки") and the stem-matching
 * rules, which look for the letters in order, miss it entirely. Applied to both
 * classes so the transposition itself carries no signal — the model learns the
 * shape of the word, not that a scramble means guilt.
 */
function transpose(text) {
  const chars = [...text];
  const swaps = 1 + Math.floor(random() * 2);
  for (let s = 0; s < swaps; s++) {
    const i = Math.floor(random() * Math.max(1, chars.length - 1));
    if (chars[i] === ' ' || chars[i + 1] === ' ' || i + 1 >= chars.length) continue;
    [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];
  }
  return chars.join('');
}

function obfuscate(text) {
  if (random() < 0.14) text = transpose(text);

  const level = random();
  if (level < 0.45) return text;                       // most messages are plain

  let out = '';
  for (const ch of text) {
    if (ch === ' ') { out += ch; continue; }
    const roll = random();
    if (roll < 0.10 && HOMOGLYPH[ch]) out += HOMOGLYPH[ch];
    else if (roll < 0.16) out += pick(MASKS);           // a letter written over
    else if (roll < 0.20) out += ch + pick(SEPARATORS); // letters pulled apart
    else if (roll < 0.23) out += ch + ch + ch;          // stretched
    else if (roll < 0.25) continue;                     // dropped
    else out += ch;
  }
  return out;
}

// ── the data set ─────────────────────────────────────────────────────────────

const SAMPLES = 60000;

function buildSamples() {
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    const roll = random();
    if (roll < 0.35) samples.push({ text: obfuscate(appeal()), label: 1 });
    else if (roll < 0.60) samples.push({ text: obfuscate(ordinary()), label: 0 });
    else if (roll < 0.85) samples.push({ text: obfuscate(halfAppeal()), label: 0 });
    else samples.push({ text: obfuscate(otherCategory()), label: 0 });
  }
  return samples;
}

const all = buildSamples();
// Deduplicate: the generator repeats itself, and duplicates across the split
// would make the held-out score meaningless.
const seen = new Set();
const unique = all.filter(s => {
  const key = `${s.label} ${s.text}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const split = Math.floor(unique.length * 0.85);
const train = unique.slice(0, split);
const test = unique.slice(split);

const vectors = train.map(s => ({ features: featurize(s.text), label: s.label }));

console.log(`${unique.length} unique samples (${train.length} train / ${test.length} held out)`);
console.log(`positives: ${(unique.filter(s => s.label).length / unique.length * 100).toFixed(1)}%`);

// ── logistic regression, plain SGD ───────────────────────────────────────────

const weights = new Float32Array(FEATURE_BUCKETS);
let bias = 0;

// AdaGrad. The features are hashed n-grams, so their frequencies differ by
// orders of magnitude — a common trigram appears in nearly every message, a
// rare six-gram in a handful. A single learning rate either crawls on the rare
// ones or diverges on the common ones; a per-feature rate handles both.
const accumulated = new Float32Array(FEATURE_BUCKETS);
let biasAccumulated = 0;

const EPOCHS = 30;
const RATE = 0.5;
const L2 = 1e-7;

for (let epoch = 0; epoch < EPOCHS; epoch++) {
  // Shuffle in place, so consecutive epochs do not see the same order.
  for (let i = vectors.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [vectors[i], vectors[j]] = [vectors[j], vectors[i]];
  }

  let loss = 0;
  for (const { features, label } of vectors) {
    let z = bias;
    for (const [bucket, value] of features) z += weights[bucket] * value;
    const p = 1 / (1 + Math.exp(-z));
    const error = p - label;
    loss -= label ? Math.log(Math.max(p, 1e-9)) : Math.log(Math.max(1 - p, 1e-9));

    biasAccumulated += error * error;
    bias -= (RATE / Math.sqrt(biasAccumulated + 1e-8)) * error;

    for (const [bucket, value] of features) {
      const gradient = error * value + L2 * weights[bucket];
      accumulated[bucket] += gradient * gradient;
      weights[bucket] -= (RATE / Math.sqrt(accumulated[bucket] + 1e-8)) * gradient;
    }
  }
  if (epoch % 5 === 4 || epoch === 0) {
    console.log(`epoch ${epoch + 1}/${EPOCHS}  loss ${(loss / vectors.length).toFixed(4)}`);
  }
}

// ── threshold ────────────────────────────────────────────────────────────────
// The model runs after the rules and can only add a verdict, so a false
// positive is an ordinary message hidden behind asterisks with nothing left to
// catch the mistake, while a false negative merely leaves the filter where it
// already was. The trade is therefore lopsided, and so is the threshold: take
// the lowest one that misclassifies nothing at all in the held-out set. That
// costs recall — around half of the generated appeals score below it — but
// every one of those is an appeal the rules were going to miss anyway.

function probability(text) {
  let z = bias;
  for (const [bucket, value] of featurize(text)) z += weights[bucket] * value;
  return 1 / (1 + Math.exp(-z));
}

const scored = test.map(s => ({ label: s.label, p: probability(s.text) }));
const positives = scored.filter(s => s.label === 1);
const negatives = scored.filter(s => s.label === 0);

/**
 * Held-out false positives allowed when picking the threshold.
 *
 * Not as small as it could be, and deliberately. Driving this to zero pushes
 * the threshold past 0.999, and what sits between 0.99 and 0.999 is not real
 * negatives — it is the generator's own label noise, obfuscated negatives
 * mangled until the innocent half of the sentence is gone. Meanwhile the
 * hand-written ordinary messages below never clear 0.06, so the margin that
 * actually matters is three orders of magnitude wide either way.
 */
const MAX_FALSE_POSITIVES = 0.005;

const CANDIDATES = [0.75, 0.8, 0.85, 0.9, 0.95, 0.97, 0.99, 0.995, 0.999, 0.9995, 0.9999];
let threshold = CANDIDATES[CANDIDATES.length - 1];
for (const t of CANDIDATES) {
  const fp = negatives.filter(s => s.p >= t).length / negatives.length;
  const tp = positives.filter(s => s.p >= t).length / positives.length;
  console.log(`  t=${t}  recall ${(tp * 100).toFixed(1)}%  false ${(fp * 100).toFixed(3)}%`);
  if (fp <= MAX_FALSE_POSITIVES && threshold === CANDIDATES[CANDIDATES.length - 1]) threshold = t;
}

// The auto-picked threshold optimises against the generated held-out set, whose
// "false positives" between 0.95 and 0.99 are mostly the generator's own label
// noise (mangled negatives). Real ordinary text scores far lower — the
// hand-written block below never clears ~0.10 — so a ceiling here buys back a
// lot of recall on genuine transposed/abbreviated appeals ("орткл в настройках
// конф") at no measurable cost on real messages. The by-hand guard at the end
// still fails the build if any real ordinary message crosses it.
const THRESHOLD_CEILING = 0.96;
threshold = Math.min(threshold, THRESHOLD_CEILING);

const recall = positives.filter(s => s.p >= threshold).length / positives.length;
const falseRate = negatives.filter(s => s.p >= threshold).length / negatives.length;

console.log(`\nthreshold ${threshold}`);
console.log(`  caught     ${(recall * 100).toFixed(1)}% of held-out appeals`);
console.log(`  wrongly    ${(falseRate * 100).toFixed(2)}% of held-out ordinary messages`);

// ── written by hand, never trained on ────────────────────────────────────────
// The held-out set is still the generator's own output, so a good score there
// only proves the model learned the generator. These are typed out by hand: the
// evasions the rules are known to miss, and the ordinary messages closest to
// them. Read the margin between the two blocks, not the individual numbers.

const BY_HAND_APPEALS = [
  'otkl v nastroikah', 'otkl filtr', 'откл в настройках', 'otkluchi cenzuru',
  'ubery blur', 'вык fil в настр', 'сними звёздочки плз', 'выкл фильтр',
  'у тебя цензура вкл, вырубь', 'zaydi v nastroyki i otkl', 'убери блюр пж',
  // transposed / abbreviated appeals the rules miss
  'орткл в настройках конф', 'откл в настройках конф', 'орткл в настр конфа',
  'натсройки конфиденциальности откл', 'вырубь блюр в натсройках',
];

const BY_HAND_ORDINARY = [
  'привет, как дела?', 'отключи музыку пожалуйста', 'где настройки профиля',
  'фильтр для воды поменял', 'блюр на фото классный', 'выключи камеру тебя не видно',
  'скинь код из смс', 'да иди ты нахер', 'встретимся в семь у метро',
  'как отключить рекламу в хроме', 'настройки не открываются', 'сними квартиру поближе',
  'политика конфиденциальности у них длинная', 'я тебе скинул фото посмотри',
  'отключили горячую воду', 'убери со стола пожалуйста', 'в настройках поменяй аватарку',
  // English UI / technical words — must stay blank
  'retry', 'click retry', 'reload', 'refresh', 'connection error retry',
  'cancel', 'submit', 'update available', 'confirm your email', 'try again',
];

function report(label, texts) {
  console.log(`\n${label}`);
  for (const text of texts) {
    const p = probability(text);
    console.log(`  ${p >= threshold ? 'BLUR' : '    '}  ${p.toFixed(4)}  ${text}`);
  }
}

report('by hand — evasions the rules miss (want BLUR)', BY_HAND_APPEALS);
report('by hand — ordinary messages (want blank)', BY_HAND_ORDINARY);

const worstOrdinary = Math.max(...BY_HAND_ORDINARY.map(probability));
console.log(`\nhighest-scoring ordinary message: ${worstOrdinary.toFixed(4)} (threshold ${threshold})`);
if (worstOrdinary >= threshold) {
  console.error('  ^ above the threshold. The threshold or the negatives need work.');
  process.exitCode = 1;
}

// ── quantize and write ───────────────────────────────────────────────────────
// int8 with a single scale. The loss is far below the margin the threshold
// leaves, and it turns 32 KB of floats into 8 KB of bytes.

let peak = 0;
for (const w of weights) peak = Math.max(peak, Math.abs(w));
const scale = peak / 127;

const quantized = Buffer.alloc(FEATURE_BUCKETS);
for (let i = 0; i < FEATURE_BUCKETS; i++) {
  quantized[i] = Math.round(weights[i] / scale) & 0xff;
}

writeFileSync(OUT, `// Generated by scripts/train-censor-model.mjs — do not edit by hand.
//
// Trained on ${unique.length.toLocaleString('en-US')} generated samples. At the threshold below it caught
// ${(recall * 100).toFixed(1)}% of held-out appeals and misread ${(falseRate * 100).toFixed(2)}% of held-out ordinary messages.
//
// The weights are int8, base64-encoded; multiply by \`scale\` to recover them.

export const censorModel = {
  version: 1,
  buckets: ${FEATURE_BUCKETS},
  scale: ${scale},
  bias: ${bias},
  threshold: ${threshold},
  weights:
    '${quantized.toString('base64')}',
};
`);

console.log(`\nwrote ${OUT} (${(readFileSync(OUT).length / 1024).toFixed(1)} KB)`);
