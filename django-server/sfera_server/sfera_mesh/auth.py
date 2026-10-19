"""Entry-point-scoped proof-of-possession authentication for the isolated lab.

Not a production Django/JWT adapter. Every operation except logout requires a
fresh quorum read lease or a verified CometBFT snapshot from a pinned laboratory
genesis. No passwords, plaintext archive keys or module grants.
"""
from hashlib import sha256
import json
import re
import secrets
import sqlite3
import threading
import time
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .directory import digest64
from .identity import node_id
from .readiness import validate_read_lease
from .storage import canonical
from .consensus_directory import ConsensusDirectory


class DirectoryNotReady(ValueError):
    """Temporary control-plane failure, not invalid credentials or logout."""


class ChallengeLimit(ValueError):
    pass


class LoginRequestChanged(ValueError):
    pass


class MeshAuth:
    def __init__(self, path, key, directory, *, pending_limit=1024, per_user_limit=4):
        if type(pending_limit) is not int or type(per_user_limit) is not int or not 1 <= per_user_limit <= pending_limit <= 4096:
            raise ValueError('invalid_login_limits')
        self.consensus_directory = isinstance(directory, ConsensusDirectory)
        if not self.consensus_directory and directory.committee is None:
            raise ValueError('trusted_directory_required')
        self.key, self.directory = key, directory
        self.network = directory.network
        self.entry_node = node_id(key.public_key().public_bytes_raw())
        self.pending_limit, self.per_user_limit = pending_limit, per_user_limit
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS auth_identity (
                singleton INTEGER PRIMARY KEY CHECK(singleton=1), network TEXT, entry_node TEXT, committee TEXT);
            CREATE TABLE IF NOT EXISTS auth_meta (name TEXT PRIMARY KEY, value BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS login_challenges (
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_nonce TEXT NOT NULL,
                expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, challenge BLOB NOT NULL,
                UNIQUE(user_id, client_nonce));
            CREATE INDEX IF NOT EXISTS user_pending_login ON login_challenges(user_id, used, expires);
            CREATE TABLE IF NOT EXISTS mesh_sessions (
                token_hash TEXT PRIMARY KEY, session_id TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL,
                expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
        """)
        trust_context = 'cometbft-v1:' + directory.pin if self.consensus_directory else directory.committee.identifier
        identity = (self.network, self.entry_node, trust_context)
        old = self.db.execute('SELECT network, entry_node, committee FROM auth_identity WHERE singleton=1').fetchone()
        if old is not None and tuple(old) != identity:
            self.db.close()
            raise ValueError('auth_entry_point_changed')
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO auth_identity VALUES (1, ?, ?, ?)', identity)

    def close(self):
        self.db.close()

    def _signed(self, body):
        return {'body': body, 'signature': self.key.sign(canonical(body)).hex()}

    def _ready(self, current):
        try:
            if self.consensus_directory:
                return self.directory.anchor(now=current)
            row = self.db.execute("SELECT value FROM auth_meta WHERE name='read_lease'").fetchone()
            if row is None:
                raise ValueError('directory_not_ready')
            return validate_read_lease(self.directory.committee, json.loads(row[0]), self.directory.latest_checkpoint(), now=current)
        except (ValueError, TypeError) as exc:
            raise DirectoryNotReady('directory_not_ready') from exc

    def _account(self, identity):
        try:
            account = self.directory.get(identity) if self.consensus_directory else self.directory.get(identity, confirmed=True)
            if account.get('error') == 'not_found':
                raise ValueError('account_not_confirmed')
            return account
        except (ValueError, TypeError) as exc:
            raise DirectoryNotReady('account_not_confirmed') from exc

    def set_read_lease(self, lease, *, now=None):
        if self.consensus_directory:
            raise ValueError('cometbft_evidence_required')
        current = int(time.time() if now is None else now)
        with self.directory.lock, self.lock, self.db:
            self.db.execute('BEGIN IMMEDIATE')
            body = validate_read_lease(self.directory.committee, lease, self.directory.latest_checkpoint(), now=current)
            old = self.db.execute("SELECT value FROM auth_meta WHERE name='read_lease'").fetchone()
            if old is not None and json.loads(old[0])['body']['issued_at'] > body['issued_at']:
                raise ValueError('read_lease_rollback')
            self.db.execute("INSERT OR REPLACE INTO auth_meta VALUES ('read_lease', ?)", (canonical(lease),))
        return {'ready_until': body['expires_at'], 'checkpoint_hash': body['checkpoint_hash']}

    def challenge(self, identity, client_nonce, *, now=None):
        if not digest64(identity) or not digest64(client_nonce):
            raise ValueError('invalid_login_identity')
        current = int(time.time() if now is None else now)
        with self.directory.lock, self.lock, self.db:
            self.db.execute('BEGIN IMMEDIATE')
            lease = self._ready(current)
            account = self._account(identity)
            self.db.execute('DELETE FROM login_challenges WHERE expires<=?', (current,))
            old = self.db.execute('SELECT challenge, used FROM login_challenges WHERE user_id=? AND client_nonce=?', (identity, client_nonce)).fetchone()
            if old:
                challenge = json.loads(old[0])
                if old[1] or challenge['body']['account_hash'] != account['record_hash']:
                    raise ValueError('client_nonce_already_used')
                return challenge
            pending = self.db.execute('SELECT COUNT(*) FROM login_challenges WHERE used=0').fetchone()[0]
            user_pending = self.db.execute('SELECT COUNT(*) FROM login_challenges WHERE used=0 AND user_id=?', (identity,)).fetchone()[0]
            if pending >= self.pending_limit or user_pending >= self.per_user_limit:
                raise ChallengeLimit('login_challenge_limit')
            body = {'domain': 'sfera-mesh-login-v1', 'network': self.network, 'entry_node': self.entry_node,
                    'user_id': identity, 'account_version': account['record']['body']['version'], 'account_hash': account['record_hash'],
                    'client_nonce': client_nonce, 'challenge_id': secrets.token_hex(32), 'issued_at': current, 'expires_at': min(current + 60, lease['expires_at'])}
            challenge = self._signed(body)
            self.db.execute('INSERT INTO login_challenges(id, user_id, client_nonce, expires, challenge) VALUES (?, ?, ?, ?, ?)', (body['challenge_id'], identity, client_nonce, body['expires_at'], canonical(challenge)))
            return challenge

    def complete(self, challenge_id, signature, *, now=None):
        if not digest64(challenge_id) or not isinstance(signature, str) or not re.fullmatch('[0-9a-f]{128}', signature):
            raise ValueError('invalid_login_proof')
        current = int(time.time() if now is None else now)
        with self.directory.lock, self.lock, self.db:
            self.db.execute('BEGIN IMMEDIATE')
            self._ready(current)
            row = self.db.execute('SELECT challenge, used, expires FROM login_challenges WHERE id=?', (challenge_id,)).fetchone()
            if row is None or row[1] or row[2] <= current:
                raise ValueError('login_challenge_unavailable')
            body = json.loads(row[0])['body']
            account = self._account(body['user_id'])
            if account['record_hash'] != body['account_hash'] or account['record']['body']['version'] != body['account_version']:
                raise LoginRequestChanged('login_account_changed')
            try:
                Ed25519PublicKey.from_public_bytes(bytes.fromhex(account['record']['body']['public_key'])).verify(bytes.fromhex(signature), canonical(body))
            except (ValueError, InvalidSignature) as exc:
                raise ValueError('invalid_login_proof') from exc
            changed = self.db.execute('UPDATE login_challenges SET used=1 WHERE id=? AND used=0', (challenge_id,)).rowcount
            if changed != 1:
                raise ValueError('login_challenge_used')
            token = secrets.token_urlsafe(32)
            token_hash = self._token_hash(token)
            session_id = secrets.token_hex(16)
            expiry = current + 600
            self.db.execute('DELETE FROM mesh_sessions WHERE expires<=?', (current,))
            self.db.execute('INSERT INTO mesh_sessions(token_hash, session_id, user_id, expires) VALUES (?, ?, ?, ?)', (token_hash, session_id, body['user_id'], expiry))
            return self._signed({'domain': 'sfera-mesh-session-v1', 'scope': 'mesh-identity', 'network': self.network,
                                 'entry_node': self.entry_node, 'user_id': body['user_id'], 'session_id': session_id,
                                 'client_nonce': body['client_nonce'], 'challenge_id': challenge_id,
                                 'issued_at': current, 'expires_at': expiry, 'token': token})

    @staticmethod
    def _token_hash(token):
        if not isinstance(token, str) or not re.fullmatch('[a-zA-Z0-9_-]{43}', token):
            raise ValueError('invalid_mesh_session')
        return sha256(b'sfera-mesh-session-v1\x00' + token.encode()).hexdigest()

    def session(self, token, client_nonce, *, now=None):
        if not digest64(client_nonce):
            raise ValueError('invalid_session_nonce')
        current = int(time.time() if now is None else now)
        with self.directory.lock, self.lock:
            self._ready(current)
            row = self.db.execute('SELECT session_id, user_id, expires, revoked FROM mesh_sessions WHERE token_hash=?', (self._token_hash(token),)).fetchone()
            if row is None or row[3] or row[2] <= current:
                raise ValueError('mesh_session_unavailable')
            self._account(row[1])
            return self._signed({'domain': 'sfera-mesh-session-state-v1', 'scope': 'mesh-identity', 'network': self.network,
                                 'entry_node': self.entry_node, 'session_id': row[0], 'user_id': row[1], 'client_nonce': client_nonce,
                                 'issued_at': current, 'expires_at': row[2], 'state': 'active'})

    def logout(self, token, client_nonce, *, now=None):
        if not digest64(client_nonce):
            raise ValueError('invalid_session_nonce')
        current = int(time.time() if now is None else now)
        # Revocation stays possible when the directory/validators are unavailable.
        with self.lock, self.db:
            token_hash = self._token_hash(token)
            row = self.db.execute('SELECT session_id, user_id FROM mesh_sessions WHERE token_hash=?', (token_hash,)).fetchone()
            if row is None:
                raise ValueError('mesh_session_unavailable')
            self.db.execute('UPDATE mesh_sessions SET revoked=1 WHERE token_hash=?', (token_hash,))
            return self._signed({'domain': 'sfera-mesh-logout-v1', 'network': self.network, 'entry_node': self.entry_node,
                                 'session_id': row[0], 'user_id': row[1], 'client_nonce': client_nonce, 'issued_at': current, 'revoked': True})

    def execute(self, operation, payload, token=None):
        if not isinstance(payload, dict):
            raise ValueError('invalid_auth_payload')
        if operation == 'challenge' and set(payload) == {'user_id', 'client_nonce'}:
            return self.challenge(payload['user_id'], payload['client_nonce'])
        if operation == 'complete' and set(payload) == {'challenge_id', 'signature'}:
            return self.complete(payload['challenge_id'], payload['signature'])
        if operation == 'session' and set(payload) == {'client_nonce'}:
            return self.session(token, payload['client_nonce'])
        if operation == 'logout' and set(payload) == {'client_nonce'}:
            return self.logout(token, payload['client_nonce'])
        raise ValueError('unsupported_auth_operation')
