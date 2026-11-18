"""One immutable durable job to publish a committed recovery-index pointer."""
import base64
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import threading
import time
from urllib.error import HTTPError

from .consensus_directory import ConsensusDirectory, validate_address, rpc
from .directory import ZERO
from .identity import node_id
from .licenses import verify_attestation
from .recovery_roots import namespace, root_record, validate_root, validate_recovery_roots
from .refresh_lock import RefreshLock
from .storage import canonical


class RecoveryPublisher:
    def __init__(self, path, directory, address, key, *, source, scope, cluster, block_digest, size, messages=(), deleted=(), expected_previous=None, database_bytes=None):
        validate_address(address)
        if not isinstance(directory, ConsensusDirectory):
            raise ValueError('verified_recovery_directory_required')
        public = key.public_key().public_bytes_raw()
        self.publisher = node_id(public)
        from .directory import digest64
        if expected_previous is not None and not digest64(expected_previous):
            raise ValueError('invalid_recovery_expected_previous')
        self.expected_previous = expected_previous
        messages, deleted = list(messages), list(deleted)
        # Validate the entire target before opening or creating a database.
        root_record(key, directory.network, directory.pin, source, scope, cluster, block_digest, size, messages=messages, deleted=deleted)
        self.identity = namespace(self.publisher, source, scope)
        self.directory, self.address, self.key = directory, address, key
        self.target = {'source': source, 'scope': scope, 'cluster': cluster, 'digest': block_digest, 'size': size,
            'messages': list(messages), 'deleted': list(deleted)}
        self.lock = threading.RLock()
        self.process_lock = RefreshLock(None if str(path) == ':memory:' else str(Path(path).resolve()) + '.recovery-root.lock')
        self.db = sqlite3.connect(path, check_same_thread=False)
        try:
            if database_bytes is not None:
                if type(database_bytes) is not int or not 65536 <= database_bytes <= 4 * 1024**3:
                    raise ValueError('invalid_recovery_root_disk_budget')
                if self.db.execute('PRAGMA journal_mode').fetchone()[0] != 'delete':
                    raise ValueError('recovery_root_rollback_journal_required')
                page_size = self.db.execute('PRAGMA page_size').fetchone()[0]
                if self.db.execute('PRAGMA page_count').fetchone()[0] * page_size > database_bytes:
                    raise ValueError('recovery_root_disk_budget_exceeded')
                self.db.execute('PRAGMA max_page_count=' + str(database_bytes // page_size))
                self.db.execute('PRAGMA temp_store=MEMORY')
            names = {row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")}
            if names and names != {'recovery_publisher_pin', 'recovery_publisher_job'}:
                raise ValueError('foreign_recovery_publisher_database')
            self.db.execute('PRAGMA synchronous=FULL')
            self.db.executescript('''
            CREATE TABLE IF NOT EXISTS recovery_publisher_pin(singleton INTEGER PRIMARY KEY CHECK(singleton=1), context BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS recovery_publisher_job(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                record BLOB NOT NULL, retry_at REAL NOT NULL DEFAULT 0);
            ''')
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                context = canonical({'network': directory.network, 'genesis': directory.pin,
                    'publisher': self.publisher, **self.target,
                    **({'expected_previous': expected_previous} if expected_previous is not None else {})})
                old = self.db.execute('SELECT context FROM recovery_publisher_pin').fetchone()
                if old and bytes(old[0]) != context:
                    raise ValueError('recovery_publisher_context_changed')
                self.db.execute('INSERT OR IGNORE INTO recovery_publisher_pin VALUES(1,?)', (context,))
        except BaseException:
            self.db.close()
            raise

    def close(self):
        with self.lock:
            self.db.close()

    def step(self):
        with self.lock:
            if not self.process_lock.acquire():
                return {'state': 'busy'}
            try:
                self.directory.refresh(self.address)
                with self.directory.lock:
                    anchor = self.directory.anchor()
                    state = json.loads(canonical(self.directory.current['state']))
                if state.get('genesis_pin') != self.directory.pin:
                    raise ValueError('recovery_genesis_pin_required')
                if self.identity in state.get('recovery_trees', {}):
                    raise ValueError('recovery_tree_v2_publisher_required')
                validate_recovery_roots(state, self.directory.network, self.directory.pin)
                old = state.get('recovery_roots', {}).get(self.identity)
                pending = self.db.execute('SELECT record,retry_at FROM recovery_publisher_job').fetchone()
                if pending:
                    raw = bytes(pending[0])
                    if len(raw) > 32768:
                        raise ValueError('recovery_publisher_outbox_corrupt')
                    record = json.loads(raw)
                    body, digest = validate_root(record, self.directory.network, self.directory.pin)
                    if canonical(record) != raw or body['publisher'] != self.publisher or any(body[field] != value for field, value in self.target.items()):
                        raise ValueError('recovery_publisher_outbox_corrupt')
                    if old and old['digest'] == digest:
                        return {'state': 'confirmed', 'root_hash': digest, 'version': body['version'], 'finality': anchor}
                    if ((old is None and body['version'] != 1) or
                            (old is not None and (body['version'] != old['record']['body']['version'] + 1 or body['previous'] != old['digest']))):
                        return {'state': 'conflict', 'error': 'recovery_root_head_changed'}
                else:
                    if old and all(old['record']['body'][field] == value for field, value in self.target.items()):
                        return {'state': 'confirmed', 'root_hash': old['digest'], 'version': old['record']['body']['version'], 'finality': anchor}
                    if self.expected_previous is not None and (old['digest'] if old else ZERO) != self.expected_previous:
                        return {'state': 'conflict', 'error': 'recovery_root_head_changed'}
                    if old is None and len(state.get('recovery_roots', {})) >= 128:
                        raise ValueError('recovery_root_registry_limit')
                    prior = old['record']['body']['version'] if old else 0
                    record = root_record(self.key, self.directory.network, self.directory.pin,
                        self.target['source'], self.target['scope'], self.target['cluster'], self.target['digest'], self.target['size'],
                        version=prior + 1, previous=old['digest'] if old else ZERO,
                        messages=self.target['messages'], deleted=self.target['deleted'])
                    body, digest = validate_root(record, self.directory.network, self.directory.pin)
                # The signed target cannot be submitted before exact sized
                # inclusion. Simulate only this namespace in the verified state.
                proposed = {**state, 'recovery_roots': {**state.get('recovery_roots', {}), self.identity: {'record': record, 'digest': digest}}}
                validate_recovery_roots(proposed, self.directory.network, self.directory.pin)
                from .recovery_roots import check_progress
                check_progress(state, proposed)
                candidate = state['candidates'][self.publisher]['record']['body']
                verify_attestation(candidate['license'], {identity: bytes.fromhex(public) for identity, public in self.directory.license_issuers.items()},
                    self.publisher, self.directory.network, now=state['block_time'])
                if not pending:
                    with self.db:
                        self.db.execute('INSERT INTO recovery_publisher_job(singleton,record) VALUES(1,?)', (canonical(record),))
                elif pending[1] > time.time() and pending[1] <= time.time() + 10:
                    return {'state': 'waiting', 'root_hash': digest}
                response = rpc(self.address, 'broadcast_tx_sync', {'tx': base64.b64encode(canonical(record)).decode()})
                if response.get('code', 0):
                    raise ValueError('recovery_root_transaction_rejected')
                with self.db:
                    self.db.execute('UPDATE recovery_publisher_job SET retry_at=? WHERE singleton=1', (time.time() + 2,))
                return {'state': 'submitted', 'root_hash': digest}
            except (ValueError, OSError) as exc:
                if isinstance(exc, HTTPError):
                    exc.close()
                error = str(exc) if isinstance(exc, ValueError) and len(str(exc)) <= 96 else 'recovery_publish_unavailable'
                return {'state': 'waiting', 'error': error}
            finally:
                self.process_lock.release()
