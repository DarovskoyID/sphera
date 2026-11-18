"""System-wide bans: lookup, request guard helpers and realtime notification.

Enforcement layers (a banned account cannot act through any of them):
  * HTTP — sfera_server.middleware.BanGuardMiddleware answers every API request
    made with a banned user's token with 403 account_banned, before any core or
    module view runs; login answers 403 with the ban details.
  * Django WebSockets — JWTAuthMiddleware refuses to authenticate a banned user
    and drops frames from already-open sockets (core and module consumers).
  * ws-gateway — asks Django to authorize (403), and closes open sockets when
    `ban_<user_id>` is published; the Kafka worker refuses to persist messages
    from banned authors.
"""
import time

_CACHE: dict[str, tuple[float, bool]] = {}
_TTL = 2.0


def is_banned(user_id) -> bool:
    if not user_id:
        return False
    key = str(user_id)
    now = time.monotonic()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < _TTL:
        return hit[1]
    from .models import UserBan
    banned = UserBan.objects.filter(user_id=key).exists()
    _CACHE[key] = (now, banned)
    if len(_CACHE) > 10000:
        _CACHE.clear()
    return banned


def forget(user_id) -> None:
    _CACHE.pop(str(user_id), None)


def ban_info(user_id) -> dict | None:
    from .models import UserBan
    ban = UserBan.objects.filter(user_id=user_id).first()
    if ban is None:
        return None
    return {'error': 'account_banned', 'reason': ban.reason, 'banned_at': ban.created_at.isoformat()}


def user_id_from_bearer(header: str) -> str | None:
    if not header or not header.startswith('Bearer '):
        return None
    try:
        from rest_framework_simplejwt.tokens import AccessToken
        return str(AccessToken(header[7:].strip())['user_id'])
    except Exception:  # noqa: BLE001 — invalid/expired: let normal auth answer
        return None


def notify_banned(user_id) -> None:
    """Push the ban to every live connection of the user, right now."""
    forget(user_id)
    info = ban_info(user_id) or {'error': 'account_banned', 'reason': ''}
    event = {'type': 'account_banned', 'reason': info.get('reason', ''), 'banned_at': info.get('banned_at')}
    try:
        from asgiref.sync import async_to_sync
        from channels.layers import get_channel_layer
        layer = get_channel_layer()
        if layer is not None:
            async_to_sync(layer.group_send)(f'user_{user_id}', {'type': 'account.banned', 'data': event})
    except Exception:  # noqa: BLE001 — best effort, the HTTP guard still applies
        pass
    try:
        from sfera_messages.services import _gw_broadcast
        _gw_broadcast(f'ban_{user_id}', event)
    except Exception:  # noqa: BLE001
        pass


def notify_unbanned(user_id) -> None:
    forget(user_id)
    try:
        from asgiref.sync import async_to_sync
        from channels.layers import get_channel_layer
        layer = get_channel_layer()
        if layer is not None:
            async_to_sync(layer.group_send)(f'user_{user_id}', {'type': 'account.unbanned'})
    except Exception:  # noqa: BLE001
        pass
