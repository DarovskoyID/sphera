"""Owner-authorized device history for the laboratory; no sessions or E2EE keys.

The owner public key is independently pinned, not learned from an event.
Whole-database rollback needs an external checkpoint. A device must not receive
the owner root: possession of it allows authorizing a new identity after revoke.
"""
import json
import re
import sqlite3
import threading
from hashlib import sha256

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .directory import digest64, user_id, ZERO
from .storage import canonical

DOMAIN = 'sfera-mesh-device-event-lab-v1'
MAX_EVENTS = 256
MAX_DEVICES = 64


def device_id(public):
    return sha256(b'sfera-mesh-device-v1\0' + public).hexdigest()


def verify_event(event, network, owner_public, *, expected_owner=None):
    if not isinstance(event, dict) or set(event) != {'body', 'owner_signature', 'device_signature'}:
        raise ValueError('invalid_device_event')
    body = event['body']
    fields = {'domain', 'network', 'user_id', 'version', 'previous', 'operation', 'device_id', 'device_public'}
    if not isinstance(body, dict) or set(body) != fields or len(canonical(event)) > 2048:
        raise ValueError('invalid_device_body')
    if (body['domain'] != DOMAIN or body['network'] != network or
            body['user_id'] != (expected_owner if expected_owner is not None else user_id(bytes.fromhex(owner_public)))):
        raise ValueError('device_context_mismatch')
    if (type(body['version']) is not int or not 1 <= body['version'] <= MAX_EVENTS or
            body['operation'] not in ('enroll', 'revoke') or
            not all(digest64(body[name]) for name in ('previous', 'device_id', 'device_public'))):
        raise ValueError('invalid_device_fields')
    public = bytes.fromhex(body['device_public'])
    if body['device_public'] == owner_public or device_id(public) != body['device_id']:
        raise ValueError('device_key_mismatch')
    try:
        signature = event['owner_signature']
        if not isinstance(signature, str) or not re.fullmatch('[0-9a-f]{128}', signature):
            raise ValueError('invalid_owner_signature')
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(owner_public)).verify(bytes.fromhex(signature), canonical(body))
        if body['operation'] == 'enroll':
            signature = event['device_signature']
            if not isinstance(signature, str) or not re.fullmatch('[0-9a-f]{128}', signature):
                raise ValueError('invalid_device_signature')
            Ed25519PublicKey.from_public_bytes(public).verify(bytes.fromhex(signature), canonical(body))
        elif event['device_signature'] != '':
            raise ValueError('unexpected_device_signature')
    except (InvalidSignature, TypeError, ValueError) as exc:
        raise ValueError('invalid_device_signature') from exc
    return body, sha256(canonical(event)).hexdigest()


def validate_device_state(state, network):
    histories = state.get('devices', {})
    if not isinstance(histories, dict) or len(histories) > 512:
        raise ValueError('invalid_device_state')
    total, active, summaries = 0, 0, {}
    for owner, heads in histories.items():
        if owner not in state['accounts'] or not isinstance(heads, list) or not 1 <= len(heads) <= MAX_EVENTS:
            raise ValueError('invalid_device_owner_history')
        public = state['accounts'][owner]['record']['body']['public_key']
        previous, devices = ZERO, {}
        for version, head in enumerate(heads, 1):
            if not isinstance(head, dict) or set(head) != {'event', 'digest'}:
                raise ValueError('invalid_device_head')
            from .account_controls import controller_public
            signer = controller_public(state, owner, version, devices=True)
            body, digest = verify_event(head['event'], network, signer, expected_owner=owner)
            if body['user_id'] != owner or body['version'] != version or body['previous'] != previous or digest != head['digest']:
                raise ValueError('invalid_device_history_chain')
            DeviceRegistry._transition(devices, body)
            previous = digest
            total += 1
            if total > 512:
                raise ValueError('device_state_capacity')
        active += sum(device['active'] for device in devices.values())
        summaries[owner] = {'version': len(heads), 'digest': previous, 'devices': devices}
    if total + active > 512:
        raise ValueError('device_revoke_reserve_missing')
    return summaries


class DeviceRegistry:
    def __init__(self, path, network, owner_public, checkpoint=None):
        if not isinstance(network, str) or not re.fullmatch('[A-Za-z0-9._-]{1,128}', network) or not digest64(owner_public):
            raise ValueError('invalid_device_trust')
        if checkpoint is not None and (not isinstance(checkpoint, tuple) or len(checkpoint) != 2 or
                type(checkpoint[0]) is not int or not 0 <= checkpoint[0] <= MAX_EVENTS or not digest64(checkpoint[1])):
            raise ValueError('invalid_device_checkpoint')
        self.network, self.owner_public = network, owner_public
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        try:
            self.db.execute('PRAGMA synchronous=FULL')
            self.db.executescript('''
                CREATE TABLE IF NOT EXISTS device_trust (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1), network TEXT NOT NULL, owner TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS device_events (
                    version INTEGER PRIMARY KEY, digest TEXT NOT NULL, event BLOB NOT NULL);
            ''')
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                old = self.db.execute('SELECT network, owner FROM device_trust WHERE singleton=1').fetchone()
                if old is not None and old != (network, owner_public):
                    raise ValueError('device_trust_changed')
                self.db.execute('INSERT OR IGNORE INTO device_trust VALUES (1, ?, ?)', (network, owner_public))
                head, _, history = self._replay()
                if checkpoint is not None and history.get(checkpoint[0]) != checkpoint[1]:
                    raise ValueError('device_checkpoint_rollback_or_fork')
        except BaseException:
            self.db.close()
            raise

    def close(self):
        self.db.close()

    def _replay(self):
        rows = self.db.execute('SELECT version,digest,event FROM device_events ORDER BY version LIMIT ?', (MAX_EVENTS + 1,)).fetchall()
        if len(rows) > MAX_EVENTS:
            raise ValueError('device_history_limit')
        version, digest, devices, history = 0, ZERO, {}, {0: ZERO}
        for number, stored_digest, raw in rows:
            if len(raw) > 2048:
                raise ValueError('device_event_size')
            body, checked = verify_event(json.loads(raw), self.network, self.owner_public)
            if number != version + 1 or body['version'] != number or body['previous'] != digest or checked != stored_digest:
                raise ValueError('device_history_corrupt')
            self._transition(devices, body)
            version, digest = number, checked
            history[number] = checked
        return (version, digest), devices, history

    @staticmethod
    def _transition(devices, body):
        identity = body['device_id']
        if body['operation'] == 'enroll':
            if identity in devices or len(devices) >= MAX_DEVICES:
                raise ValueError('device_already_seen_or_limit')
            devices[identity] = {'public_key': body['device_public'], 'active': True}
        else:
            if identity not in devices or not devices[identity]['active']:
                raise ValueError('device_not_active')
            devices[identity]['active'] = False

    def apply(self, event):
        return self.apply_batch([event])

    def apply_batch(self, events):
        """Up to two events atomically: revoke old + enroll replacement, for example."""
        if not isinstance(events, list) or not 1 <= len(events) <= 2:
            raise ValueError('invalid_device_batch')
        # Freeze caller-owned objects before validation/transaction.
        frozen = json.loads(canonical(events))
        checked = [verify_event(event, self.network, self.owner_public) for event in frozen]
        with self.lock, self.db:
            self.db.execute('BEGIN IMMEDIATE')
            (version, digest), devices, history = self._replay()
            for event, (body, event_hash) in zip(frozen, checked):
                number = body['version']
                if number in history:
                    if history[number] != event_hash:
                        raise ValueError('device_version_conflict')
                    continue  # Exact old retries never undo revocation.
                if number != version + 1 or body['previous'] != digest:
                    raise ValueError('device_chain_gap_or_fork')
                self._transition(devices, body)
                self.db.execute('INSERT INTO device_events VALUES (?, ?, ?)', (number, event_hash, canonical(event)))
                version, digest = number, event_hash
                history[number] = event_hash
            return {'version': version, 'digest': digest, 'confirmed_by_consensus': False}

    def snapshot(self):
        with self.lock, self.db:
            self.db.execute('BEGIN')
            head, devices, _ = self._replay()
            events = [json.loads(row[0]) for row in self.db.execute('SELECT event FROM device_events ORDER BY version')]
            return {'version': head[0], 'digest': head[1], 'devices': devices, 'events': events,
                    'confirmed_by_consensus': False}

    def require_active(self, identity, expected_head):
        """No network auth implied. Caller must know the current authoritative head."""
        snapshot = self.snapshot()
        if expected_head != (snapshot['version'], snapshot['digest']):
            raise ValueError('stale_device_head')
        device = snapshot['devices'].get(identity)
        if device is None or not device['active']:
            raise ValueError('device_not_active')
        return device['public_key']
