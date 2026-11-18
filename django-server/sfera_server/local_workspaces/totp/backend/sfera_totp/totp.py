"""One-time codes compatible with Google Authenticator and friends (RFC 6238).

Six digits from HMAC-SHA1 over a 30-second counter — the algorithm every
authenticator app implements. Written out here rather than taken from a library:
it is thirty lines, and the whole security of the second factor sits in them.
"""
import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote

DIGITS = 6
PERIOD = 30
# Accept the neighbouring steps: phone clocks drift, and people start typing
# a code a moment before it rolls over.
DRIFT_STEPS = 1
SECRET_BYTES = 20
BACKUP_CODES = 10


def new_secret() -> str:
    """A fresh base32 secret, the format authenticator apps expect."""
    return base64.b32encode(secrets.token_bytes(SECRET_BYTES)).decode('ascii').rstrip('=')


def _decode(secret: str) -> bytes:
    padded = secret.strip().replace(' ', '').upper()
    padded += '=' * (-len(padded) % 8)
    return base64.b32decode(padded, casefold=True)


def code_at(secret: str, counter: int) -> str:
    digest = hmac.new(_decode(secret), struct.pack('>Q', counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % (10 ** DIGITS)).zfill(DIGITS)


def counter_now(at: float | None = None) -> int:
    return int((at if at is not None else time.time()) // PERIOD)


def verify(secret: str, code: str, last_counter: int = 0, at: float | None = None) -> int | None:
    """The counter a correct code belongs to, or None.

    ``last_counter`` is the newest counter this account already used: a code is
    accepted once and never again, so watching someone type it (or reading it
    off a screen) buys nothing within its 30 seconds.
    """
    code = ''.join(ch for ch in str(code) if ch.isdigit())
    if len(code) != DIGITS:
        return None
    now = counter_now(at)
    for step in range(-DRIFT_STEPS, DRIFT_STEPS + 1):
        counter = now + step
        if counter <= last_counter:
            continue
        if hmac.compare_digest(code_at(secret, counter), code):
            return counter
    return None


def provisioning_uri(secret: str, account: str, issuer: str) -> str:
    """The otpauth:// link behind the QR code."""
    label = quote(f'{issuer}:{account}', safe='')
    return (
        f'otpauth://totp/{label}?secret={secret}&issuer={quote(issuer, safe="")}'
        f'&algorithm=SHA1&digits={DIGITS}&period={PERIOD}'
    )


def new_backup_codes(count: int = BACKUP_CODES) -> list[str]:
    """Human-readable one-time codes for the day the phone is gone."""
    alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
    out = []
    for _ in range(count):
        raw = ''.join(secrets.choice(alphabet) for _ in range(8))
        out.append(f'{raw[:4]}-{raw[4:]}')
    return out


def hash_backup(code: str) -> str:
    """Backup codes are stored hashed: a dump of the table is not a way in."""
    return hashlib.sha256(normalize_backup(code).encode()).hexdigest()


def normalize_backup(code: str) -> str:
    return ''.join(ch for ch in str(code).upper() if ch.isalnum())
