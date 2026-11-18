"""Bounded laboratory bridge from the durable replica journal to consensus indices."""
from hashlib import sha256
from pathlib import Path

from .consensus_directory import ConsensusDirectory, validate_address
from .directory import digest64
from .manifest_publisher import ManifestPublisher
from .storage import canonical


class ReplicaPublication:
    def __init__(self, state_directory, directory, address, journal):
        if not isinstance(directory, ConsensusDirectory) or directory.network != journal.verifier.network:
            raise ValueError('matching_verified_directory_required')
        validate_address(address)
        self.path = Path(state_directory).resolve()
        self.path.mkdir(parents=True, exist_ok=True)
        self.directory, self.address, self.journal = directory, address, journal

    def step(self, cluster, *, limit=64, expected_sizes=None):
        if not digest64(cluster):
            raise ValueError('invalid_publication_cluster')
        if type(limit) is not int or not 1 <= limit <= 64:
            raise ValueError('invalid_replication_batch')
        if expected_sizes is not None and (not isinstance(expected_sizes,dict) or not 1 <= len(expected_sizes) <= 512 or
                any(not digest64(digest) or type(size) is not int or not 1 <= size <= 262144 for digest,size in expected_sizes.items())):
            raise ValueError('invalid_publication_expected_sizes')
        # Refresh before replication; stale local receipts must never bypass an
        # epoch change. The placement controller applies the new epoch separately.
        self.directory.refresh(self.address)
        with self.directory.lock, self.journal.lock:
            self.directory.anchor()
            trust = self.journal.db.execute('SELECT pin FROM replica_trust').fetchone()
            if trust != (self.directory.pin,):
                return {'state': 'waiting', 'error': 'placement_trust_changed'}
            head = self.directory.placement(cluster)
            body = head['record']['body']
            local = self.journal.db.execute(
                'SELECT epoch,digest FROM replica_confirmations WHERE cluster=?', (cluster,)
            ).fetchone()
            if local != (body['epoch'], head['record_hash']):
                return {'state': 'waiting', 'error': 'placement_not_applied'}
            if self.journal.verifier.recipient not in body['members']:
                return {'state': 'waiting', 'error': 'manifest_current_holder_required'}
        self.journal.run_batch(cluster, limit=limit)
        with self.journal.lock:
            query = 'SELECT digest,payload,epoch,state FROM replica_jobs WHERE cluster=?'
            parameters = [cluster]
            if expected_sizes is not None:
                query += ' AND digest IN (' + ','.join('?' for _ in expected_sizes) + ')'
                parameters.extend(expected_sizes)
            rows = self.journal.db.execute(query+' ORDER BY digest LIMIT 513',parameters).fetchall()
            if expected_sizes is not None and len(rows) != len(expected_sizes):
                return {'state':'waiting','error':'publication_queue_coverage_incomplete'}
            if not rows:
                return {'state': 'idle', 'error': None}
            if len(rows) > 512:
                return {'state': 'waiting', 'error': 'publication_index_limit'}
            sizes = {}
            for digest, payload, epoch, state in rows:
                if epoch != body['epoch'] or state != 'replicated':
                    return {'state': 'replicating', 'error': None}
                if payload is None or not 1 <= len(payload) <= 262144 or sha256(payload).hexdigest() != digest:
                    return {'state': 'waiting', 'error': 'publication_payload_unverified'}
                sizes[digest] = len(payload)
                if expected_sizes is not None and expected_sizes[digest] != len(payload):
                    return {'state':'waiting','error':'publication_queued_size_mismatch'}
        # An immutable snapshot names its outbox deterministically. A restart
        # resumes the exact signed request; later staged data gets a new snapshot.
        request = sha256(canonical({'cluster': cluster, 'sizes': sizes})).hexdigest()
        publisher = ManifestPublisher(
            self.path / (request + '.sqlite'), self.directory, self.address,
            self.journal.key, self.journal.verifier, self.journal.endpoints,
            cluster=cluster, sizes=sizes,
        )
        try:
            status = publisher.step()
        finally:
            publisher.close()
        return {**status, 'blocks': len(sizes)}
