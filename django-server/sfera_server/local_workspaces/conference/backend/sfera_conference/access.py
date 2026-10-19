"""Who may enter a conference, guest passes and media-server tokens."""
import base64
import os
import time
import uuid

import jwt
from django.core import signing

from .models import KIND_EXTERNAL, KIND_INTERNAL, KIND_PRIVATE, Conference, MediaSettings

GUEST_SALT = 'sfera-conference-guest'
GUEST_MAX_AGE = 12 * 60 * 60
NAME_MAX = 64


def clean_name(raw) -> str:
    name = ' '.join(str(raw or '').split())[:NAME_MAX]
    return name


def user_can_join(user, conf: Conference) -> bool:
    if not user or not user.is_authenticated or not conf.active:
        return False
    if conf.owner_id == user.id or conf.kind in (KIND_INTERNAL, KIND_EXTERNAL):
        return True
    return conf.kind == KIND_PRIVATE and conf.invited.filter(id=user.id).exists()


def is_host(user, conf: Conference) -> bool:
    return bool(user and user.is_authenticated and conf.owner_id == user.id)


# Guest passes travel in a WebSocket subprotocol, so they must be plain token
# characters: the signed value is base64url-encoded without padding.

def issue_guest_pass(conf: Conference, name: str) -> tuple[str, str]:
    guest_id = f'g-{uuid.uuid4().hex[:16]}'
    signed = signing.dumps({'c': str(conf.id), 'g': guest_id, 'n': name}, salt=GUEST_SALT, compress=True)
    return base64.urlsafe_b64encode(signed.encode()).decode().rstrip('='), guest_id


def read_guest_pass(token: str, conf: Conference) -> dict | None:
    if not token or len(token) > 1000:
        return None
    try:
        signed = base64.urlsafe_b64decode(token + '=' * (-len(token) % 4)).decode()
        data = signing.loads(signed, salt=GUEST_SALT, max_age=GUEST_MAX_AGE)
    except (signing.BadSignature, ValueError, UnicodeDecodeError):
        return None
    if data.get('c') != str(conf.id) or conf.kind != KIND_EXTERNAL or not conf.active:
        return None
    return {'guest_id': data['g'], 'name': clean_name(data.get('n')) or 'Guest'}


# ── Media server ─────────────────────────────────────────────────────────────

def media_config() -> dict | None:
    """LiveKit settings from the environment, or the ones saved by the superuser."""
    url = os.environ.get('LIVEKIT_URL', '')
    key = os.environ.get('LIVEKIT_API_KEY', '')
    secret = os.environ.get('LIVEKIT_API_SECRET', '')
    if not (url and key and secret):
        s = MediaSettings.load()
        url, key, secret = s.livekit_url, s.livekit_api_key, s.api_secret
    if url and key and secret:
        return {'url': url, 'key': key, 'secret': secret}
    return None


def livekit_token(cfg: dict, room: str, identity: str, name: str, host: bool, ttl: int = 6 * 60 * 60) -> str:
    now = int(time.time())
    claims = {
        'iss': cfg['key'],
        'sub': identity,
        'name': name,
        'nbf': now - 10,
        'exp': now + ttl,
        'video': {
            'room': room,
            'roomJoin': True,
            'canPublish': True,
            'canSubscribe': True,
            'canPublishData': True,
            'roomAdmin': host,
        },
        'metadata': '{"host": true}' if host else '{}',
    }
    return jwt.encode(claims, cfg['secret'], algorithm='HS256')
