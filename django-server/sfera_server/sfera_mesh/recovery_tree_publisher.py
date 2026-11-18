"""Durable exact transaction publication for a v2 recovery tree head.

The caller builds/encrypts pages and signs one immutable target. This publisher
never rebases a pending proof on a different head after a lost reply.
"""
import base64
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import threading
import time
from urllib.error import HTTPError

from .consensus_directory import ConsensusDirectory, validate_address, rpc
from .licenses import verify_attestation
from .recovery_roots import namespace
from .recovery_tree import validate_head, validate_state, transition, path_root, RecoveryTree, EMPTY, updates_digest
from .refresh_lock import RefreshLock
from .storage import canonical


class RecoveryTreePublisher:
    def __init__(self, path, directory, address, transaction, *, database_bytes=None):
        validate_address(address)
        if not isinstance(directory, ConsensusDirectory): raise ValueError('verified_recovery_directory_required')
        raw = canonical(transaction)
        if len(raw) > 65536: raise ValueError('recovery_tree_transaction_limit')
        transaction = json.loads(raw)
        if not isinstance(transaction, dict) or set(transaction) != {'body', 'signature', 'updates'}:
            raise ValueError('invalid_recovery_tree_transaction')
        record = {key: transaction[key] for key in ('body', 'signature')}
        body, digest = validate_head(record, directory.network, directory.pin)
        updates = transaction['updates']
        if not isinstance(updates, list) or len(updates) > 4 or updates_digest(updates) != body['updates_hash']:
            raise ValueError('invalid_recovery_tree_updates_hash')
        if updates:
            if any(not isinstance(update, dict) or set(update) != {'message', 'old', 'new', 'path'} for update in updates):
                raise ValueError('invalid_recovery_tree_update')
            first = updates[0]
            initial_root = path_root(first['message'], first['old'], first['path'])
            initial_count = body['count'] - sum(update['old'] == 0 for update in updates)
            initial_deleted = body['deleted_count'] - sum(update['new'] == 2 and update['old'] != 2 for update in updates)
            if transition(initial_root, initial_count, initial_deleted, updates) != (body['root'], body['count'], body['deleted_count']):
                raise ValueError('recovery_tree_transition_commitment_mismatch')
        self.transaction, self.record, self.body, self.digest = transaction, record, body, digest
        self.identity = namespace(body['publisher'], body['source'], body['scope'])
        self.directory, self.address = directory, address
        self.lock = threading.RLock()
        self.process_lock = RefreshLock(None if str(path) == ':memory:' else str(Path(path).resolve()) + '.recovery-tree.lock')
        self.db = sqlite3.connect(path, check_same_thread=False)
        try:
            if database_bytes is not None:
                if type(database_bytes) is not int or not 65536 <= database_bytes <= 4 * 1024**3:
                    raise ValueError('invalid_recovery_tree_disk_budget')
                if self.db.execute('PRAGMA journal_mode').fetchone()[0] != 'delete':
                    raise ValueError('recovery_tree_rollback_journal_required')
                size = self.db.execute('PRAGMA page_size').fetchone()[0]
                if self.db.execute('PRAGMA page_count').fetchone()[0] * size > database_bytes:
                    raise ValueError('recovery_tree_disk_budget_exceeded')
                self.db.execute('PRAGMA max_page_count=' + str(database_bytes // size))
                self.db.execute('PRAGMA temp_store=MEMORY')
            names = {row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")}
            if names and names != {'recovery_tree_outbox'}: raise ValueError('foreign_recovery_tree_database')
            self.db.execute('PRAGMA synchronous=FULL')
            self.db.execute('CREATE TABLE IF NOT EXISTS recovery_tree_outbox(singleton INTEGER PRIMARY KEY CHECK(singleton=1), transaction_bytes BLOB NOT NULL, retry_at REAL NOT NULL DEFAULT 0)')
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                old = self.db.execute('SELECT transaction_bytes FROM recovery_tree_outbox').fetchone()
                if old and bytes(old[0]) != raw: raise ValueError('recovery_tree_outbox_context_changed')
                self.db.execute('INSERT OR IGNORE INTO recovery_tree_outbox(singleton,transaction_bytes) VALUES(1,?)', (raw,))
        except BaseException:
            self.db.close(); raise

    def close(self):
        with self.lock: self.db.close()

    def _check_transition(self, state):
        old = state.get('recovery_trees', {}).get(self.identity)
        legacy = state.get('recovery_roots', {}).get(self.identity)
        if old:
            previous, version = old['digest'], old['record']['body']['version']
            start = old['record']['body']
            root, count, deleted = start['root'], start['count'], start['deleted_count']
        elif legacy:
            if self.transaction['updates']: raise ValueError('recovery_tree_migration_must_retain_registry')
            start = legacy['record']['body']
            root = RecoveryTree(start['messages'], start['deleted']).root
            count, deleted = len(start['messages']), len(start['deleted'])
            previous, version = legacy['digest'], start['version']
        else:
            previous, version, root, count, deleted = '0' * 64, 0, EMPTY[128].hex(), 0, 0
        if (self.body['previous'], self.body['version']) != (previous, version + 1):
            return False
        root, count, deleted = transition(root, count, deleted, self.transaction['updates'])
        if (root, count, deleted) != (self.body['root'], self.body['count'], self.body['deleted_count']):
            raise ValueError('recovery_tree_transition_commitment_mismatch')
        return True

    def step(self):
        with self.lock:
            if not self.process_lock.acquire(): return {'state': 'busy'}
            try:
                stored = self.db.execute('SELECT transaction_bytes,retry_at FROM recovery_tree_outbox WHERE singleton=1').fetchone()
                raw = canonical(self.transaction)
                if stored is None or bytes(stored[0]) != raw or sha256(canonical(self.record)).hexdigest() != self.digest:
                    raise ValueError('recovery_tree_outbox_corrupt')
                validate_head(self.record, self.directory.network, self.directory.pin)
                if updates_digest(self.transaction['updates']) != self.body['updates_hash']:
                    raise ValueError('recovery_tree_outbox_corrupt')
                self.directory.refresh(self.address)
                with self.directory.lock:
                    anchor = self.directory.anchor()
                    state = json.loads(canonical(self.directory.current['state']))
                if state.get('genesis_pin') != self.directory.pin: raise ValueError('recovery_tree_genesis_required')
                validate_state(state, self.directory.network, self.directory.pin)
                old = state.get('recovery_trees', {}).get(self.identity)
                if old and old['digest'] == self.digest:
                    return {'state': 'confirmed', 'root_hash': self.digest, 'version': self.body['version'], 'finality': anchor}
                if not self._check_transition(state): return {'state': 'conflict', 'error': 'recovery_tree_head_changed'}
                proposed = {**state, 'recovery_trees': {**state.get('recovery_trees', {}), self.identity: {'record': self.record, 'digest': self.digest}}}
                validate_state(proposed, self.directory.network, self.directory.pin)
                candidate = state['candidates'][self.body['publisher']]['record']['body']
                verify_attestation(candidate['license'], {key: bytes.fromhex(public) for key, public in self.directory.license_issuers.items()},
                    self.body['publisher'], self.directory.network, now=state['block_time'])
                if time.time() < stored[1] <= time.time() + 10:
                    return {'state': 'waiting', 'root_hash': self.digest}
                response = rpc(self.address, 'broadcast_tx_sync', {'tx': base64.b64encode(raw).decode()})
                if response.get('code', 0): raise ValueError('recovery_tree_transaction_rejected')
                with self.db:
                    self.db.execute('UPDATE recovery_tree_outbox SET retry_at=? WHERE singleton=1', (time.time() + 2,))
                return {'state': 'submitted', 'root_hash': self.digest}
            except (ValueError, OSError, sqlite3.Error) as exc:
                if isinstance(exc, HTTPError): exc.close()
                error = str(exc) if isinstance(exc, ValueError) and len(str(exc)) <= 96 else 'recovery_tree_publish_unavailable'
                return {'state': 'waiting', 'error': error}
            finally:
                self.process_lock.release()
