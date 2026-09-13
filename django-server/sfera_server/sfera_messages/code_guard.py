"""Stops a user from sending a one-time code (SMS / verification / bank code)
into a chat where the other side has just asked for it — the classic "продиктуйте
код из СМС" scam.

A message is blocked when both hold:
  1. it looks like a code: a standalone group of 4–8 digits ("4821", "482 913",
     "48-29-13"), or 3 digits when the request was for a CVV/CVC;
  2. one of the other participants' recent messages (last RECENT_LIMIT within
     RECENT_WINDOW) asks for a code.

The Rust ws-gateway pre-filters with a cheap digit scan and asks Django
(ws_authorize type "chat_send_check") only for code-like messages.
"""
import re
from datetime import timedelta

from django.utils import timezone

RECENT_WINDOW = timedelta(minutes=30)
RECENT_LIMIT = 10

# A digit group that is not glued to other digits, letters, or decimal/amount
# punctuation. Separators inside the group: single space or dash.
_CODE_RE = re.compile(r'(?<![\w.,:/+])(?<!\d[ \-])(\d(?:[ \-]?\d)*)(?![\w.,:/%₽$€])')

_SUBJECT = (
    r'(?:код\w*|пароль\w*|парол[ьяе]|цифр\w*|sms|смс|эсэмэс\w*|пуш\w*|push|otp|'
    r'code|passcode|pin|пин|cvv|cvc|cvv2|cvc2)'
)
_ASK_VERB = (
    r'(?:скаж\w*|продикту\w*|диктуй\w*|назов\w*|назови\w*|пришл\w*|присла\w*|скин\w*|скидыва\w*|'
    r'отправ\w*|напиш\w*|написа\w*|сообщ\w*|переш\w*|пересла\w*|кин\w*|дай\w*|давай\w*|подскаж\w*|'
    r'send|tell|give|share|forward|read|text|type)'
)
_REQUEST_PATTERNS = [
    # "скажите код", "пришли цифры", "send me the code"
    re.compile(_ASK_VERB + r'(?:\W+\w+){0,4}?\W+' + _SUBJECT, re.I),
    # "код из смс", "код подтверждения", "код от госуслуг", "verification code"
    re.compile(r'код\w*\W+(?:\w+\W+){0,2}?(?:из|с|со|от|в|по)\W+(?:\w+\W+){0,1}?(?:смс|sms|сообщени\w*|пуш\w*|'
               r'госуслуг\w*|банк\w*|приложени\w*|телефон\w*|номер\w*|карт\w*|почт\w*|звонк\w*)', re.I),
    re.compile(r'код\w*\W+(?:подтвержд\w*|верификац\w*|активац\w*|доступ\w*|авториз\w*|входа|безопасност\w*)', re.I),
    re.compile(r'(?:verification|confirmation|security|one[- ]time|login|sms|2fa|otp)\W+code', re.I),
    # "какой код пришёл?", "какие цифры в смс"
    re.compile(r'(?:как\w+|что\w*)\W+(?:\w+\W+){0,2}?' + _SUBJECT + r'(?:\W+\w+){0,3}?\W+(?:приш\w*|приход\w*|приш[её]л)', re.I),
    re.compile(_SUBJECT + r'\W+(?:\w+\W+){0,2}?(?:приш[её]л|пришли|придёт|придет|должен прийти|came|arrived)', re.I),
    re.compile(r'(?:трёхзначн|трехзначн|обратной сторон\w*|back of (?:the|your) card)', re.I),
]
_CVV_RE = re.compile(r'cvv|cvc|трёхзначн|трехзначн|обратной сторон|back of (?:the|your) card', re.I)


def code_digits(text: str) -> list[str]:
    """Digit strings of standalone code-like groups in the message."""
    return [re.sub(r'\D', '', m.group(1)) for m in _CODE_RE.finditer(text or '')]


def looks_like_code(text: str, *, allow_three: bool = False) -> bool:
    lo = 3 if allow_three else 4
    return any(lo <= len(d) <= 8 for d in code_digits(text))


def asks_for_code(text: str) -> bool:
    return any(p.search(text or '') for p in _REQUEST_PATTERNS)


def should_block(conversation, author, content: str) -> bool:
    """True if `content` from `author` is a code that was just requested in `conversation`."""
    if not content or not looks_like_code(content, allow_three=True):
        return False
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


BLOCKED_ERROR = 'code_blocked'
