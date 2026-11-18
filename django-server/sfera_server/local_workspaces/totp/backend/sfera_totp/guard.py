"""Where the module answers the core: sign-in, the second step, and the gate.

Everything here runs inside core code paths — the login view, the API
middleware, the WebSocket authentication — so the rules hold for requests the
app never makes. Hiding the blocking screen in the browser, or calling the API
by hand, changes nothing: the account is refused before any view runs.
"""
from django.core.cache import cache
from django.core.signing import BadSignature, SignatureExpired, TimestampSigner
from django.utils import timezone

from .models import BackupCode, TotpDevice, TotpSettings
from . import totp

CHALLENGE_SALT = 'sfera_totp.challenge'
CHALLENGE_TTL = 300
# A six-digit code is guessable if you may try forever.
MAX_ATTEMPTS = 10
ATTEMPT_WINDOW = 300
SETTINGS_TTL = 30
GATE_TTL = 15

ALLOW = ('/api/totp/',)


def settings_row():
    """The switch, re-read at most every SETTINGS_TTL seconds."""
    cached = cache.get('totp:settings')
    if cached is None:
        row = TotpSettings.load()
        cached = {'required_for_all': row.required_for_all, 'issuer': row.issuer}
        cache.set('totp:settings', cached, SETTINGS_TTL)
    return cached


def forget_settings():
    cache.delete('totp:settings')


def forget_user(user_id):
    cache.delete(f'totp:gate:{user_id}')


def has_device(user_id) -> bool:
    return TotpDevice.objects.filter(user_id=user_id, confirmed_at__isnull=False).exists()


# ── Hooks the core calls ───────────────────────────────────────────────────
def access_guard(user_id):
    """Keeps an account out of the app until it has an authenticator.

    Answers from a short-lived cache: this runs on every API request and every
    socket, and must not turn into a query per request.
    """
    if not settings_row()['required_for_all']:
        return None
    key = f'totp:gate:{user_id}'
    blocked = cache.get(key)
    if blocked is None:
        blocked = not has_device(user_id)
        cache.set(key, blocked, GATE_TTL)
    if not blocked:
        return None
    return {
        'error': 'totp_required',
        'detail': 'Администратор включил обязательную двухфакторную аутентификацию. '
                  'Подключите приложение-аутентификатор, чтобы продолжить работу.',
        'allow': ALLOW,
    }


def login_guard(user, request=None):
    """A sign-in by password alone is not finished when the account has TOTP."""
    if not has_device(user.id):
        # Required but not set up yet: let the password in, and the access guard
        # above holds the account on the set-up screen. Otherwise nobody could
        # ever enrol after the switch is turned on.
        return None
    return {
        'error': 'second_factor_required',
        'method': 'totp',
        'challenge': issue_challenge(user.id),
        'backup_codes': BackupCode.objects.filter(user_id=user.id, used_at__isnull=True).exists(),
        'detail': 'Введите код из приложения-аутентификатора.',
    }


def second_factor(challenge, code, request=None):
    """Turns a (challenge, code) pair back into the account that started the sign-in."""
    user_id = read_challenge(challenge)
    if not user_id:
        return None
    if not spend_attempt(user_id):
        return None
    device = TotpDevice.objects.filter(user_id=user_id, confirmed_at__isnull=False).select_related('user').first()
    if not device:
        return None
    if check_code(device, code):
        cache.delete(f'totp:attempts:{user_id}')
        _inc('totp_logins')
        return device.user
    if spend_backup_code(user_id, code):
        cache.delete(f'totp:attempts:{user_id}')
        _inc('totp_backup_logins')
        return device.user
    _inc('totp_failures')
    return None


def _inc(name, by=1):
    try:
        from sfera_server.metrics import inc

        inc(name, by)
    except Exception:
        pass


# ── Pieces the views share ─────────────────────────────────────────────────
def issue_challenge(user_id) -> str:
    return TimestampSigner(salt=CHALLENGE_SALT).sign(str(user_id))


def read_challenge(challenge: str):
    try:
        return TimestampSigner(salt=CHALLENGE_SALT).unsign(str(challenge), max_age=CHALLENGE_TTL)
    except (BadSignature, SignatureExpired, TypeError):
        return None


def spend_attempt(user_id) -> bool:
    """False once this account has guessed too often in ATTEMPT_WINDOW."""
    key = f'totp:attempts:{user_id}'
    try:
        tries = cache.get_or_set(key, 0, ATTEMPT_WINDOW)
        tries = cache.incr(key)
    except ValueError:
        cache.set(key, 1, ATTEMPT_WINDOW)
        tries = 1
    return tries <= MAX_ATTEMPTS


def check_code(device: TotpDevice, code: str) -> bool:
    """A correct, not-yet-spent code; marks the step as used."""
    counter = totp.verify(device.secret, code, device.last_counter)
    if counter is None:
        return False
    device.last_counter = counter
    device.last_used_at = timezone.now()
    device.save(update_fields=['last_counter', 'last_used_at'])
    return True


def spend_backup_code(user_id, code: str) -> bool:
    code_hash = totp.hash_backup(code)
    updated = BackupCode.objects.filter(
        user_id=user_id, code_hash=code_hash, used_at__isnull=True,
    ).update(used_at=timezone.now())
    return bool(updated)
