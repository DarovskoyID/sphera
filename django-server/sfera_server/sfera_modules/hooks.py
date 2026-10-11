"""Extension points the core exposes to modules.

The core never imports a module. Instead it emits signals and asks registries;
modules connect in their ``AppConfig.ready()``.
"""
from collections import defaultdict
from typing import Callable

from django.dispatch import Signal

# ── Signals ────────────────────────────────────────────────────────────────
# kwargs: kind ('dm' | 'channel'), message
message_created = Signal()
# kwargs: user, peer_id — a DM with peer_id was opened/created
conversation_opened = Signal()
# kwargs: blocker, blocked
user_blocked = Signal()
user_unblocked = Signal()
# kwargs: user, target
friend_request_sent = Signal()
# kwargs: user, module_id
module_installed = Signal()
module_uninstalled = Signal()
# kwargs: user
user_logged_out = Signal()

# ── Registries ─────────────────────────────────────────────────────────────
# Each registry maps a module id to a callable; the core calls all of them and
# merges results. A failing provider is logged and skipped, never breaks core.
_registries: dict[str, dict[str, Callable]] = defaultdict(dict)

PROFILE_EXTRAS = 'profile_extras'          # fn(viewer, target) -> dict merged into profile
DATA_EXPORT = 'data_export'                # fn(user) -> dict[str, list] (file name -> rows)
METRICS = 'metrics'                        # fn() -> dict[str, number]
HAS_DATA = 'has_data'                      # fn(user) -> bool, used for auto-install
WS_AUTHORIZE = 'ws_authorize'              # fn(user, ws_type, data) -> True | False | None (not mine)
KAFKA_HANDLERS = 'kafka_handlers'          # fn() -> {topic: handler(data)} for kafka_worker
ENCRYPTED_DATA = 'encrypted_data'          # fn() -> [(Model, [text fields], [file fields])] for key rotation
IS_MANAGED = 'is_managed'                  # fn(user) -> bool: account under parental control
CAN_UNINSTALL = 'can_uninstall'            # fn(user) -> str | None: reason the module must stay
# Sign-in needs a second step (e.g. a one-time code): fn(user, request) -> dict | None.
# The dict is returned to the client as-is, with the challenge the module expects back.
LOGIN_GUARD = 'login_guard'
# Finishes such a sign-in: fn(challenge, code, request) -> user | None.
SECOND_FACTOR = 'second_factor'
# A signed-in account may not use the app yet: fn(user_id) -> dict | None.
# The dict is the 403 body; its 'allow' lists path prefixes that stay reachable,
# so the account can fix whatever blocks it (and sign out).
ACCESS_GUARD = 'access_guard'

# ── Services ───────────────────────────────────────────────────────────────
# Optional capabilities one module offers another (e.g. servers → family chat).
# Callers must handle absence: `svc = hooks.service('servers.private_guild')`.
_services: dict[str, object] = {}


def provide(name: str, impl) -> None:
    _services[name] = impl


def service(name: str):
    return _services.get(name)


def register(registry: str, module_id: str, fn: Callable) -> None:
    _registries[registry][module_id] = fn


def providers(registry: str) -> dict[str, Callable]:
    return dict(_registries[registry])


def collect(registry: str, *args, only: set[str] | None = None, **kwargs) -> dict[str, object]:
    import logging

    out = {}
    for module_id, fn in _registries[registry].items():
        if only is not None and module_id not in only:
            continue
        try:
            out[module_id] = fn(*args, **kwargs)
        except Exception:  # noqa: BLE001 — a module must not break the core
            logging.getLogger('sfera.modules').exception('hook %s of %s failed', registry, module_id)
    return out


def login_block(user, request=None) -> dict | None:
    """Does a module want a second step before this sign-in hands out tokens?"""
    for answer in collect(LOGIN_GUARD, user, request).values():
        if answer:
            return answer
    return None


def second_factor_user(challenge: str, code: str, request=None):
    """The account a (challenge, code) pair proves, or None if nothing accepts it."""
    for answer in collect(SECOND_FACTOR, challenge, code, request).values():
        if answer:
            return answer
    return None


def access_block(user_id) -> dict | None:
    """Is this signed-in account kept out of the app by a module?

    Called on every API request and on every socket, so a guard must be cheap:
    modules are expected to cache their own answer.
    """
    if not _registries.get(ACCESS_GUARD):
        return None
    for answer in collect(ACCESS_GUARD, user_id).values():
        if answer:
            return answer
    return None


def push_to_user(user_id, event_type: str, payload: dict | None = None) -> None:
    """Deliver an event to all signaling sockets of a user.

    Arrives in the client as ``{type: 'module_event', event: event_type, ...payload}``
    and is dispatched through the frontend wsBus.
    """
    from asgiref.sync import async_to_sync
    from channels.layers import get_channel_layer

    layer = get_channel_layer()
    if layer is None:
        return
    async_to_sync(layer.group_send)(
        f'user_{user_id}',
        {'type': 'module_event', 'event': event_type, 'payload': payload or {}},
    )


def approx_count(model, exact_below: int = 50_000) -> int:
    """Row count for dashboards: cheap on large tables, exact on small ones.

    ``COUNT(*)`` on a multi-million-row table is a full scan and /metrics is
    scraped every 15 s, so on PostgreSQL the planner's estimate is used once a
    table grows past ``exact_below``; SQLite always counts.
    """
    from django.db import connection

    table = model._meta.db_table
    if connection.vendor != 'postgresql':
        return model.objects.count()
    try:
        with connection.cursor() as cur:
            cur.execute('SELECT reltuples::bigint FROM pg_class WHERE oid = to_regclass(%s)', [table])
            row = cur.fetchone()
        estimate = int(row[0]) if row and row[0] is not None else -1
    except Exception:
        estimate = -1
    if 0 <= estimate < exact_below:
        return model.objects.count()
    return max(estimate, 0)
