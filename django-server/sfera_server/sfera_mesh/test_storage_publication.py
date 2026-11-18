import sqlite3
from pathlib import Path
import unittest
from unittest.mock import patch

from . import test_publication
from .consensus_directory import ConsensusUnavailable
from .storage import Storage
from .storage_publication import StoragePublication
from .transport import BlobStore


class StoragePublicationTests(unittest.TestCase):
    def test_ordinary_worker_cannot_admit_pages_before_atomic_reservation(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        block = 'recovery-page:' + self.cluster + ':' + 'f' * 64
        self.append(block, b'page-ciphertext')
        submit, publish = Mock(), Mock()
        self.writer.queue = SimpleNamespace(content_bound=True, submit=submit, step=publish)
        result = self.writer.step(self.cluster)
        self.assertEqual(result['error'], 'atomic_page_reservation_required')
        submit.assert_not_called(); publish.assert_not_called()

    def test_atomic_reservation_stages_all_copies_before_one_queue_operation(self):
        from types import SimpleNamespace
        self.append('one', b'cipher-one'); self.append('two', b'cipher-two')
        calls = []
        def reserve(requests):
            for item in requests:
                self.assertEqual(self.base.journal.db.execute('SELECT state FROM replica_jobs WHERE digest=?',
                    (item['digest'],)).fetchone(), ('replicated',))
            calls.append(requests)
            return {'state': 'submitted'}
        self.writer.queue = SimpleNamespace(content_bound=True, reserve_many=reserve)
        with patch.object(self.base.journal, '_request', side_effect=self.base.request):
            result = self.writer.reserve_many(['one', 'two'])
        self.assertEqual(result['state'], 'submitted')
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(calls[0]), 2)
        self.assertEqual(self.base.fixture.state.get('write_queue', {}), {})

    def test_atomic_reservation_missing_copy_never_calls_queue(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        self.append('one', b'cipher-one'); self.append('two', b'cipher-two')
        reserve = Mock()
        self.writer.queue = SimpleNamespace(content_bound=True, reserve_many=reserve)
        with patch.object(self.base.journal, '_request', return_value=None):
            result = self.writer.reserve_many(['one', 'two'])
        self.assertEqual(result['error'], 'write_batch_copies_incomplete')
        reserve.assert_not_called()

    def setUp(self):
        base = test_publication.ReplicaPublicationTests()
        base.setUp()
        self.addCleanup(base.doCleanups)
        self.base = base
        base.owner.store.close()
        base.owner.store = BlobStore(':memory:', max_bytes=4096)
        self.addCleanup(base.owner.store.close)
        self.cluster = base.cluster
        self.root = Path(base.temp.name)
        self.storage = Storage(self.root / 'payloads.sqlite', self.root / 'index.sqlite')
        self.addCleanup(lambda: self.storage.close())
        with base.journal.db:
            base.journal.db.execute('DELETE FROM replica_jobs')
        self.writer = StoragePublication(self.storage, base.publication)

    def append(self, block='first', data=b'encrypted'):
        return self.writer.append('dialog', block, self.cluster, [data])

    def step(self, broadcast=None, limit=64):
        base = self.base
        with patch.object(base.journal, '_request', side_effect=base.request), \
             patch('sfera_mesh.manifest_publisher.exchange', side_effect=base.owner.consent), \
             patch('sfera_mesh.manifest_publisher.rpc', side_effect=broadcast or (lambda *args: {'code': 0})):
            return self.writer.step(self.cluster, limit=limit)

    def reopen(self):
        self.storage.close()
        self.storage = Storage(self.root / 'payloads.sqlite', self.root / 'index.sqlite')
        self.writer = StoragePublication(self.storage, self.base.worker())

    def confirm(self):
        import json
        from contextlib import closing
        records = []
        for path in self.base.publication.path.glob('*.sqlite'):
            with closing(sqlite3.connect(path)) as db:
                records.append(json.loads(db.execute('SELECT record FROM manifest_job').fetchone()[0]))
        self.base.confirm(max(records, key=lambda item: item['body']['version']))
        self.base.clear_backoff()

    def test_local_append_survives_restart_without_early_confirmation(self):
        result = self.append()
        self.assertFalse(result['consensus_committed'])
        self.assertEqual(self.base.journal.db.execute('SELECT COUNT(*) FROM replica_jobs').fetchone()[0], 0)
        self.reopen()
        self.assertEqual(self.step()['state'], 'submitted')
        self.assertFalse(self.writer.status('first')['consensus_committed'])
        self.assertEqual(self.storage.index.execute('SELECT state FROM publication_jobs').fetchone()[0], 'pending')
        self.confirm()
        self.assertEqual(self.step()['indexed'], 1)
        status = self.writer.status('first')
        self.assertTrue(status['consensus_committed'])
        self.assertEqual(status['manifest_version'], 1)
        self.assertIn('finality', status)
        self.reopen()
        self.assertEqual(self.step()['state'], 'idle')
        self.assertTrue(self.writer.status('first')['consensus_committed'])

    def test_queue_failure_rolls_back_index_and_retry_recovers_orphan(self):
        self.storage.index.execute("CREATE TRIGGER fail_queue BEFORE INSERT ON publication_jobs BEGIN SELECT RAISE(ABORT,'queue unavailable'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.append()
        self.assertEqual(self.storage.checkpoint('dialog')['blocks'], 0)
        self.assertEqual(self.storage.index.execute('SELECT COUNT(*) FROM blocks').fetchone()[0], 0)
        self.assertEqual(self.storage.payload.execute('SELECT COUNT(*) FROM payloads').fetchone()[0], 1)
        self.storage.index.execute('DROP TRIGGER fail_queue')
        self.reopen()
        self.append()
        self.assertEqual(self.storage.checkpoint('dialog')['blocks'], 1)
        self.assertEqual(self.storage.index.execute('SELECT COUNT(*) FROM publication_jobs').fetchone()[0], 1)

    def test_batch_status_uses_one_fresh_manifest_for_all_blocks(self):
        first = self.append('first', b'one')
        second = self.append('second', b'two')
        self.step()
        self.confirm()
        self.step()
        with patch.object(self.base.directory, 'refresh', wraps=self.base.directory.refresh) as refresh:
            receipts = self.writer.status_many(['first', 'second', 'missing'])
            refresh.assert_called_once()
        self.assertEqual(set(receipts), {'first', 'second'})
        self.assertTrue(all(value['consensus_committed'] for value in receipts.values()))
        self.assertEqual(receipts['first']['finality'], receipts['second']['finality'])
        from .storage import canonical
        sizes = {first['digest']: len(canonical([b'one'.hex()])), second['digest']: len(canonical([b'two'.hex()]))}
        self.writer.confirm_sizes(self.cluster, sizes)
        with patch.object(self.base.directory, 'refresh', wraps=self.base.directory.refresh) as refresh:
            proof = self.writer.confirm_clusters({self.cluster: sizes})
            refresh.assert_called_once()
        self.assertIn('finality', proof[self.cluster])
        with self.assertRaisesRegex(ValueError, 'not_confirmed'):
            self.writer.confirm_clusters({self.cluster: sizes, 'e' * 64: sizes})
        with self.assertRaisesRegex(ValueError, 'not_confirmed'):
            self.writer.confirm_sizes(self.cluster, {first['digest']: sizes[first['digest']] + 1})

    def test_exact_retry_preserves_history_and_conflicts_cannot_rewrite_it(self):
        first = self.append()
        checkpoint = self.storage.checkpoint('dialog')
        self.assertEqual(self.append(), first)
        for dialog, cluster, data in (('other', self.cluster, b'encrypted'), ('dialog', 'f' * 64, b'encrypted'), ('dialog', self.cluster, b'changed')):
            with self.assertRaisesRegex(ValueError, 'write_conflict'):
                self.writer.append(dialog, 'first', cluster, [data])
        self.assertEqual(self.storage.checkpoint('dialog'), checkpoint)
        self.assertEqual(self.storage.read('first'), (b'encrypted',))

    def test_lost_broadcast_reply_reopens_exact_outbox_then_confirms(self):
        self.append()
        def lost(*args):
            raise OSError('lost reply')
        self.assertEqual(self.step(lost)['state'], 'waiting')
        pending = self.base.pending()
        self.reopen()
        self.base.clear_backoff()
        with patch('sfera_mesh.manifest_publisher.exchange') as consents, \
             patch('sfera_mesh.manifest_publisher.rpc', return_value={'code': 0}):
            self.assertEqual(self.writer.step(self.cluster)['state'], 'submitted')
            consents.assert_not_called()
        self.assertEqual(self.base.pending(), pending)
        self.confirm()
        self.assertEqual(self.step()['indexed'], 1)

    def test_missing_local_payload_recovers_from_verified_replica(self):
        self.append()
        data = self.storage.payload.execute('SELECT data FROM payloads').fetchone()[0]
        digest = self.storage.index.execute('SELECT digest FROM blocks').fetchone()[0]
        self.base.owner.store.execute('put', {'digest': digest, 'ciphertext': data.hex()})
        with self.storage.payload:
            self.storage.payload.execute('DELETE FROM payloads')
        self.reopen()
        self.assertEqual(self.step()['state'], 'submitted')
        self.assertEqual(self.storage.read('first'), (b'encrypted',))

    def test_cached_queue_flag_and_stale_snapshot_never_prove_inclusion(self):
        self.append()
        with self.storage.index:
            self.storage.index.execute("UPDATE publication_jobs SET state='indexed'")
        self.assertFalse(self.writer.status('first')['consensus_committed'])
        with patch.object(self.base.directory, 'anchor', side_effect=ConsensusUnavailable('stale')):
            with self.assertRaises(ConsensusUnavailable):
                self.writer.status('first')
        with self.base.journal.db:
            self.base.journal.db.execute("UPDATE replica_trust SET pin='other'")
        with self.assertRaisesRegex(ValueError, 'trust_changed'):
            self.writer.status('first')

    def test_bounded_pages_publish_successive_versions_without_losing_jobs(self):
        self.append()
        self.append('second', b'more encrypted')
        self.assertEqual(self.step(limit=1)['blocks'], 1)
        self.confirm()
        self.assertEqual(self.step(limit=1)['indexed'], 1)
        self.assertEqual(self.step(limit=1)['blocks'], 2)
        self.confirm()
        self.assertEqual(self.step(limit=1)['indexed'], 1)
        self.assertTrue(self.writer.status('second')['consensus_committed'])
        self.assertTrue(self.writer.status('first')['consensus_committed'])

    def test_oversized_write_is_rejected_before_any_local_mutation(self):
        with self.assertRaisesRegex(ValueError, 'bounded_ciphertext'):
            self.append(data=b'x' * 131072)
        self.assertEqual(self.storage.checkpoint('dialog')['blocks'], 0)
        self.assertEqual(self.storage.payload.execute('SELECT COUNT(*) FROM payloads').fetchone()[0], 0)

    def test_missing_everywhere_keeps_durable_request_pending(self):
        self.append()
        with self.storage.payload:
            self.storage.payload.execute('DELETE FROM payloads')
        with patch.object(self.base.journal, '_request', return_value={'error': 'not_found'}):
            self.assertEqual(self.writer.step(self.cluster)['state'], 'replicating')
        self.assertFalse(self.writer.status('first')['consensus_committed'])
        self.assertEqual(self.storage.index.execute('SELECT state FROM publication_jobs').fetchone()[0], 'pending')

    def test_unsized_manifest_and_wrong_size_cannot_confirm_local_write(self):
        import copy
        self.append()
        self.step()
        record = self.base.pending()
        wrong = copy.deepcopy(record)
        wrong['body']['sizes'][0] += 1
        self.base.confirm(wrong)
        self.assertFalse(self.writer.status('first')['consensus_committed'])
        del wrong['body']['sizes']
        self.base.confirm(wrong)
        self.assertFalse(self.writer.status('first')['consensus_committed'])
