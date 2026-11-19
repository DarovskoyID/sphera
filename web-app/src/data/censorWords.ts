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
//
// ── Languages ────────────────────────────────────────────────────────────────
// The app ships in ru, en, de, es, fr, pt and zh, and the filter has to hold in
// all of them — a reader who set the interface to Spanish is not agreeing to
// see unfiltered Spanish. Two rules follow from how the engine normalizes:
//
//   • Write Latin-script entries WITHOUT diacritics. Folding strips them, so
//     "bâtard" is compared as "batard" and "hijo de puta" as "hijodeputa".
//     Note the trap this creates: "coño" folds to "cono", which is an ordinary
//     word and lives inside "conocer" — such terms are left out on purpose.
//
//   • Chinese has no spaces, so the tokenizer sees a whole sentence as one
//     word and whole-word matching can never fire. CJK terms therefore live in
//     the CJK_* lists below, which are matched as exact substrings and mask
//     only the characters they hit, not the sentence around them.
//
// Every list is scanned regardless of the interface language: people mix
// languages in one message, and the filter follows the text, not the setting.

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
  // German. "arsch" is a stem of Marsch, so only the compound goes here.
  'arschloch', 'wichser', 'hurensohn', 'fotze', 'schlampe', 'missgeburt',
  'scheiss', 'scheiße', 'fick', 'verpiss',
  // Spanish. "puta", "polla", "verga", "zorra" are stems of disputa, ampolla,
  // divergan and azorrar — they are whole words below instead.
  'gilipollas', 'hijoputa', 'hijodeputa', 'cabron', 'pendejo', 'chinga',
  'joder', 'follar', 'maricon', 'mierda', 'cojones', 'malparido',
  // French. "nique" is a stem of unique/tunique, so it is a whole word below.
  'putain', 'connard', 'connasse', 'encule', 'enculer', 'salope', 'salaud',
  'batard', 'merde', 'branleur', 'ordure',
  // Portuguese. "viado" is a stem of enviado — whole word below.
  'caralho', 'filhadaputa', 'filhodaputa', 'foder', 'buceta', 'porra',
  'bosta', 'arrombado', 'otario',
];

export const PROFANITY_WORDS = [
  'чмо', 'slut', 'retard', 'dick', 'сучка', 'мудак',
  // German
  'arsch', 'hure', 'huren', 'nutte', 'kacke', 'pisser', 'spast', 'ficken',
  // Spanish
  'puta', 'putas', 'puto', 'putos', 'polla', 'verga', 'zorra', 'mamon',
  'cabrona', 'chingado', 'chingada',
  // French
  'nique', 'niquer', 'pute', 'putes', 'chier', 'foutre',
  // Portuguese ("puta" above is shared with Spanish)
  'viado', 'corno', 'cacete', 'vadia',
];

// ── Explicit / откровенный контент ───────────────────────────────────────────

export const EXPLICIT_ROOTS = [
  'порно', 'порн', 'секс', 'sex', 'porn', 'эрот', 'erotic', 'минет', 'blowjob', 'анальн', 'оргазм', 'orgasm',
  'интим', 'нюдс', 'дилдо', 'dildo', 'вибратор', 'onlyfans', 'титьк', 'сиськ', 'boobs',
  'генитал', 'genital', 'трахн', 'трахат', 'трахаю', 'соснут', 'мастурб', 'masturb', 'хентай', 'hentai',
  'изнасил', 'совокупл', 'penis', 'vagina', 'пенис', 'вагин', 'сперм', 'sperm',
  'голая', 'голые', 'голыш', 'порнух', 'ебуч',
  // German
  'nackt', 'titten', 'muschi', 'schwanzbild', 'geilheit', 'pornhub',
  // Spanish / Portuguese (much of the vocabulary is shared)
  'desnud', 'pornograf', 'masturbac', 'consolador', 'punheta', 'safada',
  // French
  'pornographi', 'branlette', 'salopeplan', 'sodomi', 'ejacul',
];

export const EXPLICIT_WORDS = [
  'xxx', 'nude', 'nudes', 'cum', 'член', 'члена',
  // German
  'geil', 'schwanz', 'busen',
  // Spanish
  'tetas', 'coger', 'corrida', 'pajero',
  // French
  'bite', 'seins', 'chatte', 'nichons',
  // Portuguese
  'pelada', 'peitos', 'rola',
];

// ── Calls to action / призывы к действию ─────────────────────────────────────

export const CTA_KEYWORDS = [
  'подпишись', 'подпишитесь', 'подписывайся', 'подписывайтесь',
  'купи', 'купите', 'купить', 'закажи', 'закажите', 'заказывай',
  'жми', 'жмите', 'кликни', 'кликните', 'кликай', 'переходи', 'перейди', 'переходите',
  'зарегистрируйся', 'зарегистрируйтесь', 'регистрируйся', 'успей', 'успевай', 'спеши',
  'subscribe', 'clickhere', 'buynow', 'signup', 'joinnow', 'actnow', 'freemoney', 'giveaway',
  // German
  'abonniere', 'abonnieren', 'jetztkaufen', 'hierklicken', 'anmelden', 'gratis',
  // Spanish
  'suscribete', 'suscribanse', 'compraya', 'hazclic', 'registrate', 'aprovecha',
  // French
  'abonnetoi', 'abonnezvous', 'achetemaintenant', 'cliqueici', 'inscristoi', 'profitez',
  // Portuguese
  'inscrevase', 'compreja', 'cliqueaqui', 'cadastrese', 'aproveite',
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
  /jetzt\s+(?:kaufen|anmelden|zugreifen)/giu,
  /hier\s+klicken/giu,
  /(?:compra|ordena)\s+(?:ya|ahora)/giu,
  /haz\s+clic\s+(?:aqui|ahora)/giu,
  /suscri(?:bete|banse)\s+(?:ya|ahora)?/giu,
  /(?:achete|commande)z?\s+maintenant/giu,
  /clique[zr]?\s+ici/giu,
  /inscri(?:s[- ]toi|vez[- ]vous)/giu,
  /compre\s+(?:ja|agora)/giu,
  /clique\s+aqui/giu,
  /inscreva[- ]se/giu,
];

// ── Code requests / просьбы скинуть код (phishing) ───────────────────────────

// Only words that mean a one-time code by themselves. Plain "код", "пароль",
// "смс" are everyday words ("скинь пароль от вай фай", "код от домофона") —
// requests for real codes are caught by CODE_REQUEST_RE with their context.
export const CODE_KEYWORDS = [
  'кодподтверждения', 'otp', 'verificationcode', 'confirmationcode',
  'onetimecode', 'securitycode', 'cvv', 'cvc',
  // German
  'bestatigungscode', 'sicherheitscode', 'einmalcode',
  // Spanish
  'codigodeverificacion',
  // French
  'codedeverification',
  // Portuguese
  'codigodeconfirmacao',
];

/**
 * A message about everyday secrets or program code: code-request phrases do
 * not apply to it ("скинь пароль от вай фай", "код от домофона", "скинь код
 * проекта").
 */
export const BENIGN_CODE_CONTEXT_RE =
  /wi-?fi|вай\W?фа|вайфа|роутер|router|домофон|подъезд|калитк|шлагбаум|ворот|двер|замк|замок|сейф|гараж|сигнализац|исходн|репозитор|github|gitlab|коммит|функци|скрипт|программ|проект|ревью|review|промокод|promo|скидк|купон|трек|артикул|код\w*\s+ошибк|error\s+code/iu;

export const CODE_REQUEST_RE = [
  /(?:скинь|пришли|отправь|назови|продиктуй|скажи|напиши|дай|введи|сообщи)(?:\s+(?:мне|нам))?\s+код(?:\s+(?:из\s+)?(?:смс|sms|сообщения|подтвержд\w*))?/giu,
  /код(?:\s+(?:из\s+)?(?:смс|sms|подтвержд\w*|активац\w*|авторизац\w*))/giu,
  /(?:verification|confirmation|one[-\s]?time|security|login|otp)\s+code/giu,
  /send\s+(?:me\s+)?(?:the\s+)?code/giu,
  /\botp\b/giu,
  /код\s+подтвержд\w*/giu,
  /(?:schick|sende?|gib)\s+(?:mir\s+)?(?:den\s+)?(?:code|passwort)/giu,
  /(?:bestatigungs|sicherheits|verifizierungs)code/giu,
  /(?:envia|mandame|dime|pasame)\s*(?:me)?\s+(?:el\s+)?codigo/giu,
  /codigo\s+de\s+(?:verificacion|confirmacion|seguridad)/giu,
  /(?:envoie|donne|passe)[- ]?moi\s+(?:le\s+)?code/giu,
  /code\s+de\s+(?:verification|confirmation|securite)/giu,
  /(?:envia|manda|passa)\s*(?:me)?\s+(?:o\s+)?codigo/giu,
  /codigo\s+de\s+(?:verificacao|confirmacao|seguranca)/giu,
];

// ── "Turn this filter off" appeals → whole message masked ────────────────────
// A message is fully masked only when it carries a verb from the first list AND
// a noun from the second, so "выключи свет" stays visible while "выключи
// фильтр" does not.

export const DISABLE_VERBS = [
  'выключ', 'отключ', 'отруб', 'убер', 'убир', 'сним', 'снят', 'деактивир', 'отмен', 'выруб',
  'разблокир', 'обойд', 'обход', 'сделайвыключ',
  'disable', 'turnoff', 'switchoff', 'remove', 'unblock', 'bypass', 'deactivate',
  'ausschalt', 'abschalt', 'deaktivier', 'entfern', 'umgeh',
  'desactiv', 'desactive', 'quita', 'quitar', 'apaga', 'apagar', 'elimina',
  'desativ', 'desligar', 'remover', 'contornar',
  'desactive', 'enleve', 'enlever', 'supprime', 'contourne',
  // Chinese — matched as substrings of the separator-stripped message.
  '关闭', '关掉', '取消', '解除', '绕过', '停用',
];

export const DISABLE_NOUNS = [
  'фильтр', 'блюр', 'цензур', 'настройк', 'настройках', 'конфиденциальност', 'приватност',
  'звёздочк', 'звездочк', 'маскиров', 'ограничен', 'блокировк', 'модерац', 'безопасност',
  'blur', 'filter', 'censor', 'setting', 'settings', 'asterisk', 'privacy', 'restriction', 'moderation',
  'einstellung', 'zensur', 'privatsphare', 'beschrankung', 'unschar',
  'filtro', 'censura', 'ajustes', 'configuracion', 'privacidad', 'restriccion',
  'configuracao', 'privacidade', 'restricao', 'desfoque',
  'reglage', 'parametres', 'confidentialite', 'flou',
  // Chinese
  '过滤', '屏蔽', '审查', '隐私', '设置', '打码', '马赛克',
];

// ── Transliteration ──────────────────────────────────────────────────────────
// Russian written in Latin letters — "suka", "blyat", "poshel na huy". The
// engine reads such text phonetically into Cyrillic and matches it against the
// stems below.
//
// This is deliberately its OWN list rather than a reuse of PROFANITY_ROOTS, and
// the reason is false positives: an English word read phonetically lands
// somewhere in Cyrillic whether it means to or not. Measured against ordinary
// English, "southern" becomes "соутхерн" and hits "херн"; "success" becomes
// "сукес" and hits "суке"; "hue" becomes "хуе". Only stems that survive that
// test belong here — which is why "суке", "суку" and "херн" are absent even
// though they are perfectly good Cyrillic stems.

export const TRANSLIT_PROFANITY = [
  'сука', 'суки', 'сучк', 'сучар', 'блят', 'бляд', 'пизд', 'писд',
  'хуй', 'хуе', 'хуя', 'хуи', 'нахуй', 'похуй', 'охуе', 'ахуе',
  'ебал', 'ебан', 'ебат', 'ебуч', 'заеб', 'выеб', 'наеб', 'уеб', 'доеб',
  'мудак', 'мудил', 'пидор', 'пидар', 'гандон', 'гондон', 'долбоеб',
  'шлюх', 'шлух', 'шалав', 'залуп', 'дроч', 'мраз', 'гнид', 'ушлеп',
];

export const TRANSLIT_EXPLICIT = [
  'порно', 'порну', 'сиськ', 'титьк', 'минет', 'трахн', 'трахат',
  'голая', 'голые', 'нюдс', 'мастурб', 'хентай', 'вагин', 'пенис', 'сперм',
];

// Long enough that an English word is very unlikely to land on them, and a
// whole-message mask needs a verb AND a noun anyway.
// "ю" is routinely written as plain "u" rather than "yu" — "otkluchi", "blur" —
// so the lazy spelling gets its own entry next to the careful one.
export const TRANSLIT_DISABLE_VERBS = [
  'отключ', 'отклуч', 'выключ', 'виключ', 'виклуч', 'убер', 'убир', 'сними', 'обход', 'обойд',
];
export const TRANSLIT_DISABLE_NOUNS = [
  'фильтр', 'цензур', 'блюр', 'блур', 'настройк', 'звездочк', 'маскиров',
];

// ── Chinese ──────────────────────────────────────────────────────────────────
// Matched as exact substrings against the message, and masking covers only the
// characters that matched. Everything above relies on a tokenizer that splits
// on spaces, which Chinese does not have — without these lists the filter is
// simply absent for a whole language.

export const CJK_PROFANITY = [
  '傻逼', '傻屄', '沙比', '煞笔', '妈的', '他妈的', '你妈', '操你妈', '草泥马',
  '卧槽', '我操', '我靠', '贱人', '婊子', '混蛋', '王八蛋', '狗娘养的',
  '滚蛋', '去死', '白痴', '废物点心', '娘炮',
];

export const CJK_EXPLICIT = [
  '色情', '情色', '黄片', '黄色视频', '成人视频', '裸照', '裸体', '做爱',
  '性爱', '强奸', '自慰', '阴茎', '阴道', '乳房', '淫秽', '约炮', '一夜情',
  '援交', '嫖娼',
];

export const CJK_CTA = [
  '立即购买', '马上下单', '点击这里', '点击链接', '立即注册', '快来注册',
  '免费领取', '限时优惠', '限时抢购', '扫码关注', '加我微信',
];

export const CJK_CODE = [
  '验证码', '短信验证码', '手机验证码', '动态密码', '支付密码', '安全码',
];

// ── Never-mask allowlist ─────────────────────────────────────────────────────
// Innocent words that a stem would otherwise catch. Checked before everything
// else, so an entry here always wins.

export const EXCEPTIONS = [
  'канал', 'канала', 'каналу', 'каналом', 'каналы', 'каналов', 'анализ', 'анализа', 'аналитика',
  'аналог', 'аналогично', 'аналогия', 'мандарин', 'мандарины', 'виртуальный', 'виртуальная', 'виртуал',
  'закончить', 'закончил', 'закончится', 'окончание', 'херсон', 'участник', 'сукно', 'погреба',
  'секция', 'кодовая', 'кодовую', 'кодом', 'кода', 'коды', 'кодекс', 'смска',
  // Ordinary words the new Latin stems would otherwise catch.
  // "sex" lives in EXPLICIT_ROOTS and is inside the Romance words for "sixth".
  'sexto', 'sexta', 'sextafeira', 'sexteto', 'sextante', 'sexenio',
  // "merde"/"mierda" are fine, but these are not the same word.
  'merdeka', 'mierdo',
  // "fick" (de) inside ordinary words; "arsch" is only ever a whole word here.
  'affiche', 'affichen', 'ficken' /* handled as a whole word */,
  'marsch', 'marschall', 'forscher',
  // "puta"/"polla"/"verga"/"nique" as substrings of innocent words. They are
  // whole-word entries, but the fuzzy joiner can still reach them.
  'disputa', 'disputar', 'reputacion', 'reputacao', 'amputar', 'computador',
  'ampolla', 'cebolla', 'divergan', 'unique', 'tunique', 'technique', 'clinique',
  'orbite', 'cubitale', 'habite', 'habiter',
  // "coger" is entirely ordinary Spanish in Spain, and "corrida" is a bullfight.
  'recoger', 'escoger', 'acoger', 'corredor',
  // "gratis", "clave", "senha", "codigo" are everyday words outside a phishing
  // sentence; the phrase regexes above catch the real requests.
  'clavecin', 'claveles', 'codigos',
  // Words whose phonetic reading lands on a Russian stem by accident.
  // "hue" reads as "хуе", "sukiyaki" carries "суки".
  'hue', 'hues', 'sukiyaki', 'sukiyakis',
];
