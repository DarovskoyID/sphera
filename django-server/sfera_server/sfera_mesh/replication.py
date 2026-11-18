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
from .transport import exchange,validate_peer_endpoint


class ReplicaJournal:
    def __init__(self, path, key, verifier, endpoints, *, require_consensus=False, reserve_preparation=False, discovery_directory=None,discovery_https=False,tls_context=None):
        if type(discovery_https) is not bool or discovery_https and discovery_directory is None or tls_context is not None and not discovery_https:raise ValueError('explicit_https_discovery_required')
        self.discovery_https,self.tls_context=discovery_https,tls_context
        if discovery_directory is not None and (not isinstance(discovery_directory,ConsensusDirectory) or not require_consensus or discovery_directory.network!=verifier.network):
            raise ValueError('verified_discovery_directory_required')
        self.discovery_directory=discovery_directory
        self.discovery_expiry=0
        self.peer_expiry={}
        self.owns_verifier=False
        if type(reserve_preparation) is not bool: raise ValueError('invalid_preparation_reservation_mode')
        if type(require_consensus) is not bool:
            raise ValueError('invalid_replication_mode')
        minimum=0 if discovery_directory is not None and require_consensus else 3
        if not minimum <= len(endpoints) <= 64 or any(not digest64(node) or node not in verifier.roster for node in endpoints):
            raise ValueError('explicit_replica_roster_required')
        for peer,endpoint in endpoints.items():
            validate_peer_endpoint(verifier,peer,endpoint)
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
            CREATE TABLE IF NOT EXISTS replica_growth_budgets(cluster TEXT PRIMARY KEY,budget TEXT NOT NULL,placement TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS replica_confirmations (cluster TEXT PRIMARY KEY, epoch INTEGER, digest TEXT NOT NULL, height INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS replica_jobs (cluster TEXT NOT NULL, digest TEXT NOT NULL, payload BLOB, epoch INTEGER NOT NULL, retry_at REAL NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending', error TEXT, PRIMARY KEY(cluster,digest));
            CREATE INDEX IF NOT EXISTS pending_replica_jobs ON replica_jobs(cluster,state,retry_at);
            CREATE TABLE IF NOT EXISTS replica_preparations(cluster TEXT NOT NULL,plan TEXT NOT NULL,digest TEXT NOT NULL,target TEXT NOT NULL,checked_at REAL NOT NULL,PRIMARY KEY(cluster,plan,digest,target));
            CREATE TABLE IF NOT EXISTS replica_receipts (cluster TEXT, digest TEXT, epoch INTEGER, node TEXT, checked_at INTEGER NOT NULL, PRIMARY KEY(cluster,digest,epoch,node));
            CREATE TABLE IF NOT EXISTS replica_transfer_completions(cluster TEXT NOT NULL,epoch INTEGER NOT NULL,placement_hash TEXT NOT NULL,manifest_hash TEXT NOT NULL,report BLOB NOT NULL,PRIMARY KEY(cluster,epoch,placement_hash,manifest_hash));
            CREATE TABLE IF NOT EXISTS replica_preparation_reservations(singleton INTEGER PRIMARY KEY CHECK(singleton=1));
            CREATE TABLE IF NOT EXISTS replica_reservation_outbox(cluster TEXT NOT NULL,plan TEXT NOT NULL,digest TEXT NOT NULL,target TEXT NOT NULL,proposal BLOB NOT NULL,epoch INTEGER NOT NULL,retry_at REAL NOT NULL DEFAULT 0,PRIMARY KEY(cluster,plan,digest,target));
        ''')
        context = canonical({'network': verifier.network, 'node': identity, 'roster': {node: public.hex() for node, public in verifier.roster.items()}})
        if getattr(verifier,'secure_transport',None) is not None:
            context=canonical({'network':verifier.network,'node':identity,'roster':{node:public.hex() for node,public in verifier.roster.items()},'https_endpoints':dict(endpoints)})
        if discovery_directory is not None:
            context=canonical({'network':verifier.network,'node':identity,'discovery_genesis':discovery_directory.pin})
            if discovery_https:context=canonical({'network':verifier.network,'node':identity,'discovery_genesis':discovery_directory.pin,'endpoint_policy':'https-v1'})
        try:
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                old = self.db.execute('SELECT context FROM replica_identity').fetchone()
                if old and old[0] != context:
                    raise ValueError('replica_journal_context_changed')
                self.db.execute('INSERT OR IGNORE INTO replica_identity VALUES (1,?)', (context,))
                if require_consensus:
                    self.db.execute('INSERT OR IGNORE INTO replica_required VALUES (1)')
                if reserve_preparation:
                    self.db.execute('INSERT OR IGNORE INTO replica_preparation_reservations VALUES(1)')
        except Exception:
            self.db.close()
            raise

    @classmethod
    def from_discovery(cls,path,key,directory,bootstrap_rpc,replay_path,*,reserve_preparation=False,https_only=False,tls_context=None,stop_event=None):
        """Bootstrap from a few data sources; peers/keys come from verified BFT state."""
        from .discovery import discovered_peers
        from .identity import EnvelopeVerifier
        if not isinstance(directory,ConsensusDirectory) or not isinstance(bootstrap_rpc,(list,tuple)) or not 1<=len(bootstrap_rpc)<=8:
            raise ValueError('explicit_discovery_bootstrap_required')
        if str(path)!=':memory:' and Path(path).resolve()==Path(replay_path).resolve():
            raise ValueError('separate_discovery_state_required')
        for address in bootstrap_rpc:validate_address(address)
        last=None
        for address in bootstrap_rpc:
            if stop_event is not None and stop_event.is_set():raise ValueError('discovery_bootstrap_stopped')
            try:
                if stop_event is None:directory.refresh(address)
                else:directory.refresh(address,stop_event=stop_event)
                break
            except (ValueError,OSError) as error:last=error
        else:raise ValueError('discovery_bootstrap_unavailable') from last
        snapshot=discovered_peers(directory,https_only=https_only)
        peers=snapshot['peers']
        roster={node:bytes.fromhex(peer['public_key']) for node,peer in peers.items()}
        identity=node_id(key.public_key().public_bytes_raw())
        roster[identity]=key.public_key().public_bytes_raw()
        verifier=EnvelopeVerifier(directory.network,identity,roster,replay_path)
        result=None
        try:
            if https_only:
                from .public_transport import ConfiguredHttpsTransport
                verifier.secure_transport=ConfiguredHttpsTransport({node:peer['endpoint'] for node,peer in peers.items()},context=tls_context)
            result=cls(path,key,verifier,{node:peer['endpoint'] for node,peer in peers.items()},require_consensus=True,reserve_preparation=reserve_preparation,discovery_directory=directory,discovery_https=https_only,tls_context=tls_context)
            result.owns_verifier=True
            result.refresh_discovery()
            return result
        except BaseException:
            if result is not None:result.close()
            else:verifier.close()
            raise

    def refresh_discovery(self):
        if self.discovery_directory is None:return
        from .discovery import discovered_peers
        snapshot=discovered_peers(self.discovery_directory,https_only=self.discovery_https)
        peers=snapshot['peers']
        if len(peers)>64:raise ValueError('discovered_replica_limit')
        with self.lock:
            self.endpoints={node:peer['endpoint'] for node,peer in peers.items()}
            self.peer_expiry={node:peer['expires_at'] for node,peer in peers.items()}
            self.discovery_expiry=snapshot['finality']['expires_at']
            # A node ID permanently binds its key; retain known keys for replies
            # already in flight, but never retain an expired address for routing.
            self.verifier.roster.update({node:bytes.fromhex(peer['public_key']) for node,peer in peers.items()})
            if self.discovery_https:
                from .public_transport import ConfiguredHttpsTransport
                self.verifier.secure_transport=ConfiguredHttpsTransport(self.endpoints,context=self.tls_context)

    def close(self):
        with self.lock:
            self.db.close()
            if self.owns_verifier:self.verifier.close()

    def _memberships(self, node):
        return frozenset(cluster for cluster, members in self.db.execute('SELECT id,members FROM replica_clusters') if node in json.loads(members))

    def _operator_only(self):
        if self.db.execute('SELECT 1 FROM replica_trust').fetchone() or self.db.execute('SELECT 1 FROM replica_required').fetchone():
            raise ValueError('consensus_placement_required')

    def use_growth_budget(self,directory,cluster,budget):
        if not isinstance(directory,ConsensusDirectory) or directory.network!=self.verifier.network or not digest64(budget):
            raise ValueError('verified_growth_budget_required')
        with directory.lock,self.lock,self.db:
            directory.anchor()
            state=directory.current['state']
            grant=state.get('growth_grants',{}).get(budget)
            placement=state.get('placements',{}).get(cluster)
            if grant is None or placement is None or grant['record']['body']['cluster']!=cluster or grant['record']['body']['placement_hash']!=placement['digest']:
                raise ValueError('current_consensus_growth_grant_required')
            self.db.execute('BEGIN IMMEDIATE')
            if self.db.execute('SELECT pin FROM replica_trust').fetchone()!=(directory.pin,):raise ValueError('placement_trust_changed')
            self.db.execute('INSERT OR REPLACE INTO replica_growth_budgets VALUES(?,?,?)',(cluster,budget,placement['digest']))

    def _require_confirmed(self, cluster):
        if (self.db.execute('SELECT 1 FROM replica_trust').fetchone() or self.db.execute('SELECT 1 FROM replica_required').fetchone()) and not self.db.execute('SELECT 1 FROM replica_confirmations WHERE cluster=?', (cluster,)).fetchone():
            raise ValueError('cluster_not_confirmed')

    def apply_confirmed_placement(self, directory, cluster, profiles):
        self.refresh_discovery()
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
            if getattr(directory, 'placement_assessors', None):
                # Consensus policy already selected this composition at its
                # acceptance time. Re-ranking today's registry can contradict
                # both admissible initial triples and historical replacements.
                if any(not prepared[node].grant_verified for node in body['members']):
                    raise ValueError('confirmed_placement_unverified_profile')
            elif body['epoch'] > 1:
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

    def enqueue_confirmed_manifest(self,directory,cluster):
        if not isinstance(directory,ConsensusDirectory) or directory.network!=self.verifier.network:
            raise ValueError('matching_verified_directory_required')
        with directory.lock:
            manifest=directory.manifest(cluster)
            for digest in manifest['record']['body']['digests']:
                self._stage_digest(cluster,digest,None)
            return manifest['digest']

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

    def transfer_status(self, directory, cluster):
        """Local durable audit of reads, not a consensus or permanent-storage proof."""
        if not isinstance(directory, ConsensusDirectory) or directory.network != self.verifier.network:
            raise ValueError('matching_verified_directory_required')
        with directory.lock, self.lock, self.db:
            confirmed = directory.placement(cluster)
            manifest = directory.manifest(cluster)
            body = confirmed['record']['body']
            self.db.execute('BEGIN IMMEDIATE')
            local = self.db.execute('SELECT epoch,digest FROM replica_confirmations WHERE cluster=?', (cluster,)).fetchone()
            if local != (body['epoch'], confirmed['record_hash']):
                return {'complete': False, 'reason': 'placement_not_applied'}
            expected = set(manifest['record']['body']['digests'])
            jobs = {digest: (epoch, state) for digest, epoch, state in self.db.execute('SELECT digest,epoch,state FROM replica_jobs WHERE cluster=?', (cluster,))}
            if set(jobs) != expected:
                return {'complete': False, 'reason': 'manifest_coverage_incomplete'}
            receipts = []
            for digest in sorted(expected):
                copies = self.db.execute('SELECT node,checked_at FROM replica_receipts WHERE cluster=? AND digest=? AND epoch=? ORDER BY node', (cluster,digest,body['epoch'])).fetchall()
                if jobs[digest] != (body['epoch'], 'replicated') or [node for node, _ in copies] != body['members']:
                    self.db.execute("UPDATE replica_jobs SET state='pending',retry_at=0,error='transfer_receipts_incomplete' WHERE cluster=? AND digest=?", (cluster,digest))
                    return {'complete': False, 'reason': 'current_epoch_receipts_incomplete'}
                receipts.append({'digest': digest, 'copies': [list(copy) for copy in copies]})
            report = {'domain': 'sfera-mesh-local-transfer-v1', 'network': directory.network,
                      'cluster': cluster, 'epoch': body['epoch'], 'placement_hash': confirmed['record_hash'],
                      'manifest_hash': manifest['digest'], 'members': body['members'],
                      'receipts': receipts, 'completed_at': int(time.time())}
            self.db.execute('INSERT OR IGNORE INTO replica_transfer_completions VALUES(?,?,?,?,?)',
                            (cluster, body['epoch'], confirmed['record_hash'], manifest['digest'], canonical(report)))
            return {'complete': True, 'placement_hash': confirmed['record_hash'], 'manifest_hash': manifest['digest']}

    def transfer_history(self, cluster):
        """Historical local observations; reading them does not establish readiness."""
        with self.lock:
            return [json.loads(row[0]) for row in self.db.execute('SELECT report FROM replica_transfer_completions WHERE cluster=? ORDER BY epoch,manifest_hash', (cluster,))]

    def prepare_replacement(self, directory, proposal, *, limit=16):
        """Warm a non-voting target from the committed index in policy mode.

        Legacy mode uses the local manifest. Unindexed product data is not
        covered by this readiness check. Membership/confirmation and
        current-epoch receipts remain unchanged until consensus confirms.
        """
        from .replacement import replacement_proposal
        self.refresh_discovery()
        if type(limit) is not int or not 1 <= limit <= 64:
            raise ValueError('invalid_preparation_batch')
        with directory.lock:
            cluster = proposal['body']['cluster']
            if canonical(replacement_proposal(directory,cluster)) != canonical(proposal):
                raise ValueError('preparation_plan_changed')
            confirmed = directory.placement(cluster)
            old_members = confirmed['record']['body']['members']
            targets = set(proposal['body']['members'])-set(old_members)
            if len(targets)!=1 or not targets.issubset(self.endpoints):
                raise ValueError('one_pinned_preparation_target_required')
            target = next(iter(targets))
            if directory.placement_assessors:
                manifest=directory.manifest(cluster)
                committed=set(manifest['record']['body']['digests'])
                index=manifest['record']['body']
                confirmed_sizes=dict(zip(index['digests'],index['sizes'])) if index['domain']=='sfera-mesh-manifest-v2' else None
                manifest_hash=self.enqueue_confirmed_manifest(directory,cluster)
            else:
                committed=None
                manifest_hash=None
                confirmed_sizes=None
            plan = sha256(canonical({'proposal':proposal,'manifest':manifest_hash})).hexdigest()
        with self.lock:
            if not self.process_lock.acquire():
                return {'ready':False,'reason':'replica_worker_busy'}
            try:
                self._require_confirmed(cluster)
                current = self.db.execute('SELECT epoch FROM replica_clusters WHERE id=?',(cluster,)).fetchone()
                if current is None or current[0]!=confirmed['record']['body']['epoch']:
                    raise ValueError('preparation_journal_epoch_changed')
                if committed is not None:
                    known={row[0] for row in self.db.execute('SELECT digest FROM replica_jobs WHERE cluster=?',(cluster,))}
                    if not known.issubset(committed):
                        return {'ready':False,'reason':'unconfirmed_manifest_entries'}
                reserve_mode=self.db.execute('SELECT 1 FROM replica_preparation_reservations').fetchone() is not None
                if reserve_mode:
                    if committed is None or proposal['body']['domain']!='sfera-mesh-placement-v3':
                        raise ValueError('indexed_preparation_reservation_required')
                    indexed=self.db.execute('SELECT digest,payload FROM replica_jobs WHERE cluster=? ORDER BY digest',(cluster,)).fetchall()
                    blocks={}; fetched=0
                    for digest,payload in indexed:
                        if confirmed_sizes is not None:
                            blocks[digest]=confirmed_sizes[digest]
                            continue
                        if payload is None or sha256(payload).hexdigest()!=digest:
                            if fetched>=limit: return {'ready':False,'reason':'preparation_reservation_preflight'}
                            fetched+=1; payload=None
                            for source in old_members:
                                result=self._request(source,'get',{'digest':digest})
                                if result is not None and 'ciphertext' in result:
                                    data=bytes.fromhex(result['ciphertext'])
                                    if sha256(data).hexdigest()==digest:
                                        payload=data; break
                            if payload is None: return {'ready':False,'reason':'preparation_source_unavailable'}
                            with self.db: self.db.execute('UPDATE replica_jobs SET payload=? WHERE cluster=? AND digest=?',(payload,cluster,digest))
                        blocks[digest]=len(payload)
                    if blocks:
                        with self.db:
                            self.db.executemany('INSERT OR IGNORE INTO replica_reservation_outbox(cluster,plan,digest,target,proposal,epoch) VALUES(?,?,?,?,?,?)',[(cluster,plan,digest,target,canonical(proposal),proposal['body']['epoch']) for digest in blocks])
                            if self.db.execute('SELECT COUNT(*) FROM replica_reservation_outbox').fetchone()[0]>512:
                                raise ValueError('preparation_reservation_outbox_limit')
                        if self._request(target,'placement-reserve',{'proposal':proposal,'blocks':blocks}) is None:
                            return {'ready':False,'reason':'preparation_reservation_unavailable'}
                with self.db:
                    self.db.execute('DELETE FROM replica_preparations WHERE cluster=? AND plan!=?',(cluster,plan))
                cutoff = time.time()-10
                jobs = self.db.execute('''SELECT j.digest,j.payload FROM replica_jobs j
                    LEFT JOIN replica_preparations p ON p.cluster=j.cluster AND p.plan=? AND p.digest=j.digest AND p.target=?
                    WHERE j.cluster=? AND (p.checked_at IS NULL OR p.checked_at<?)
                    ORDER BY j.digest LIMIT ?''',(plan,target,cluster,cutoff,limit)).fetchall()
                for digest,payload in jobs:
                    existing = self._request(target,'get',{'digest':digest})
                    if existing is None or 'ciphertext' not in existing:
                        if payload is None or sha256(payload).hexdigest()!=digest:
                            payload = None
                            for source in old_members:
                                result = self._request(source,'get',{'digest':digest})
                                if result is not None and 'ciphertext' in result:
                                    data=bytes.fromhex(result['ciphertext'])
                                    if sha256(data).hexdigest()==digest:
                                        payload=data; break
                        if payload is None:
                            return {'ready':False,'reason':'preparation_source_unavailable'}
                        if confirmed_sizes is not None and len(payload)!=confirmed_sizes[digest]:
                            return {'ready':False,'reason':'preparation_committed_size_mismatch'}
                        if self._request(target,'put',{'digest':digest,'ciphertext':payload.hex()}) is None:
                            return {'ready':False,'reason':'preparation_target_unavailable'}
                        existing=self._request(target,'get',{'digest':digest})
                    if existing is None or 'ciphertext' not in existing or sha256(bytes.fromhex(existing['ciphertext'])).hexdigest()!=digest:
                        return {'ready':False,'reason':'preparation_copy_unverified'}
                    if confirmed_sizes is not None and len(bytes.fromhex(existing['ciphertext']))!=confirmed_sizes[digest]:
                        return {'ready':False,'reason':'preparation_committed_size_mismatch'}
                    with self.db:
                        self.db.execute('INSERT OR REPLACE INTO replica_preparations VALUES(?,?,?,?,?)',(cluster,plan,digest,target,time.time()))
                        self.db.execute('DELETE FROM replica_reservation_outbox WHERE cluster=? AND plan=? AND digest=? AND target=?',(cluster,plan,digest,target))
                pending=self.db.execute('''SELECT COUNT(*) FROM replica_jobs j LEFT JOIN replica_preparations p
                    ON p.cluster=j.cluster AND p.plan=? AND p.digest=j.digest AND p.target=?
                    WHERE j.cluster=? AND (p.checked_at IS NULL OR p.checked_at<?)''',(plan,target,cluster,time.time()-10)).fetchone()[0]
                return {'ready':pending==0,'remaining':pending,'target':target,'plan':plan}
            finally:
                self.process_lock.release()

    def release_preparation_reservations(self,directory,*,limit=8):
        """Release after finality invalidates the old plan, never on local time."""
        from .replacement import reservation_license_expired
        self.refresh_discovery()
        from .manifest_ancestry import ancestor_proof
        if type(limit) is not int or not 1<=limit<=8: raise ValueError('invalid_reservation_cleanup_limit')
        with directory.lock:
            directory.anchor()
            epochs={cluster:head['record']['body']['epoch'] for cluster,head in directory.current['state'].get('placements',{}).items()}
            manifests={cluster:dict(head['record']['body']) for cluster,head in directory.current['state'].get('manifests',{}).items()}
            block_time=directory.current['state']['block_time']
            lineage_state=json.loads(canonical(directory.current['state']))
        with self.lock:
            if not self.process_lock.acquire(): return {'released':0,'busy':True}
            try:
                rows=self.db.execute('SELECT cluster,plan,digest,target,proposal,epoch FROM replica_reservation_outbox WHERE retry_at<=? ORDER BY cluster,plan,digest,target',(time.time(),)).fetchall()
                released=0; attempted=0
                for cluster,plan,digest,target,proposal,epoch in rows:
                    packet=json.loads(proposal)
                    successor=manifests.get(cluster,{})
                    superseded=(epochs.get(cluster,0)==epoch-1 and successor.get('epoch')==epoch-1 and
                                successor.get('placement_hash')==packet['body']['previous'] and
                                successor.get('previous')==packet['body']['manifest_hash'])
                    ancestry=None
                    if not superseded and epochs.get(cluster,0)==epoch-1 and successor.get('epoch')==epoch-1 and successor.get('placement_hash')==packet['body']['previous']:
                        try:
                            ancestry=ancestor_proof(lineage_state,directory.network,cluster,packet['body']['manifest_hash'])
                            superseded=True
                        except ValueError:
                            pass
                    if epochs.get(cluster,0)<epoch and not superseded and not reservation_license_expired(packet,block_time): continue
                    if attempted>=limit: break
                    attempted+=1
                    payload={'proposal':packet,'digests':[digest]}
                    if ancestry is not None: payload['ancestry']=ancestry
                    result=self._request(target,'placement-release',payload)
                    with self.db:
                        if result is not None:
                            self.db.execute('DELETE FROM replica_reservation_outbox WHERE cluster=? AND plan=? AND digest=? AND target=?',(cluster,plan,digest,target))
                            released+=1
                        else:
                            self.db.execute('UPDATE replica_reservation_outbox SET retry_at=? WHERE cluster=? AND plan=? AND digest=? AND target=?',(time.time()+30,cluster,plan,digest,target))
                return {'released':released,'pending':self.db.execute('SELECT COUNT(*) FROM replica_reservation_outbox').fetchone()[0]}
            finally: self.process_lock.release()

    def schedule_recheck(self,cluster,*,min_age=30,limit=4):
        """Bounded renewal of actual copy receipts, never placement finality."""
        if type(min_age) is not int or not 30<=min_age<=3600 or type(limit) is not int or not 1<=limit<=8:raise ValueError('bounded_replica_recheck_required')
        with self.lock,self.db:
            self.db.execute('BEGIN IMMEDIATE')
            if not self.db.execute('SELECT 1 FROM replica_required').fetchone():raise ValueError('consensus_placement_required')
            self._require_confirmed(cluster)
            rows=self.db.execute('''SELECT j.digest FROM replica_jobs j LEFT JOIN
                (SELECT cluster,digest,epoch,MIN(checked_at) AS checked FROM replica_receipts GROUP BY cluster,digest,epoch) r
                ON r.cluster=j.cluster AND r.digest=j.digest AND r.epoch=j.epoch
                WHERE j.cluster=? AND j.state='replicated' AND COALESCE(r.checked,0)<=?
                ORDER BY COALESCE(r.checked,0),j.digest LIMIT ?''',(cluster,time.time()-min_age,limit)).fetchall()
            self.db.executemany("UPDATE replica_jobs SET state='pending',retry_at=0 WHERE cluster=? AND digest=?",[(cluster,row[0]) for row in rows])
            return len(rows)

    def run_batch(self, cluster, *, limit=16,stop_event=None):
        self.refresh_discovery()
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
                processed=0
                for digest, payload, attempts in jobs:
                    if stop_event is not None and stop_event.is_set():break
                    self._replicate(cluster, epoch, members, digest, payload, attempts,stop_event=stop_event)
                    processed+=1
                return {'busy': False, 'processed': processed}
            finally:
                self.process_lock.release()

    def _request(self, node, operation, payload):
        try:
            if self.discovery_directory is not None and (time.time()>=self.discovery_expiry or time.time()>=self.peer_expiry.get(node,0)):
                raise ValueError('discovery_address_or_anchor_expired')
            return exchange(self.endpoints[node], self.key, self.verifier, node, operation, payload)
        except HTTPError as exc:
            exc.close()
            return None
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def _replicate(self, cluster, epoch, members, digest, payload, attempts,*,stop_event=None):
        # Fetch before writing; the journal can recover from surviving replicas
        # even when its local ciphertext cache is missing or corrupt.
        missing, unavailable = 0, 0
        sources = members + [row[0] for row in self.db.execute('SELECT node FROM replica_sources WHERE cluster=? ORDER BY node', (cluster,)) if row[0] not in members]
        if payload is None or sha256(payload).hexdigest() != digest:
            payload = None
            for node in sources:
                if stop_event is not None and stop_event.is_set():return
                result = self._request(node, 'get', {'digest': digest})
                if result is None:
                    unavailable += 1
                elif result == {'error': 'not_found'}:
                    missing += 1
                else:
                    try:
                        candidate = bytes.fromhex(result['ciphertext'])
                        if not 1 <= len(candidate) <= 262144 or sha256(candidate).hexdigest() != digest:
                            continue
                        payload = candidate
                        break
                    except (KeyError, TypeError, ValueError):
                        continue
        verified = []
        if payload is not None:
            write={'digest':digest,'ciphertext':payload.hex()}
            growth=self.db.execute('SELECT budget,placement FROM replica_growth_budgets WHERE cluster=?',(cluster,)).fetchone()
            if growth:
                confirmed=self.db.execute('SELECT digest FROM replica_confirmations WHERE cluster=?',(cluster,)).fetchone()
                if confirmed!=(growth[1],):
                    with self.db:self.db.execute("UPDATE replica_jobs SET error='growth_budget_placement_changed',retry_at=? WHERE cluster=? AND digest=?",(time.time()+5,cluster,digest))
                    return
                write['growth']={'cluster':cluster,'budget':growth[0]}
            for node in members:
                if stop_event is not None and stop_event.is_set():return
                put = self._request(node, 'put', write)
                if put is not None:
                    if stop_event is not None and stop_event.is_set():return
                    read = self._request(node, 'get', {'digest': digest})
                    if read is not None and read.get('digest') == digest:
                        try:
                            copied = bytes.fromhex(read['ciphertext'])
                            if copied == payload and sha256(copied).hexdigest() == digest:
                                verified.append(node)
                        except (KeyError, TypeError, ValueError):
                            continue
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
