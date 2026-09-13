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
WS_AUTHORIZE = 'ws_authorize'              # fn(user, room: str) -> bool, for ws-gateway
IS_MANAGED = 'is_managed'                  # fn(user) -> bool: account under parental control
CAN_UNINSTALL = 'can_uninstall'            # fn(user) -> str | None: reason the module must stay

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
