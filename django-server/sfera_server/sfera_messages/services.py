"""Public messaging services shared by the core and modules.

Modules import from here, never from sfera_messages.views."""
import json
import os
import shlex
import subprocess
import tempfile
import uuid

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings

MAX_UPLOAD_SIZE = 50 * 1024 * 1024  # 50 MB
MAX_ATTACHMENTS_PER_MESSAGE = 15

_gw_redis_conn = None


def _gw_broadcast(channel, message):
    """Publish a client-ready payload to the plain Redis channel the Rust
    ws-gateway subscribes to (guild_channel_*, chat_*, user_*).

    Real chat/guild-channel WebSocket clients connect to the Rust ws-gateway,
    which fans out via plain Redis pub/sub. Django's channels_redis group_send
    uses a different key scheme and does NOT reach those clients, so every
    HTTP-triggered realtime event (posts, comments, reactions, deletes) must be
    bridged here as well. Payload must be exactly what the client expects."""
    global _gw_redis_conn
    try:
        if _gw_redis_conn is None:
            import redis as _redis
            _gw_redis_conn = _redis.Redis.from_url(
                os.environ.get('REDIS_URL', 'redis://127.0.0.1:6379/0'),
                socket_connect_timeout=1, socket_timeout=1,
            )
        _gw_redis_conn.publish(channel, json.dumps(message))
    except Exception:
        _gw_redis_conn = None


# Realtime fanout is best-effort and must NOT block the HTTP request: the channel
# layer group_send does a Redis round-trip and, under ASGI, sync views serialize
# on one thread, so doing it inline caps write throughput. We offload it to a
# small background pool and return immediately.
from concurrent.futures import ThreadPoolExecutor as _ThreadPoolExecutor
_FANOUT_POOL = _ThreadPoolExecutor(max_workers=4, thread_name_prefix='fanout')


def _do_fanout(group, channel_event, gw_payload):
    try:
        async_to_sync(get_channel_layer().group_send)(group, channel_event)
    except Exception:
        pass
    if gw_payload is not None:
        _gw_broadcast(group, gw_payload)


def _fanout(group, channel_event, gw_payload):
    """Fire-and-forget realtime fanout (channel layer + gateway) off the request
    thread. channel_event is the wrapped event the Channels consumer expects;
    gw_payload is the raw payload the Rust gateway clients expect (pass None to
    skip the gateway leg)."""
    try:
        _FANOUT_POOL.submit(_do_fanout, group, channel_event, gw_payload)
    except Exception:
        _do_fanout(group, channel_event, gw_payload)


def emit_message_created(kind, message):
    """Synchronously emit ``hooks.message_created`` (kind: 'dm' | 'channel').
    Receivers (bots, …) are modules; a failing receiver never breaks delivery."""
    import logging
    from sfera_modules import hooks

    for receiver, result in hooks.message_created.send_robust(sender=None, kind=kind, message=message):
        if isinstance(result, Exception):
            logging.getLogger('sfera.modules').warning('message_created receiver %s failed: %s', receiver, result)


def notify_message_created(kind, message):
    """Fire-and-forget ``emit_message_created`` off the request thread."""
    try:
        _FANOUT_POOL.submit(emit_message_created, kind, message)
    except Exception:
        emit_message_created(kind, message)


def _fanout_user_notifs(user_ids, notification):
    """Fire-and-forget per-user notification fanout (a Redis round-trip each),
    off the request thread."""
    def _run():
        cl = get_channel_layer()
        for uid in user_ids:
            try:
                async_to_sync(cl.group_send)(
                    f'user_{uid}', {'type': 'new.message.notification', 'data': notification}
                )
            except Exception:
                pass
    if not user_ids:
        return
    try:
        _FANOUT_POOL.submit(_run)
    except Exception:
        _run()


BLOCKED_UPLOAD_TYPES = {
    'application/javascript',
    'application/x-javascript',
    'image/svg+xml',
    'text/html',
    'text/javascript',
}
BLOCKED_UPLOAD_EXTENSIONS = {
    '.bat', '.cmd', '.com', '.exe', '.hta', '.html', '.js', '.jse',
    '.msi', '.ps1', '.scr', '.svg', '.vbs', '.wsf',
}


def _id_list(value):
    if value in (None, ''):
        return []
    if isinstance(value, (str, int)):
        value = [value]
    if not isinstance(value, list) or len(value) > MAX_ATTACHMENTS_PER_MESSAGE:
        raise ValueError('invalid attachment list')
    result = []
    for item in value:
        try:
            result.append(uuid.UUID(str(item)))
        except (TypeError, ValueError) as exc:
            raise ValueError('invalid attachment id') from exc
    return result


def _safe_upload(uploaded):
    content_type = (uploaded.content_type or 'application/octet-stream').split(';', 1)[0].lower()
    if content_type in BLOCKED_UPLOAD_TYPES:
        return False, content_type
    ext = os.path.splitext(uploaded.name or '')[1].lower()
    if ext in BLOCKED_UPLOAD_EXTENSIONS:
        return False, content_type
    return True, content_type


def _scan_upload(raw):
    command = getattr(settings, 'UPLOAD_SCAN_COMMAND', '')
    if not command:
        return True
    with tempfile.NamedTemporaryFile(delete=True) as tmp:
        tmp.write(raw)
        tmp.flush()
        argv = shlex.split(command) + [tmp.name]
        return subprocess.run(argv, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0

