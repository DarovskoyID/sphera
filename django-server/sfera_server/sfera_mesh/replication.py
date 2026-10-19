"""Durable ciphertext replication laboratory, NOT BFT membership/finality.

The operator supplies trusted placement profiles and explicitly reports failures.
No plaintext, module authorisation, user routing or automatic admission lives here.
"""
from dataclasses import replace
from hashlib import sha256
import json
import sqlite3
import threading
import time
from pathlib import Path
from urllib.error import HTTPError

from .consensus_directory import validate_address, ConsensusDirectory
from .directory import digest64
from .identity import node_id
from .refresh_lock import RefreshLock
from .storage import canonical
from .topology import choose_cluster, choose_replacement
from .transport import exchange


class ReplicaJournal:
    def __init__(self, path, key, verifier, endpoints, *, require_consensus=False):
        if type(require_consensus) is not bool:
            raise ValueError('invalid_replication_mode')
        if not 3 <= len(endpoints) <= 64 or any(not digest64(node) or node not in verifier.roster for node in endpoints):
            raise ValueError('explicit_replica_roster_required')
        for endpoint in endpoints.values():
            validate_address(endpoint)
            if endpoint.endswith('/'):
                raise ValueError('replica_endpoint_must_have_no_path')
        self.key, self.verifier, self.endpoints = key, verifier, dict(endpoints)
        identity = node_id(key.public_key().public_bytes_raw())
        if verifier.recipient != identity:
            raise ValueError('journal_node_mismatch')
        self.lock = threading.RLock()
        self.process_lock = RefreshLock(None if str(path) == ':memory:' else str(Path(path).resolve()) + '.replication.lock')
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS replica_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), context BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS replica_clusters (id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, members BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS replica_sources (cluster TEXT, node TEXT, PRIMARY KEY(cluster,node));
            CREATE TABLE IF NOT EXISTS replica_trust (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pin TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS replica_required (singleton INTEGER PRIMARY KEY CHECK(singleton=1));
            CREATE TABLE IF NOT EXISTS replica_confirmations (cluster TEXT PRIMARY KEY, epoch INTEGER, digest TEXT NOT NULL, height INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS replica_jobs (cluster TEXT NOT NULL, digest TEXT NOT NULL, payload BLOB, epoch INTEGER NOT NULL, retry_at REAL NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending', error TEXT, PRIMARY KEY(cluster,digest));
            CREATE INDEX IF NOT EXISTS pending_replica_jobs ON replica_jobs(cluster,state,retry_at);
            CREATE TABLE IF NOT EXISTS replica_receipts (cluster TEXT, digest TEXT, epoch INTEGER, node TEXT, checked_at INTEGER NOT NULL, PRIMARY KEY(cluster,digest,epoch,node));
        ''')
        context = canonical({'network': verifier.network, 'node': identity, 'roster': {node: public.hex() for node, public in verifier.roster.items()}})
        try:
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                old = self.db.execute('SELECT context FROM replica_identity').fetchone()
                if old and old[0] != context:
                    raise ValueError('replica_journal_context_changed')
                self.db.execute('INSERT OR IGNORE INTO replica_identity VALUES (1,?)', (context,))
                if require_consensus:
                    self.db.execute('INSERT OR IGNORE INTO replica_required VALUES (1)')
        except Exception:
            self.db.close()
            raise

    def close(self):
        with self.lock:
            self.db.close()

    def _memberships(self, node):
        return frozenset(cluster for cluster, members in self.db.execute('SELECT id,members FROM replica_clusters') if node in json.loads(members))

    def _operator_only(self):
        if self.db.execute('SELECT 1 FROM replica_trust').fetchone() or self.db.execute('SELECT 1 FROM replica_required').fetchone():
            raise ValueError('consensus_placement_required')

    def _require_confirmed(self, cluster):
        if (self.db.execute('SELECT 1 FROM replica_trust').fetchone() or self.db.execute('SELECT 1 FROM replica_required').fetchone()) and not self.db.execute('SELECT 1 FROM replica_confirmations WHERE cluster=?', (cluster,)).fetchone():
            raise ValueError('cluster_not_confirmed')

    def apply_confirmed_placement(self, directory, cluster, profiles):
        if not isinstance(directory, ConsensusDirectory) or directory.network != self.verifier.network:
            raise ValueError('matching_verified_directory_required')
        with directory.lock, self.lock, self.db:
            confirmed = directory.placement(cluster)
            history = directory.placement_history(cluster)
            body, digest = confirmed['record']['body'], confirmed['record_hash']
            self.db.execute('BEGIN IMMEDIATE')
            pin = self.db.execute('SELECT pin FROM replica_trust').fetchone()
            if pin and pin[0] != directory.pin:
                raise ValueError('placement_trust_changed')
            prior = self.db.execute('SELECT epoch,digest FROM replica_confirmations WHERE cluster=?', (cluster,)).fetchone()
            if prior and prior == (body['epoch'], digest):
                return {'epoch': body['epoch'], 'changed': False}
            if prior and (body['epoch'] <= prior[0] or len(history) < prior[0] or history[prior[0]-1]['digest'] != prior[1]):
                raise ValueError('placement_history_required')
            if not 3 <= len(profiles) <= 64:
                raise ValueError('bounded_placement_profiles_required')
            prepared = {}
            for node in profiles:
                known = {other for other, head in directory.current['state'].get('placements', {}).items() if other != cluster and node.node_id in head['record']['body']['members']}
                memberships = (node.memberships | self._memberships(node.node_id) | frozenset(known)) - {cluster}
                prepared[node.node_id] = replace(node, memberships=memberships, grant_verified=node.grant_verified and type(node.grant_expires_at) is int)
            if len(prepared) != len(profiles) or any(node not in self.endpoints for node in prepared) or any(node not in prepared for node in body['members']):
                raise ValueError('unknown_or_duplicate_placement_profile')
            if body['epoch'] > 1:
                old_members = history[-2]['record']['body']['members']
                survivors = [prepared[node] for node in old_members if node in body['members']]
                chosen = choose_replacement(survivors, [node for node in prepared.values() if node.node_id not in old_members], cluster)
                if chosen is None or sorted([node.node_id for node in survivors] + [chosen.node_id]) != body['members']:
                    raise ValueError('confirmed_placement_violates_local_policy')
            elif sorted(node.node_id for node in choose_cluster(list(prepared.values()))) != body['members']:
                raise ValueError('confirmed_placement_violates_local_policy')
            self.db.execute('INSERT OR IGNORE INTO replica_trust VALUES (1,?)', (directory.pin,))
            self.db.execute('INSERT OR IGNORE INTO replica_required VALUES (1)')
            self.db.execute('INSERT OR REPLACE INTO replica_clusters VALUES (?,?,?)', (cluster, body['epoch'], canonical(body['members'])))
            self.db.execute('INSERT OR REPLACE INTO replica_confirmations VALUES (?,?,?,?)', (cluster, body['epoch'], digest, confirmed['finality']['height']))
            self.db.execute('DELETE FROM replica_receipts WHERE cluster=? AND epoch=?', (cluster,body['epoch']))
            sources = {node for head in history for node in head['record']['body']['members']}
            if any(node not in self.endpoints for node in sources):
                raise ValueError('historical_source_roster_required')
            self.db.executemany('INSERT OR IGNORE INTO replica_sources VALUES (?,?)', [(cluster,node) for node in sources])
            self.db.execute("UPDATE replica_jobs SET epoch=?,retry_at=0,attempts=0,state='pending',error=NULL WHERE cluster=?", (body['epoch'],cluster))
            return {'epoch': body['epoch'], 'changed': True}

    def register_cluster(self, cluster, members):
        if not isinstance(cluster, str) or not 1 <= len(cluster) <= 128 or len(members) != 3:
            raise ValueError('invalid_cluster')
        with self.lock, self.db:
            self.db.execute('BEGIN IMMEDIATE')
            self._operator_only()
            old = self.db.execute('SELECT epoch,members FROM replica_clusters WHERE id=?', (cluster,)).fetchone()
            ids = sorted(node.node_id for node in members)
            if old:
                if json.loads(old[1]) != ids:
                    raise ValueError('use_explicit_replacement')
                return old[0]
            profiles = [replace(node, memberships=node.memberships | self._memberships(node.node_id), grant_verified=node.grant_verified and type(node.grant_expires_at) is int) for node in members]
            if any(node not in self.endpoints for node in ids) or len(choose_cluster(profiles)) != 3:
                raise ValueError('ineligible_storage_triple')
            self.db.execute('INSERT INTO replica_clusters VALUES (?,1,?)', (cluster, canonical(ids)))
            self.db.executemany('INSERT INTO replica_sources VALUES (?,?)', [(cluster, node) for node in ids])
        return 1

    def replace_failed(self, cluster, failed, profiles, *, expected_epoch):
        """Explicit laboratory plan; agreement on topology still needs consensus."""
        if type(expected_epoch) is not int or expected_epoch < 1 or not digest64(failed):
            raise ValueError('invalid_replacement_context')
        with self.lock, self.db:
            self.db.execute('BEGIN IMMEDIATE')
            self._operator_only()
            row = self.db.execute('SELECT epoch,members FROM replica_clusters WHERE id=?', (cluster,)).fetchone()
            if row is None or row[0] != expected_epoch or failed not in json.loads(row[1]):
                raise ValueError('placement_changed')
            members = json.loads(row[1])
            eligible = {node.node_id: replace(node, memberships=node.memberships | self._memberships(node.node_id), grant_verified=node.grant_verified and type(node.grant_expires_at) is int) for node in profiles if node.node_id in self.endpoints}
            if len(eligible) != len(profiles):
                raise ValueError('duplicate_or_unknown_profiles')
            if any(node not in eligible for node in members if node != failed):
                raise ValueError('survivor_profiles_required')
            survivors = [eligible[node] for node in members if node != failed]
            candidate = choose_replacement(survivors, [node for node in eligible.values() if node.node_id not in members], cluster)
            if candidate is None:
                raise ValueError('no_eligible_replacement')
            new_members = sorted([node.node_id for node in survivors] + [candidate.node_id])
            epoch = row[0] + 1
            self.db.execute('UPDATE replica_clusters SET epoch=?,members=? WHERE id=?', (epoch, canonical(new_members), cluster))
            self.db.executemany('INSERT OR IGNORE INTO replica_sources VALUES (?,?)', [(cluster, node) for node in new_members])
            self.db.execute("UPDATE replica_jobs SET epoch=?,retry_at=0,attempts=0,state='pending',error=NULL WHERE cluster=?", (epoch, cluster))
            return {'epoch': epoch, 'members': new_members, 'replacement': candidate.node_id, 'temporary': bool(candidate.memberships)}

    def stage(self, cluster, ciphertext):
        if not isinstance(ciphertext, bytes) or not 1 <= len(ciphertext) <= 262144:
            raise ValueError('bounded_ciphertext_required')
        digest = sha256(ciphertext).hexdigest()
        self._stage_digest(cluster, digest, ciphertext)
        return digest

    def _stage_digest(self, cluster, digest, ciphertext):
        if not digest64(digest):
            raise ValueError('invalid_manifest_digest')
        with self.lock, self.db:
            self.db.execute('BEGIN IMMEDIATE')
            self._require_confirmed(cluster)
            row = self.db.execute('SELECT epoch FROM replica_clusters WHERE id=?', (cluster,)).fetchone()
            if row is None:
                raise ValueError('unknown_cluster')
            self.db.execute('INSERT OR IGNORE INTO replica_jobs(cluster,digest,payload,epoch) VALUES (?,?,?,?)', (cluster, digest, ciphertext, row[0]))
            if ciphertext is not None:
                self.db.execute('UPDATE replica_jobs SET payload=? WHERE cluster=? AND digest=?', (ciphertext, cluster, digest))

    def enqueue_manifest(self, storage, cluster, *, after=None, limit=64):
        rows = storage.affected_page(cluster, after=after, limit=limit)
        for dialog, position, block, digest in rows:
            try:
                payload = canonical([item.hex() for item in storage.read(block)])
            except (FileNotFoundError, ValueError):
                payload = None
            if payload is not None and (len(payload) > 262144 or sha256(payload).hexdigest() != digest):
                raise ValueError('manifest_payload_mismatch_or_oversized')
            self._stage_digest(cluster, digest, payload)
        return {'enqueued': len(rows), 'cursor': list(rows[-1][:2]) if rows else after, 'more_possible': len(rows) == limit}

    def restore_manifest_page(self, storage, cluster, *, after=None, limit=64):
        rows = storage.affected_page(cluster, after=after, limit=limit)
        restored = 0
        with self.lock:
            for _, _, block, digest in rows:
                row = self.db.execute('SELECT payload FROM replica_jobs WHERE cluster=? AND digest=?', (cluster, digest)).fetchone()
                if row is not None and row[0] is not None:
                    storage.restore_payload(block, row[0])
                    restored += 1
        return {'restored': restored, 'missing': len(rows) - restored, 'cursor': list(rows[-1][:2]) if rows else after, 'more_possible': len(rows) == limit}

    def status(self, cluster, digest):
        with self.lock:
            row = self.db.execute('SELECT epoch,state,error,attempts,retry_at FROM replica_jobs WHERE cluster=? AND digest=?', (cluster, digest)).fetchone()
            if row is None:
                raise KeyError('unknown_replication_job')
            copies = self.db.execute('SELECT node,checked_at FROM replica_receipts WHERE cluster=? AND digest=? AND epoch=? ORDER BY node', (cluster, digest, row[0])).fetchall()
            return {'epoch': row[0], 'state': row[1], 'error': row[2], 'attempts': row[3], 'retry_at': row[4], 'copies': copies, 'replicated': len(copies) == 3, 'consensus_committed': False}

    def run_batch(self, cluster, *, limit=16):
        if type(limit) is not int or not 1 <= limit <= 64:
            raise ValueError('invalid_replication_batch')
        with self.lock:
            if not self.process_lock.acquire():
                return {'busy': True, 'processed': 0}
            try:
                self._require_confirmed(cluster)
                placement = self.db.execute('SELECT epoch,members FROM replica_clusters WHERE id=?', (cluster,)).fetchone()
                if placement is None:
                    raise ValueError('unknown_cluster')
                epoch, members = placement[0], json.loads(placement[1])
                jobs = self.db.execute("SELECT digest,payload,attempts FROM replica_jobs WHERE cluster=? AND epoch=? AND state!='replicated' AND retry_at<=? ORDER BY digest LIMIT ?", (cluster, epoch, time.time(), limit)).fetchall()
                for digest, payload, attempts in jobs:
                    self._replicate(cluster, epoch, members, digest, payload, attempts)
                return {'busy': False, 'processed': len(jobs)}
            finally:
                self.process_lock.release()

    def _request(self, node, operation, payload):
        try:
            return exchange(self.endpoints[node], self.key, self.verifier, node, operation, payload)
        except HTTPError as exc:
            exc.close()
            return None
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def _replicate(self, cluster, epoch, members, digest, payload, attempts):
        # Fetch before writing; the journal can recover from surviving replicas
        # even when its local ciphertext cache is missing or corrupt.
        missing, unavailable = 0, 0
        sources = members + [row[0] for row in self.db.execute('SELECT node FROM replica_sources WHERE cluster=? ORDER BY node', (cluster,)) if row[0] not in members]
        if payload is None or sha256(payload).hexdigest() != digest:
            payload = None
            for node in sources:
                result = self._request(node, 'get', {'digest': digest})
                if result is None:
                    unavailable += 1
                elif result == {'error': 'not_found'}:
                    missing += 1
                else:
                    payload = bytes.fromhex(result['ciphertext'])
                    break
        verified = []
        if payload is not None:
            for node in members:
                put = self._request(node, 'put', {'digest': digest, 'ciphertext': payload.hex()})
                if put is not None:
                    read = self._request(node, 'get', {'digest': digest})
                    if read is not None and read.get('digest') == digest:
                        verified.append(node)
        state = 'replicated' if len(verified) == 3 else 'pending'
        error = None if state == 'replicated' else ('source_unavailable' if payload is None and unavailable else 'missing_on_known_replicas' if payload is None and missing == len(sources) else 'copies_incomplete')
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            current = self.db.execute('SELECT epoch FROM replica_clusters WHERE id=?', (cluster,)).fetchone()
            if current[0] != epoch:
                return  # A concurrent plan change cannot receive old-epoch receipts.
            self.db.execute('DELETE FROM replica_receipts WHERE cluster=? AND digest=? AND epoch=?', (cluster, digest, epoch))
            self.db.executemany('INSERT INTO replica_receipts VALUES (?,?,?,?,?)', [(cluster, digest, epoch, node, int(time.time())) for node in verified])
            self.db.execute('UPDATE replica_jobs SET payload=?,state=?,error=?,attempts=?,retry_at=? WHERE cluster=? AND digest=? AND epoch=?', (payload, state, error, min(attempts + 1, 30), 0 if state == 'replicated' else time.time() + min(30, 2 ** min(attempts + 1, 5)), cluster, digest, epoch))
