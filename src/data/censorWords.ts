// Word lists for the message blur filter (see ../utils/censor.ts for the
// matching engine). Kept apart from the engine so the lists can be edited
// without touching the matching logic.
//
// ── How to edit ──────────────────────────────────────────────────────────────
// Everything is compared AFTER normalization, so write entries in their plain
// canonical form — lowercase, no punctuation, no spaces. The engine already
// handles case, diacritics, invisible characters, stretched letters
// ("сууука"), Latin/Cyrillic lookalikes ("cyка") and leetspeak ("b1tch"), plus
// a typo tolerance of 1–2 edits on entries of 7+ characters. Adding
// "суука" or "s.u.k.a" is redundant.
//
// Two kinds of list, and the difference matters:
//
//   *_ROOTS    matched as a SUBSTRING, to cover inflected forms — "хуй"
//              also masks "нахуйчик". Only put stems here that cannot occur
//              inside an innocent word. Counter-examples deliberately left
//              out: "еба" (погреба), "хер" (Херсон), "анал" (канал, анализ),
//              "манда" (мандарин), "вирт" (виртуальный), "кончил" (закончил).
//
//   *_WORDS    matched as a WHOLE word only. Use for anything short or
//              ambiguous — "код" as a substring would mask "кодовую", and
//              "otp" would mask "посмотри" (its Latin fold is "пocmotpu").
//
// EXCEPTIONS is the safety net: a word listed there is never masked, whatever
// the stems say. Add to it whenever a real message gets masked by mistake.

// ── Profanity / мат ──────────────────────────────────────────────────────────

export const PROFANITY_ROOTS = [
  // Russian mat (stems cover declensions/prefixes)
  'хуй', 'хуё', 'хуе', 'хуя', 'хуи', 'пизд', 'пезд', 'ебло', 'ебал', 'ебан', 'ебат', 'ебуч', 'ебош', 'ебыр',
  'выеб', 'наеб', 'уеб', 'заеб', 'въеб', 'доеб', 'приеб', 'долбоеб', 'долбоёб',
  'бляд', 'блят', 'сука', 'суки', 'суке', 'суку', 'сучар', 'сучк', 'мудак', 'мудач', 'мудил',
  'пидор', 'пидар', 'пидр', 'гандон', 'гондон', 'залуп', 'дроч', 'мандав', 'елда', 'мраз',
  'говн', 'гнид', 'херн', 'херов', 'нахуй', 'похуй', 'охуе', 'охуё', 'ушлеп', 'шлюх', 'шалав',
  'выблядок', 'пиздец', 'писд',
  // English
  'fuck', 'shit', 'bitch', 'cunt', 'asshole', 'bastard', 'motherfuck', 'bullshit',
  'douche', 'wanker', 'faggot', 'whore', 'nigger',
];

export const PROFANITY_WORDS = ['чмо', 'slut', 'retard', 'dick', 'сучка', 'мудак'];

// ── Explicit / откровенный контент ───────────────────────────────────────────

export const EXPLICIT_ROOTS = [
  'порно', 'порн', 'секс', 'sex', 'porn', 'эрот', 'erotic', 'минет', 'blowjob', 'анальн', 'оргазм', 'orgasm',
  'интим', 'нюдс', 'дилдо', 'dildo', 'вибратор', 'onlyfans', 'титьк', 'сиськ', 'boobs',
  'генитал', 'genital', 'трахн', 'трахат', 'трахаю', 'соснут', 'мастурб', 'masturb', 'хентай', 'hentai',
  'изнасил', 'совокупл', 'penis', 'vagina', 'пенис', 'вагин', 'сперм', 'sperm',
  'голая', 'голые', 'голыш', 'порнух', 'ебуч',
];

export const EXPLICIT_WORDS = ['xxx', 'nude', 'nudes', 'cum', 'член', 'члена'];

// ── Calls to action / призывы к действию ─────────────────────────────────────

export const CTA_KEYWORDS = [
  'подпишись', 'подпишитесь', 'подписывайся', 'подписывайтесь',
  'купи', 'купите', 'купить', 'закажи', 'закажите', 'заказывай',
  'жми', 'жмите', 'кликни', 'кликните', 'кликай', 'переходи', 'перейди', 'переходите',
  'зарегистрируйся', 'зарегистрируйтесь', 'регистрируйся', 'успей', 'успевай', 'спеши',
  'subscribe', 'clickhere', 'buynow', 'signup', 'joinnow', 'actnow', 'freemoney', 'giveaway',
];

// Multi-word phrases. Matched with regexes on the raw (case-folded) text, so
// these DO contain spaces — unlike every list above.
export const CALL_TO_ACTION_RE = [
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

// ── Code requests / просьбы скинуть код (phishing) ───────────────────────────

export const CODE_KEYWORDS = [
  'код', 'кодподтверждения', 'смс', 'sms', 'otp', 'пароль', 'пароля',
  'password', 'верификация', 'верификации', 'verificationcode', 'confirmationcode',
  'onetimecode', 'securitycode', 'пинкод', 'pincode', 'cvv', 'cvc',
];

export const CODE_REQUEST_RE = [
  /(?:скинь|пришли|отправь|назови|продиктуй|скажи|напиши|дай|введи|сообщи)(?:\s+(?:мне|нам))?\s+код(?:\s+(?:из\s+)?(?:смс|sms|сообщения|подтвержд\w*))?/giu,
  /код(?:\s+(?:из\s+)?(?:смс|sms|подтвержд\w*|активац\w*|авторизац\w*))/giu,
  /(?:verification|confirmation|one[-\s]?time|security|login|otp)\s+code/giu,
  /send\s+(?:me\s+)?(?:the\s+)?code/giu,
  /\botp\b/giu,
  /код\s+подтвержд\w*/giu,
];

// ── "Turn this filter off" appeals → whole message masked ────────────────────
// A message is fully masked only when it carries a verb from the first list AND
// a noun from the second, so "выключи свет" stays visible while "выключи
// фильтр" does not.

export const DISABLE_VERBS = [
  'выключ', 'отключ', 'отруб', 'убер', 'убир', 'сним', 'снят', 'деактивир', 'отмен', 'выруб',
  'разблокир', 'обойд', 'обход', 'сделайвыключ',
  'disable', 'turnoff', 'switchoff', 'remove', 'unblock', 'bypass', 'deactivate',
];

export const DISABLE_NOUNS = [
  'фильтр', 'блюр', 'цензур', 'настройк', 'настройках', 'конфиденциальност', 'приватност',
  'звёздочк', 'звездочк', 'маскиров', 'ограничен', 'блокировк', 'модерац', 'безопасност',
  'blur', 'filter', 'censor', 'setting', 'settings', 'asterisk', 'privacy', 'restriction', 'moderation',
];

// ── Never-mask allowlist ─────────────────────────────────────────────────────
// Innocent words that a stem would otherwise catch. Checked before everything
// else, so an entry here always wins.

export const EXCEPTIONS = [
  'канал', 'канала', 'каналу', 'каналом', 'каналы', 'каналов', 'анализ', 'анализа', 'аналитика',
  'аналог', 'аналогично', 'аналогия', 'мандарин', 'мандарины', 'виртуальный', 'виртуальная', 'виртуал',
  'закончить', 'закончил', 'закончится', 'окончание', 'херсон', 'участник', 'сукно', 'погреба',
  'секция', 'кодовая', 'кодовую', 'кодом', 'кода', 'коды', 'кодекс', 'смска',
];
