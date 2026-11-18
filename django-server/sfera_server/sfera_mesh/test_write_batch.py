import base64
from hashlib import sha256
import json
import itertools
import time
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from . import test_write_queue as queue_fixture
from .storage import canonical
from .write_queue import ConsensusWriteQueue, validate_write_queue
from .write_batch import validate_batch


class WriteBatchTests(TestCase):
    setUp = queue_fixture.WriteQueueTests.setUp
    consent = queue_fixture.WriteQueueTests.consent

    def requests(self, count=2):
        return [{'cluster': self.cluster, 'block_token': f'{i:064x}', 'digest': self.digest, 'size': 4}
                for i in range(count)]

    def reserve(self, requests=None, reply=None):
        self.queue.content_bound = True
        with patch('sfera_mesh.write_batch.exchange', side_effect=self.consent), \
                patch('sfera_mesh.write_batch.rpc', side_effect=reply or (lambda *args: {'code': 0})):
            return self.queue.reserve_many(self.requests() if requests is None else requests)

    def batch(self):
        return json.loads(self.queue.db.execute('SELECT record FROM write_batch_outbox').fetchone()[0])

    def accept(self):
        record = self.batch()
        validate_batch(record, 'lab', self.fixture.state)
        self.fixture.state['write_queue'] = {item['body']['request_id']: {
            'record': item, 'digest': sha256(canonical(item)).hexdigest(),
            'accepted_at': self.fixture.state['block_time']} for item in record['body']['writes']}
        validate_write_queue(self.fixture.state, 'lab')

    def test_one_broadcast_contains_all_three_signed_requests(self):
        self.assertEqual(self.reserve()['state'], 'submitted')
        self.assertEqual(len(self.batch()['body']['writes']), 2)
        self.assertEqual(self.queue.db.execute('SELECT COUNT(*) FROM write_outbox').fetchone()[0], 0)
        self.accept()
        with patch('sfera_mesh.write_batch.exchange') as consent, patch('sfera_mesh.write_batch.rpc') as send:
            self.assertEqual(self.queue.reserve_many(self.requests())['state'], 'queued')
            consent.assert_not_called(); send.assert_not_called()

    def test_lost_reply_restarts_exact_batch_without_new_signatures(self):
        def lost(*args): raise OSError('lost reply')
        self.assertEqual(self.reserve(reply=lost)['state'], 'waiting')
        saved = canonical(self.batch())
        self.queue.close()
        self.queue = ConsensusWriteQueue(self.path, self.base.publication, content_bound=True)
        with patch('sfera_mesh.write_batch.exchange') as consent, patch('sfera_mesh.write_batch.rpc', return_value={'code': 0}) as send:
            self.assertEqual(self.queue.reserve_many(self.requests())['state'], 'submitted')
            consent.assert_not_called()
            self.assertEqual(base64.b64decode(send.call_args.args[2]['tx']), saved)

    def test_129_pending_requests_never_split_or_broadcast(self):
        self.queue.content_bound = True
        with patch('sfera_mesh.write_batch.exchange') as consent, patch('sfera_mesh.write_batch.rpc') as send:
            result = self.queue.reserve_many(self.requests(129))
            self.assertEqual(result['state'], 'blocked')
            consent.assert_not_called(); send.assert_not_called()
        self.assertEqual(self.queue.db.execute('SELECT COUNT(*) FROM write_batch_outbox').fetchone()[0], 0)

    def test_last_slot_conflict_fails_before_any_holder_signature(self):
        from .manifests import manifest_record
        sizes = {sha256(f'occupied-{i}'.encode()).hexdigest(): 1 for i in range(511)}
        manifest = manifest_record('lab', self.fixture.state['placements'][self.cluster], sorted(sizes),
            self.fixture.fixture.keys[:2], sizes=sizes)
        self.fixture.state['manifests'] = {self.cluster: {'record': manifest, 'digest': sha256(canonical(manifest)).hexdigest()}}
        requests = self.requests()
        requests[1]['digest'] = 'f' * 64
        self.queue.content_bound = True
        with patch('sfera_mesh.write_batch.exchange') as consent, patch('sfera_mesh.write_batch.rpc') as send:
            with self.assertRaisesRegex(ValueError, 'capacity_exhausted'): self.queue.reserve_many(requests)
            consent.assert_not_called(); send.assert_not_called()

    def test_completed_manifest_releases_durable_batch(self):
        from .manifests import manifest_record
        self.reserve(); self.accept()
        manifest = manifest_record('lab', self.fixture.state['placements'][self.cluster], [self.digest],
            self.fixture.fixture.keys[:2], sizes={self.digest: 4})
        self.fixture.state['manifests'] = {self.cluster: {'record': manifest, 'digest': sha256(canonical(manifest)).hexdigest()}}
        self.fixture.state['write_queue'] = {}
        with patch('sfera_mesh.write_batch.rpc') as send:
            self.assertEqual(self.queue.reserve_many(self.requests())['state'], 'queued')
            send.assert_not_called()
        self.assertEqual(self.queue.db.execute('SELECT COUNT(*) FROM write_batch_outbox').fetchone()[0], 0)

    def test_second_generation_waits_for_pending_batch(self):
        self.reserve()
        requests = self.requests()
        requests[0]['block_token'] = 'f' * 64
        with patch('sfera_mesh.write_batch.rpc') as send:
            self.assertEqual(self.queue.reserve_many(requests)['error'], 'another_write_batch_pending')
            send.assert_not_called()

    def test_corrupt_saved_signature_never_broadcasts(self):
        self.reserve(reply=lambda *args: (_ for _ in ()).throw(OSError('lost')))
        record = self.batch()
        record['body']['writes'][-1]['consents'][-1]['signature'] = '0' * 128
        with self.queue.db:
            self.queue.db.execute('UPDATE write_batch_outbox SET record=?', (canonical(record),))
        with patch('sfera_mesh.write_batch.rpc') as send:
            self.assertEqual(self.queue.reserve_many(self.requests())['state'], 'waiting')
            send.assert_not_called()

    def test_invalid_or_duplicate_input_rejected(self):
        self.queue.content_bound = True
        for requests in ([], [self.requests()[0]] * 2, [{**self.requests()[0], 'size': True}]):
            with self.assertRaises(ValueError): self.queue.reserve_many(requests)

    def test_corrupt_completion_metadata_never_deletes_or_rebuilds_batch(self):
        self.reserve()
        saved = self.queue.db.execute('SELECT record FROM write_batch_outbox').fetchone()[0]
        with self.queue.db:
            self.queue.db.execute('UPDATE write_batch_outbox SET requests=?', (canonical([]),))
        with patch('sfera_mesh.write_batch.rpc') as send, patch('sfera_mesh.write_batch.exchange') as sign:
            with self.assertRaisesRegex(ValueError, 'corrupt_write_batch_outbox'):
                self.queue.reserve_many(self.requests())
            send.assert_not_called(); sign.assert_not_called()
        self.assertEqual(self.queue.db.execute('SELECT record FROM write_batch_outbox').fetchone()[0], saved)

    def test_restart_cannot_disable_v2_with_unfinished_batch(self):
        self.reserve()
        with self.assertRaisesRegex(ValueError, 'pending_write_batch_requires_v2'):
            ConsensusWriteQueue(self.path, self.base.publication)
        self.assertEqual(len(self.batch()['body']['writes']), 2)

    def test_long_signature_collection_revalidates_pinned_placement(self):
        clock = SimpleNamespace(time=time.time, monotonic=lambda ticks=itertools.count(0, 6): next(ticks))
        with patch('sfera_mesh.write_batch.time', clock), patch.object(self.base.directory, 'refresh', wraps=self.base.directory.refresh) as refresh:
            self.assertEqual(self.reserve()['state'], 'submitted')
            self.assertGreaterEqual(refresh.call_count, 3)
        self.accept()

    def test_long_collection_stops_if_fresh_anchor_is_unavailable(self):
        self.queue.content_bound = True
        clock = SimpleNamespace(time=time.time, monotonic=lambda ticks=itertools.count(0, 6): next(ticks))
        with patch('sfera_mesh.write_batch.time', clock), \
                patch.object(self.base.directory, 'refresh', side_effect=[None, OSError('lost BFT refresh')]), \
                patch('sfera_mesh.write_batch.rpc') as send:
            self.assertEqual(self.queue.reserve_many(self.requests())['state'], 'waiting')
            send.assert_not_called()
        self.assertEqual(self.queue.db.execute('SELECT COUNT(*) FROM write_batch_outbox').fetchone()[0], 0)
