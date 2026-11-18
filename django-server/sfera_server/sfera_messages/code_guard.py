"""Stops a user from sending a secret code (SMS / bank / app one-time code).

Default mode, context: a message is blocked when both hold
  1. it looks like a code: a standalone group of 4–8 digits ("4821", "482 913",
     "48-29-13"), or 3 digits when the request was for a CVV/CVC;
  2. one of the other participants' recent messages (last RECENT_LIMIT within
     RECENT_WINDOW) asks for such a code.

Everyday secrets are not codes: "скинь пароль от вай фай", "код от домофона",
"скинь код проекта" are not phishing, so a request about Wi-Fi, an intercom, a
door, source code etc. does not count (BENIGN_RE).

Strict mode (ChatSafetySettings.block_all_codes, switched on by the superuser):
any code-like message is blocked regardless of context, when it is just the
code or it is presented as a code ("код 4821", "пароль из смс 4821").

The Rust ws-gateway pre-filters with a cheap digit scan and asks Django
(ws_authorize type "chat_send_check") only for code-like messages.
"""
import re
from datetime import timedelta

from django.utils import timezone

RECENT_WINDOW = timedelta(minutes=30)
RECENT_LIMIT = 10
BLOCKED_ERROR = 'code_blocked'

# A digit group not glued to letters, other digits or amount/time punctuation.
# Separators inside the group: single space or dash.
_CODE_RE = re.compile(r'(?<![\w.,:/+])(?<!\d[ \-])(\d(?:[ \-]?\d)*)(?![\w.,:/%₽$€])')

# What a phishing request is about. "Пароль"/"пин" alone are too broad (Wi-Fi,
# intercom), so they count only when tied to SMS / bank / account below.
_OTP = r'(?:код\w*|цифр\w*|sms|смс|эсэмэс\w*|пуш\w*|push|otp|code|passcode|cvv\d?|cvc\d?)'
_ASK_VERB = (
    r'(?:скаж\w*|продикту\w*|диктуй\w*|назов\w*|назови\w*|пришл\w*|присла\w*|скин\w*|скидыва\w*|'
    r'отправ\w*|напиш\w*|написа\w*|сообщ\w*|переш\w*|пересла\w*|кин\w*|дай\w*|давай\w*|подскаж\w*|'
    r'send|tell|give|share|forward|read|text|type)'
)
_SOURCE = (
    r'(?:смс|sms|сообщени\w*|пуш\w*|push|госуслуг\w*|банк\w*|сбер\w*|тинькофф\w*|т-банк\w*|втб|альф\w*|'
    r'приложени\w*|телефон\w*|номер\w*|карт\w*|почт\w*|звонк\w*|аккаунт\w*|учётн\w*|учетн\w*|'
    r'личн\w* кабинет\w*|whatsapp|ватсап\w*|telegram|телеграм\w*|вк|vk|озон\w*|ozon|wildberries|вайлдберриз|'
    r'app|bank|account|card|email|phone)'
)
_REQUEST_PATTERNS = [
    # "скажите код", "пришли цифры", "send me the code"
    re.compile(_ASK_VERB + r'(?:\W+\w+){0,4}?\W+' + _OTP, re.I),
    # "код из смс", "пароль от госуслуг", "пин от карты"
    re.compile(r'(?:код\w*|парол\w*|пин\w*|pin|password)\W+(?:\w+\W+){0,2}?(?:из|с|со|от|в|по|for|from)\W+'
               r'(?:\w+\W+){0,1}?' + _SOURCE, re.I),
    re.compile(r'(?:код\w*|парол\w*)\W+(?:подтвержд\w*|верификац\w*|активац\w*|доступ\w*|авториз\w*|входа|'
               r'безопасност\w*|одноразов\w*)', re.I),
    re.compile(r'одноразов\w*\W+(?:код\w*|парол\w*)', re.I),
    re.compile(r'(?:verification|confirmation|security|one[- ]time|login|sms|2fa|otp)\W+code', re.I),
    # "какой код пришёл?", "цифры в смс пришли?"
    re.compile(r'(?:как\w+|что\w*)\W+(?:\w+\W+){0,2}?' + _OTP + r'(?:\W+\w+){0,3}?\W+(?:приш\w*|приход\w*)', re.I),
    re.compile(_OTP + r'\W+(?:\w+\W+){0,2}?(?:приш[её]л|пришли|придёт|придет|должен прийти|came|arrived)', re.I),
    re.compile(r'(?:трёхзначн|трехзначн|обратной сторон\w*|back of (?:the|your) card)', re.I),
]
_CVV_RE = re.compile(r'cvv|cvc|трёхзначн|трехзначн|обратной сторон|back of (?:the|your) card', re.I)

# Everyday secrets and "code" in the programming sense: not a phishing request.
BENIGN_RE = re.compile(
    r'wi-?fi|вай\W?фа\w*|вайфа\w*|роутер\w*|router|домофон\w*|подъезд\w*|калитк\w*|шлагбаум\w*|ворот\w*|'
    r'двер\w*|замк\w*|замок|сейф\w*|гараж\w*|ячейк\w*|почтов\w* ящик\w*|сигнализац\w*|'
    r'исходн\w*|репозитор\w*|github|gitlab|коммит\w*|функци\w*|скрипт\w*|программ\w*|проект\w*|ревью|review|'
    r'промокод\w*|promo|скидк\w*|купон\w*|трек\w*|отслеживан\w*|индекс\w*|zip|'
    r'код\w* ошибк\w*|error code|код\w* товар\w*|артикул\w*|код\w* региона|код\w* страны|area code',
    re.I,
)
# In strict mode a message that says what the digits are ("код", "пароль из смс").
_PRESENTED_AS_CODE_RE = re.compile(
    r'код\w*|парол\w*|pin\b|пин\b|пин-?код\w*|cvv|cvc|otp|code|passcode|password|смс|sms', re.I,
)


def code_digits(text: str) -> list[str]:
    """Digit strings of standalone code-like groups in the message."""
    return [re.sub(r'\D', '', m.group(1)) for m in _CODE_RE.finditer(text or '')]


def looks_like_code(text: str, *, allow_three: bool = False) -> bool:
    lo = 3 if allow_three else 4
    return any(lo <= len(d) <= 8 for d in code_digits(text))


def asks_for_code(text: str) -> bool:
    text = text or ''
    if BENIGN_RE.search(text):
        return False
    return any(p.search(text) for p in _REQUEST_PATTERNS)


def is_bare_or_presented_code(content: str) -> bool:
    """Strict mode: the message is the code itself, or it says it is a code."""
    if not looks_like_code(content):
        return False
    if BENIGN_RE.search(content):
        return False
    words = re.sub(r'[\d\s\-.,:;!?()"\'«»]+', ' ', content).split()
    return len(words) <= 1 or bool(_PRESENTED_AS_CODE_RE.search(content))


def block_all_codes() -> bool:
    from .models import ChatSafetySettings
    return ChatSafetySettings.objects.filter(pk=1, block_all_codes=True).exists()


def should_block(conversation, author, content: str) -> bool:
    """True if `content` from `author` must not be delivered to `conversation`."""
    if not content or not looks_like_code(content, allow_three=True):
        return False
    if block_all_codes() and is_bare_or_presented_code(content):
        return True
    from .models import Message

    since = timezone.now() - RECENT_WINDOW
    recent = (
        Message.objects.filter(conversation=conversation, created_at__gte=since)
        .exclude(author=author)
        .order_by('-created_at')[:RECENT_LIMIT]
    )
    for msg in recent:
        try:
            text = msg.content
        except Exception:  # noqa: BLE001 — undecryptable history must not break sending
            continue
        if asks_for_code(text):
            return looks_like_code(content, allow_three=bool(_CVV_RE.search(text)))
    return False
