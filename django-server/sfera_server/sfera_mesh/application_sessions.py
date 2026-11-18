"""Durable binding of an existing application login to a confirmed mesh device.

Binding requires the application's existing authentication and both owner and
device approval of the exact account/JTI/entry/genesis. Later device login uses
that durable association; its API must enforce the account and second-factor
guards before issuing any credential.
"""
from hashlib import sha256
import json
import re
import secrets
import sqlite3
import threading
import time
import uuid

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .devices import DeviceRegistry, verify_event
from .directory import digest64, ZERO
from .storage import canonical


class ApplicationSessions:
    def __init__(self, path, directory, entry, *, entry_key=None):
        if not digest64(entry):
            raise ValueError('invalid_application_entry')
        self.directory, self.entry = directory, entry
        from .identity import node_id
        if entry_key is not None and node_id(entry_key.public_key().public_bytes_raw()) != entry:
            raise ValueError('application_entry_signing_key_mismatch')
        self.entry_key = entry_key
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS app_session_pin (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pin TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS app_challenges (id TEXT PRIMARY KEY, user TEXT NOT NULL, jti TEXT NOT NULL,
                expires INTEGER NOT NULL, body BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS app_sessions (id TEXT PRIMARY KEY, user TEXT NOT NULL, owner TEXT NOT NULL,
                device TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS app_identities (owner TEXT PRIMARY KEY, user TEXT NOT NULL UNIQUE);
            CREATE TABLE IF NOT EXISTS app_factors (id TEXT PRIMARY KEY, user TEXT NOT NULL, challenge TEXT NOT NULL,
                claim TEXT NOT NULL, expires INTEGER NOT NULL);
        ''')
        try:
            pin = sha256(canonical({'genesis': directory.pin, 'network': directory.network, 'entry': entry})).hexdigest()
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                old = self.db.execute('SELECT pin FROM app_session_pin WHERE singleton=1').fetchone()
                if old is not None and old != (pin,):
                    raise ValueError('application_session_trust_changed')
                self.db.execute('INSERT OR IGNORE INTO app_session_pin VALUES(1,?)', (pin,))
        except BaseException:
            self.db.close()
            raise

    def close(self):
        self.db.close()

    def entry_proof(self, nonce, *, now=None):
        if not digest64(nonce) or self.entry_key is None:
            raise ValueError('signed_application_entry_not_configured')
        now = int(time.time()) if now is None else now
        if type(now) is not int:
            raise ValueError('invalid_application_entry_time')
        self.directory.anchor()
        body = {'domain': 'sfera-mesh-application-entry-v1', 'network': self.directory.network,
            'genesis': self.directory.pin, 'entry': self.entry, 'nonce': nonce,
            'issued_at': now, 'expires_at': now + 15}
        if getattr(self, 'require_cipher_profile_guard', False) or getattr(self.directory, 'current', None) and self.directory.current['state'].get('cipher_profiles'):
            body['profile_guard'] = True
        return {'body': body, 'signature': self.entry_key.sign(canonical(body)).hex()}

    @staticmethod
    def _login(user, jti):
        if str(uuid.UUID(str(user))) != str(user) or not isinstance(jti, str) or not re.fullmatch('[A-Za-z0-9_-]{1,128}', jti):
            raise ValueError('invalid_application_login')

    def _device(self, owner, device):
        if not digest64(owner) or not digest64(device):
            raise ValueError('invalid_application_device')
        history = self.directory.device_history(owner)  # Fresh verified BFT state, never a client supplied history.
        devices, previous = {}, ZERO
        for version, event in enumerate(history['events'], 1):
            from .account_controls import history_signer
            body, digest = verify_event(event, self.directory.network, history_signer(history, version), expected_owner=owner)
            if body['version'] != version or body['previous'] != previous or body['user_id'] != owner:
                raise ValueError('application_device_history_conflict')
            DeviceRegistry._transition(devices, body)
            previous = digest
        if history['version'] != len(history['events']) or history['digest'] != previous:
            raise ValueError('application_device_history_conflict')
        active = devices.get(device)
        if active is None or not active['active']:
            raise ValueError('application_device_revoked')
        return history, active['public_key']

    def challenge(self, user, jti, owner, device, *, now=None, purpose='bind'):
        if purpose not in ('bind', 'login'):
            raise ValueError('invalid_application_purpose')
        self._login(user, jti)
        current = int(time.time() if now is None else now)
        with self.directory.lock, self.lock, self.db:
            history, public = self._device(owner, device)
            self.db.execute('BEGIN IMMEDIATE')
            self.db.execute('DELETE FROM app_challenges WHERE expires<=?', (current,))
            if self.db.execute('SELECT COUNT(*) FROM app_challenges').fetchone()[0] >= 1024:
                raise ValueError('application_challenge_limit')
            if self.db.execute('SELECT COUNT(*) FROM app_challenges WHERE user=?', (user,)).fetchone()[0] >= 4:
                raise ValueError('application_user_challenge_limit')
            body = {'domain': 'sfera-mesh-application-' + purpose + '-v1', 'network': self.directory.network,
                    'genesis': self.directory.pin, 'entry': self.entry, 'application_user': user,
                    'login_jti': jti, 'owner': owner, 'device': device, 'device_public': public,
                    'history_version': history['version'], 'history_hash': history['digest'],
                    'challenge': secrets.token_hex(32), 'issued_at': current,
                    'expires_at': min(current + 60, int(history['finality']['expires_at']))}
            if body['expires_at'] <= current:
                raise ValueError('application_directory_not_fresh')
            self.db.execute('INSERT INTO app_challenges VALUES(?,?,?,?,?)',
                            (body['challenge'], user, jti, body['expires_at'], canonical(body)))
            return body

    def signed_challenge(self, user, jti, owner, device, *, now=None):
        """A portable approval request authenticated by the selected entry."""
        if self.entry_key is None:
            raise ValueError('signed_application_entry_not_configured')
        with self.directory.lock, self.lock:
            existing = self.db.execute('SELECT owner,user FROM app_identities WHERE owner=? OR user=?', (owner,user)).fetchall()
            if existing and existing != [(owner,user)]:
                raise ValueError('application_identity_already_bound')
            challenge = self.challenge(user, jti, owner, device, now=now)
            history, _ = self._device(owner, device)
            body = {'domain': 'sfera-mesh-binding-request-v1', 'challenge': challenge,
                'controller_public': history.get('controller_public', history['owner_public'])}
            return {'body': body, 'signature': self.entry_key.sign(canonical(body)).hex()}

    def complete(self, user, jti, challenge, owner_signature, device_signature, expires, *, now=None, purpose='bind'):
        self._login(user, jti)
        current = int(time.time() if now is None else now)
        if not digest64(challenge) or type(expires) is not int or not current < expires <= current + 86400:
            raise ValueError('invalid_application_session')
        with self.directory.lock, self.lock, self.db:
            self.db.execute('BEGIN IMMEDIATE')
            row = self.db.execute('SELECT body,expires,user,jti FROM app_challenges WHERE id=?', (challenge,)).fetchone()
            if row is None or row[1] <= current or row[2:] != (user, jti):
                raise ValueError('application_challenge_unavailable')
            body = json.loads(row[0])
            if purpose not in ('bind', 'login') or body['domain'] != 'sfera-mesh-application-' + purpose + '-v1':
                raise ValueError('application_challenge_purpose_mismatch')
            if purpose == 'bind':
                existing = self.db.execute('SELECT owner,user FROM app_identities WHERE owner=? OR user=?',
                                           (body['owner'], user)).fetchall()
                if existing and existing != [(body['owner'], user)]:
                    raise ValueError('application_identity_already_bound')
            elif self.db.execute('SELECT user FROM app_identities WHERE owner=?', (body['owner'],)).fetchone() != (user,):
                raise ValueError('application_identity_not_bound')
            history, public = self._device(body['owner'], body['device'])
            if history['version'] != body['history_version'] or history['digest'] != body['history_hash']:
                raise ValueError('application_challenge_history_changed')
            signatures = [(public, device_signature)]
            # The owner authorizes the initial account association. Subsequent
            # logins use an already enrolled active device without copying the
            # owner's recovery root to that device.
            if purpose == 'bind' or owner_signature:
                signatures.append((history.get('controller_public', history['owner_public']), owner_signature))
            for key, signature in signatures:
                try:
                    if not isinstance(signature, str) or not re.fullmatch('[0-9a-f]{128}', signature):
                        raise ValueError('invalid_application_signature')
                    Ed25519PublicKey.from_public_bytes(bytes.fromhex(key)).verify(bytes.fromhex(signature), canonical(body))
                except (ValueError, InvalidSignature) as exc:
                    raise ValueError('invalid_application_signature') from exc
            self.db.execute('DELETE FROM app_challenges WHERE id=?', (challenge,))
            if purpose == 'bind':
                self.db.execute('INSERT OR IGNORE INTO app_identities VALUES(?,?)', (body['owner'], user))
            self.db.execute('DELETE FROM app_sessions WHERE expires<=?', (current,))
            if self.db.execute('SELECT COUNT(*) FROM app_sessions').fetchone()[0] >= 4096:
                raise ValueError('application_session_limit')
            identity = secrets.token_hex(32)
            self.db.execute('INSERT INTO app_sessions VALUES(?,?,?,?,?,0)',
                            (identity, user, body['owner'], body['device'], expires))
            return {'id': identity, 'owner': body['owner'], 'device': body['device'],
                    'genesis': self.directory.pin, 'entry': self.entry}

    def login_challenge(self, owner, device, *, now=None):
        if not digest64(owner):
            raise ValueError('invalid_application_identity')
        with self.lock:
            row = self.db.execute('SELECT user FROM app_identities WHERE owner=?', (owner,)).fetchone()
        if row is None:
            raise ValueError('application_identity_not_bound')
        return self.challenge(row[0], secrets.token_hex(32), owner, device, now=now, purpose='login')

    def login_context(self, challenge, *, now=None):
        current = int(time.time() if now is None else now)
        if not digest64(challenge):
            raise ValueError('invalid_application_challenge')
        with self.lock:
            row = self.db.execute('SELECT body,expires FROM app_challenges WHERE id=?', (challenge,)).fetchone()
        if row is None or row[1] <= current:
            raise ValueError('application_challenge_unavailable')
        body = json.loads(row[0])
        if body['domain'] != 'sfera-mesh-application-login-v1':
            raise ValueError('application_challenge_purpose_mismatch')
        return body

    def defer_factor(self, user, challenge, claim, *, now=None):
        current = int(time.time() if now is None else now)
        if not isinstance(challenge, str) or not 1 <= len(challenge) <= 4096:
            raise ValueError('invalid_application_factor')
        with self.lock, self.db:
            self.db.execute('BEGIN IMMEDIATE')
            self.db.execute('DELETE FROM app_factors WHERE expires<=?', (current,))
            if self.db.execute('SELECT COUNT(*) FROM app_factors').fetchone()[0] >= 1024:
                raise ValueError('application_factor_limit')
            identity = 'mesh-' + secrets.token_hex(32)
            self.db.execute('INSERT INTO app_factors VALUES(?,?,?,?,?)',
                            (identity, str(user), challenge, json.dumps(claim), current + 300))
        return identity

    def factor_context(self, identity, *, consume=False, now=None):
        current = int(time.time() if now is None else now)
        if not isinstance(identity, str) or not re.fullmatch('mesh-[0-9a-f]{64}', identity):
            raise ValueError('invalid_application_factor')
        with self.lock, self.db:
            self.db.execute('BEGIN IMMEDIATE')
            row = self.db.execute('SELECT user,challenge,claim,expires FROM app_factors WHERE id=?', (identity,)).fetchone()
            if row is None or row[3] <= current:
                raise ValueError('application_factor_unavailable')
            if consume:
                self.db.execute('DELETE FROM app_factors WHERE id=?', (identity,))
            return row[0], row[1], json.loads(row[2])

    def require(self, user, claim, *, now=None):
        current = int(time.time() if now is None else now)
        fields = {'id', 'owner', 'device', 'genesis', 'entry'}
        if not isinstance(claim, dict) or set(claim) != fields or any(not digest64(claim[k]) for k in fields):
            raise ValueError('invalid_application_session_claim')
        if claim['genesis'] != self.directory.pin or claim['entry'] != self.entry:
            raise ValueError('application_session_context_changed')
        with self.directory.lock, self.lock:
            row = self.db.execute('SELECT user,owner,device,expires,revoked FROM app_sessions WHERE id=?', (claim['id'],)).fetchone()
            if row is None or row[:3] != (str(user), claim['owner'], claim['device']) or row[3] <= current or row[4]:
                raise ValueError('application_session_unavailable')
            self._device(claim['owner'], claim['device'])

    def revoke(self, user, claim):
        # Logout must work even when consensus is unavailable.
        if not isinstance(claim, dict) or not digest64(claim.get('id')):
            raise ValueError('invalid_application_session_claim')
        with self.lock, self.db:
            self.db.execute('UPDATE app_sessions SET revoked=1 WHERE id=? AND user=?', (claim['id'], str(user)))
