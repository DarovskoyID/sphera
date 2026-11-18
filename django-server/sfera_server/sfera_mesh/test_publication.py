from hashlib import sha256
from contextlib import closing
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from . import test_manifest_publisher
from .publication import ReplicaPublication
from .replication import ReplicaJournal
from .storage import canonical


class ReplicaPublicationTests(unittest.TestCase):
    def setUp(self):
        owner = test_manifest_publisher.ManifestPublisherTests()
        owner.setUp()
        self.addCleanup(owner.doCleanups)
        self.owner = owner
        self.fixture, self.directory = owner.fixture, owner.directory
        self.cluster = self.fixture.cluster
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.journal = ReplicaJournal(
            Path(self.temp.name) / 'replicas.sqlite', owner.key, owner.verifier,
            self.fixture.journal.endpoints, require_consensus=True,
        )
        self.addCleanup(self.journal.close)
        head = self.directory.placement(self.cluster)
        with self.journal.db:
            self.journal.db.execute('INSERT INTO replica_trust VALUES(1,?)', (self.directory.pin,))
            self.journal.db.execute('INSERT INTO replica_clusters VALUES(?,?,?)',
                                    (self.cluster, 1, canonical(head['record']['body']['members'])))
            self.journal.db.execute('INSERT INTO replica_confirmations VALUES(?,?,?,?)',
                                    (self.cluster, 1, head['record_hash'], 1))
        self.publication = self.worker()
        self.digest = self.journal.stage(self.cluster, b'abcd')

    def worker(self):
        return ReplicaPublication(Path(self.temp.name) / 'publication', self.directory,
                                  'http://127.0.0.1:9999', self.journal)

    def request(self, target, operation, payload):
        if operation == 'put':
            return self.owner.store.execute('put', payload)
        return self.owner.store.execute('get', payload)

    def step(self, broadcast=None):
        with patch.object(self.journal, '_request', side_effect=self.request), \
             patch('sfera_mesh.manifest_publisher.exchange', side_effect=self.owner.consent), \
             patch('sfera_mesh.manifest_publisher.rpc', side_effect=broadcast or (lambda *args: {'code': 0})):
            return self.publication.step(self.cluster)

    def pending(self):
        import sqlite3
        paths = list(self.publication.path.glob('*.sqlite'))
        with closing(sqlite3.connect(paths[-1])) as db:
            record = json.loads(db.execute('SELECT record FROM manifest_job').fetchone()[0])
        return record

    def confirm(self, record):
        self.fixture.state['manifests'] = {
            self.cluster: {'record': record, 'digest': sha256(canonical(record)).hexdigest()}
        }

    def clear_backoff(self):
        import sqlite3
        for path in self.publication.path.glob('*.sqlite'):
            with closing(sqlite3.connect(path)) as db, db:
                db.execute('UPDATE manifest_job SET retry_at=0')

    def test_replication_then_outbox_restart_then_verified_confirmation(self):
        def lost(*args):
            raise OSError('lost response')
        self.assertEqual(self.step(lost)['state'], 'waiting')
        record = self.pending()
        self.assertEqual(record['body']['sizes'], [4])
        self.publication = self.worker()
        self.clear_backoff()
        with patch('sfera_mesh.manifest_publisher.exchange') as consents:
            with patch('sfera_mesh.manifest_publisher.rpc', return_value={'code': 0}):
                self.assertEqual(self.publication.step(self.cluster)['state'], 'submitted')
            consents.assert_not_called()
        self.confirm(record)
        self.clear_backoff()
        self.assertEqual(self.step()['state'], 'confirmed')

    def test_new_staged_blocks_get_next_snapshot_and_preserve_previous(self):
        self.step()
        self.confirm(self.pending())
        self.clear_backoff()
        self.assertEqual(self.step()['state'], 'confirmed')
        extra = self.journal.stage(self.cluster, b'xy')
        self.assertEqual(self.step()['state'], 'submitted')
        import sqlite3
        records = []
        for path in self.publication.path.glob('*.sqlite'):
            with closing(sqlite3.connect(path)) as db:
                records.append(json.loads(db.execute('SELECT record FROM manifest_job').fetchone()[0]))
        latest = max(records, key=lambda r: r['body']['version'])
        self.assertEqual(latest['body']['version'], 2)
        self.assertEqual(set(latest['body']['digests']), {self.digest, extra})

    def test_incomplete_copies_do_not_create_publication(self):
        with patch.object(self.journal, '_request', return_value=None):
            self.assertEqual(self.publication.step(self.cluster)['state'], 'replicating')
        self.assertEqual(list(self.publication.path.glob('*.sqlite')), [])

    def test_epoch_change_blocks_old_receipts_before_network_writes(self):
        self.fixture.state['placements'][self.cluster]['digest'] = 'f' * 64
        with patch.object(self.journal, '_request') as requests:
            self.assertEqual(self.publication.step(self.cluster)['error'], 'placement_not_applied')
            requests.assert_not_called()

    def test_corrupt_cached_payload_cannot_be_published(self):
        self.step()
        with self.journal.db:
            self.journal.db.execute('UPDATE replica_jobs SET payload=?', (b'wrong',))
        self.assertEqual(self.step()['error'], 'publication_payload_unverified')

    def test_trust_change_and_nonholder_block_before_replication(self):
        with self.journal.db:
            self.journal.db.execute("UPDATE replica_trust SET pin='other-genesis'")
        with patch.object(self.journal, 'run_batch') as replicate:
            self.assertEqual(self.publication.step(self.cluster)['error'], 'placement_trust_changed')
            replicate.assert_not_called()
        with self.journal.db:
            self.journal.db.execute('UPDATE replica_trust SET pin=?', (self.directory.pin,))
        with patch.object(self.journal.verifier, 'recipient', 'a' * 64), \
             patch.object(self.journal, 'run_batch') as replicate:
            self.assertEqual(self.publication.step(self.cluster)['error'], 'manifest_current_holder_required')
            replicate.assert_not_called()

    def test_corrupt_source_is_skipped_and_lying_read_has_no_receipt(self):
        with self.journal.db:
            self.journal.db.execute('UPDATE replica_jobs SET payload=NULL')
        members = json.loads(self.journal.db.execute('SELECT members FROM replica_clusters').fetchone()[0])
        def request(target, operation, payload):
            if operation == 'get' and target == members[0]:
                return {'digest': self.digest, 'ciphertext': b'wrong'.hex()}
            return self.request(target, operation, payload)
        with patch.object(self.journal, '_request', side_effect=request):
            self.assertEqual(self.publication.step(self.cluster)['state'], 'replicating')
        status = self.journal.status(self.cluster, self.digest)
        self.assertEqual(len(status['copies']), 2)
        self.assertNotIn(members[0], [node for node, _ in status['copies']])

    def test_bound_rejects_oversized_index_and_invalid_limit(self):
        for i in range(512):
            self.journal.stage(self.cluster, str(i).encode())
        with patch.object(self.journal, 'run_batch'):
            self.assertEqual(self.publication.step(self.cluster)['error'], 'publication_index_limit')
        with self.assertRaises(ValueError):
            self.publication.step(self.cluster, limit=True)
