"""Owner-signed account metadata and externally certified directory checkpoints.

No password/login verification, DHT discovery or BFT voting is implemented here.
The owner signature authenticates content; only an external quorum certificate
can mark its version confirmed. Local anti-rollback is not global consensus.
"""
import json
import re
import sqlite3
import threading
from hashlib import sha256
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .storage import canonical
from .certificates import statement, verify_certificate

ZERO = '0' * 64


def user_id(public):
    return sha256(b'sfera-mesh-user-v1\x00' + public).hexdigest()


def digest64(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def validate_record(record, network, expected_user=None):
    if not isinstance(record, dict) or set(record) != {'body', 'signature'} or len(canonical(record)) > 16384:
        raise ValueError('invalid_account_record')
    body = record['body']
    fields = {'domain', 'network', 'user_id', 'public_key', 'version', 'previous', 'vault_digest', 'dialogs_digest'}
    if not isinstance(body, dict) or set(body) != fields or body['domain'] != 'sfera-mesh-account-v1' or body['network'] != network:
        raise ValueError('invalid_account_context')
    if not all(digest64(body[name]) for name in ('user_id', 'public_key', 'previous', 'vault_digest', 'dialogs_digest')):
        raise ValueError('invalid_account_identifiers')
    if expected_user is not None and body['user_id'] != expected_user:
        raise ValueError('unexpected_account')
    if type(body['version']) is not int or not 1 <= body['version'] <= 2**63 - 1 or (body['version'] == 1 and body['previous'] != ZERO):
        raise ValueError('invalid_account_version')
    public = bytes.fromhex(body['public_key'])
    if user_id(public) != body['user_id']:
        raise ValueError('account_key_mismatch')
    try:
        Ed25519PublicKey.from_public_bytes(public).verify(bytes.fromhex(record['signature']), canonical(body))
    except (InvalidSignature, ValueError, TypeError) as exc:
        raise ValueError('invalid_account_signature') from exc
    return body, sha256(canonical(record)).hexdigest()


def validate_directory_certificate(committee, certificate):
    if committee is None:
        raise ValueError('no_trusted_committee')
    if not isinstance(certificate, dict) or set(certificate) != {'height', 'previous', 'checkpoint', 'votes'} or len(canonical(certificate)) > 32768:
        raise ValueError('invalid_directory_certificate')
    height, previous, checkpoint = certificate['height'], certificate['previous'], certificate['checkpoint']
    if type(height) is not int or not 1 <= height <= 2**63 - 1 or not digest64(previous) or not isinstance(checkpoint, dict) or set(checkpoint) != {'kind', 'user_id', 'version', 'record_hash'} or checkpoint['kind'] != 'account' or not digest64(checkpoint['user_id']) or not digest64(checkpoint['record_hash']) or type(checkpoint['version']) is not int or not 1 <= checkpoint['version'] <= 2**63 - 1:
        raise ValueError('invalid_directory_checkpoint')
    raw_votes = certificate['votes']
    if not isinstance(raw_votes, list) or len(raw_votes) > len(committee.members):
        raise ValueError('invalid_directory_votes')
    try:
        votes = [(node, bytes.fromhex(signature)) for node, signature in raw_votes]
        if not verify_certificate(committee, height, previous, checkpoint, votes):
            raise ValueError('insufficient_directory_quorum')
    except (TypeError, ValueError) as exc:
        raise ValueError('invalid_directory_certificate') from exc
    digest = sha256(statement(committee, height, previous, checkpoint)).hexdigest()
    return height, previous, checkpoint, digest


class AccountDirectory:
    def __init__(self, path, network, committee=None):
        self.network, self.committee = network, committee
        if committee is not None and committee.network != network:
            raise ValueError('committee_network_mismatch')
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS directory_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), network TEXT NOT NULL, committee TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS account_records (
                user_id TEXT, version INTEGER, digest TEXT NOT NULL, record BLOB NOT NULL,
                PRIMARY KEY(user_id, version));
            CREATE TABLE IF NOT EXISTS directory_certificates (
                committee TEXT, height INTEGER, digest TEXT NOT NULL, certificate BLOB NOT NULL,
                PRIMARY KEY(committee, height));
            CREATE TABLE IF NOT EXISTS confirmed_accounts (
                user_id TEXT PRIMARY KEY, version INTEGER NOT NULL, digest TEXT NOT NULL, certificate BLOB NOT NULL);
        """)
        identity = (network, committee.identifier if committee is not None else '')
        old = self.db.execute('SELECT network, committee FROM directory_identity WHERE singleton=1').fetchone()
        if old is not None and tuple(old) != identity:
            self.db.close()
            raise ValueError('directory_trust_configuration_changed')
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO directory_identity VALUES (1, ?, ?)', identity)
        self.lock = threading.RLock()

    def close(self):
        self.db.close()

    def save(self, record):
        body, digest = validate_record(record, self.network)
        with self.lock, self.db:
            existing = self.db.execute('SELECT digest FROM account_records WHERE user_id=? AND version=?', (body['user_id'], body['version'])).fetchone()
            if existing:
                if existing[0] != digest:
                    raise ValueError('account_fork')
            else:
                previous = self.db.execute('SELECT version, digest FROM account_records WHERE user_id=? ORDER BY version DESC LIMIT 1', (body['user_id'],)).fetchone()
                version, previous_digest = previous if previous else (0, ZERO)
                if body['version'] != version + 1 or body['previous'] != previous_digest:
                    raise ValueError('account_chain_gap_or_rollback')
                self.db.execute('INSERT INTO account_records VALUES (?, ?, ?, ?)', (body['user_id'], body['version'], digest, canonical(record)))
        return {'user_id': body['user_id'], 'version': body['version'], 'record_hash': digest, 'stored': True}

    def get(self, identity, version=None, confirmed=False):
        if not digest64(identity) or (version is not None and (type(version) is not int or not 1 <= version <= 2**63 - 1)) or type(confirmed) is not bool:
            raise ValueError('invalid_account_query')
        with self.lock:
            final = self.db.execute('SELECT version, digest, certificate FROM confirmed_accounts WHERE user_id=?', (identity,)).fetchone()
            if confirmed:
                if not final or (version is not None and version != final[0]):
                    return {'error': 'not_found'}
                version = version or final[0]
            row = self.db.execute('SELECT version, digest, record FROM account_records WHERE user_id=?' + (' AND version=?' if version is not None else ' ORDER BY version DESC LIMIT 1'), (identity, version) if version is not None else (identity,)).fetchone()
        if row is None:
            return {'error': 'not_found'}
        record = json.loads(row[2])
        body, checked = validate_record(record, self.network, identity)
        if checked != row[1] or body['version'] != row[0]:
            raise ValueError('corrupt_account_storage')
        result = {'record': record, 'record_hash': row[1], 'confirmed': bool(final and row[0] == final[0]), 'certificate': json.loads(final[2]) if final and row[0] == final[0] else None}
        return verify_account_result(result, self.network, identity, version, confirmed, self.committee)

    def confirm(self, certificate):
        height, previous, checkpoint, digest = validate_directory_certificate(self.committee, certificate)
        committee = self.committee.identifier
        with self.lock, self.db:
            old = self.db.execute('SELECT digest FROM directory_certificates WHERE committee=? AND height=?', (committee, height)).fetchone()
            if old:
                if old[0] != digest:
                    raise ValueError('directory_certificate_fork')
                return {'confirmed': True, 'height': height, 'checkpoint_hash': digest}
            latest = self.db.execute('SELECT height, digest FROM directory_certificates WHERE committee=? ORDER BY height DESC LIMIT 1', (committee,)).fetchone()
            last_height, last_hash = latest if latest else (0, ZERO)
            if height != last_height + 1 or previous != last_hash:
                raise ValueError('directory_certificate_gap_or_rollback')
            target = self.db.execute('SELECT digest FROM account_records WHERE user_id=? AND version=?', (checkpoint['user_id'], checkpoint['version'])).fetchone()
            if not target or target[0] != checkpoint['record_hash']:
                raise ValueError('directory_record_missing')
            final = self.db.execute('SELECT version FROM confirmed_accounts WHERE user_id=?', (checkpoint['user_id'],)).fetchone()
            if final and checkpoint['version'] <= final[0]:
                raise ValueError('directory_account_rollback')
            self.db.execute('INSERT INTO directory_certificates VALUES (?, ?, ?, ?)', (committee, height, digest, canonical(certificate)))
            self.db.execute('INSERT OR REPLACE INTO confirmed_accounts VALUES (?, ?, ?, ?)', (checkpoint['user_id'], checkpoint['version'], checkpoint['record_hash'], canonical(certificate)))
        return {'confirmed': True, 'height': height, 'checkpoint_hash': digest}

    def latest_checkpoint(self):
        if self.committee is None:
            raise ValueError('no_trusted_committee')
        with self.lock:
            row = self.db.execute('SELECT height, digest FROM directory_certificates WHERE committee=? ORDER BY height DESC LIMIT 1', (self.committee.identifier,)).fetchone()
        if row is None:
            raise ValueError('directory_unconfirmed')
        return {'committee': self.committee.identifier, 'height': row[0], 'checkpoint_hash': row[1]}

    def execute(self, operation, payload):
        if not isinstance(payload, dict):
            raise ValueError('invalid_directory_payload')
        if operation == 'account-put' and set(payload) == {'record'}:
            return self.save(payload['record'])
        if operation == 'account-get' and set(payload) == {'user_id', 'version', 'confirmed'}:
            return self.get(payload['user_id'], payload['version'], payload['confirmed'])
        if operation == 'account-confirm' and set(payload) == {'certificate'}:
            return self.confirm(payload['certificate'])
        raise ValueError('unsupported_directory_operation')


def verify_account_result(result, network, identity, version=None, require_confirmed=False, committee=None):
    if result == {'error': 'not_found'}:
        return result
    if not isinstance(result, dict) or set(result) != {'record', 'record_hash', 'confirmed', 'certificate'} or type(result['confirmed']) is not bool:
        raise ValueError('invalid_account_response')
    body, digest = validate_record(result['record'], network, identity)
    if digest != result['record_hash'] or (version is not None and body['version'] != version):
        raise ValueError('account_response_mismatch')
    if result['confirmed']:
        certificate = result['certificate']
        if committee is None or committee.network != network:
            raise ValueError('unverified_account_confirmation')
        _, _, checkpoint, _ = validate_directory_certificate(committee, certificate)
        expected = {'kind': 'account', 'user_id': identity, 'version': body['version'], 'record_hash': digest}
        if checkpoint != expected:
            raise ValueError('account_confirmation_mismatch')
    elif result['certificate'] is not None or require_confirmed:
        raise ValueError('account_not_confirmed')
    return result
