"""Opt-in mesh bindings for existing JWT sessions; no alternate login bypass."""
import atexit
import os
from pathlib import Path
import sqlite3
import subprocess
import threading
import time

from django.conf import settings
from rest_framework.exceptions import APIException, AuthenticationFailed
from rest_framework_simplejwt.authentication import JWTAuthentication

from sfera_mesh.application_sessions import ApplicationSessions
from sfera_mesh.consensus_directory import ConsensusDirectory, ConsensusUnavailable, validate_address

CLAIM = 'mesh_session'
_runtime = None
_lock = threading.RLock()


class MeshUnavailable(APIException):
    status_code = 503
    default_detail = 'mesh consensus is unavailable'
    default_code = 'mesh_unavailable'


class Runtime:
    def __init__(self, config):
        if not isinstance(config, dict) or set(config) - {'identity'} != {'state', 'sessions', 'verifier', 'genesis', 'entry', 'rpc'}:
            raise ValueError('invalid_application_mesh_configuration')
        validate_address(config['rpc'])
        paths = [os.path.normcase(str(Path(config[key]).resolve())) for key in ('state', 'sessions', 'verifier', 'genesis')]
        if len(set(paths)) != len(paths) or any(config[key] == ':memory:' for key in ('state', 'sessions')):
            raise ValueError('application_mesh_paths_must_be_separate_and_durable')
        entry_key = None
        if 'identity' in config:
            from sfera_mesh.identity import load_identity
            if (not isinstance(config['identity'], str) or not Path(config['identity']).is_absolute() or
                    os.path.normcase(str(Path(config['identity']).resolve())) in paths):
                raise ValueError('separate_absolute_application_identity_required')
            entry_key = load_identity(config['identity'])
        self.directory = ConsensusDirectory(config['state'], config['verifier'], config['genesis'])
        try:
            self.sessions = ApplicationSessions(config['sessions'], self.directory, config['entry'], entry_key=entry_key)
            self.sessions.require_consensus_cipher_pins = getattr(settings, 'SFERA_MESH_GLOBAL_CIPHER_PINS', False)
            self.sessions.require_cipher_profile_guard = getattr(settings, 'SFERA_MESH_CIPHER_PROFILE_GUARD', False)
        except BaseException:
            self.directory.close()
            raise
        self.address, self.updated, self.lock = config['rpc'], 0, threading.RLock()
        atexit.register(self.close)

    def fresh(self):
        with self.lock:
            if time.monotonic() - self.updated >= 2:
                self.directory.refresh(self.address)
                self.updated = time.monotonic()
            self.directory.anchor()
        return self.sessions

    def close(self):
        with self.lock:
            if not self.directory.closed:
                self.sessions.close()
                self.directory.close()


def sessions(*, fresh=True):
    global _runtime
    config = getattr(settings, 'SFERA_MESH_SESSIONS', None)
    if not config:
        raise MeshUnavailable('mesh sessions are not configured')
    try:
        with _lock:
            if _runtime is None:
                _runtime = Runtime(config)
            return _runtime.fresh() if fresh else _runtime.sessions
    except APIException:
        raise
    except (OSError, ValueError, TimeoutError, subprocess.SubprocessError, sqlite3.Error) as exc:
        raise MeshUnavailable() from exc


def require_token(token, user):
    if CLAIM not in token:
        return
    from .models import User
    from . import bans
    from sfera_modules import hooks
    if not User.objects.filter(pk=user, is_active=True).exists() or bans.is_banned(user) or hooks.access_block(user):
        raise AuthenticationFailed('application account access is blocked')
    backend = sessions()
    try:
        backend.require(str(user), token[CLAIM])
    except ConsensusUnavailable as exc:
        raise MeshUnavailable() from exc
    except ValueError as exc:
        raise AuthenticationFailed('mesh device session is no longer active') from exc


class MeshJWTAuthentication(JWTAuthentication):
    def get_user(self, validated_token):
        user = super().get_user(validated_token)
        require_token(validated_token, user.pk)
        return user


def submit_account_record(record):
    """Broadcast an already validated record to the configured consensus RPC."""
    import base64
    import json
    import urllib.request
    from sfera_mesh.storage import canonical
    sessions()  # Initializes and checks the pinned runtime before broadcast.
    with _lock:
        address = _runtime.address
    validate_address(address)
    payload = {'jsonrpc': '2.0', 'id': 'account-update', 'method': 'broadcast_tx_sync',
        'params': {'tx': base64.b64encode(canonical(record)).decode('ascii')}}
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(address, data=canonical(payload), headers={'Content-Type': 'application/json'})
    with opener.open(request, timeout=5) as response:
        raw = response.read(16385)
    if len(raw) > 16384:
        raise ValueError('account_broadcast_response_too_large')
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise ValueError('account_broadcast_rejected')
    # A byte-identical retry may still be in CometBFT's transaction cache.
    # This is pending, never a commit acknowledgement.
    if (result.get('id') == 'account-update' and isinstance(result.get('error'), dict)
            and result['error'].get('code') == -32603
            and result['error'].get('data') == 'tx already exists in cache'):
        return
    if result.get('id') != 'account-update' or 'error' in result or type(result.get('result', {}).get('code')) is not int or result['result']['code'] != 0:
        raise ValueError('account_broadcast_rejected')
