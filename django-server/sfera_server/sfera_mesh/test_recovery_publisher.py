import base64
import copy
from hashlib import sha256
import json
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import uuid

from . import test_manifest_publisher
from .consensus_directory import ConsensusUnavailable
from .manifests import manifest_record
from .recovery_publisher import RecoveryPublisher
from .recovery_roots import root_record, namespace
from .storage import canonical


class RecoveryPublisherTests(unittest.TestCase):
    def setUp(self):
        owner = test_manifest_publisher.ManifestPublisherTests(); owner.setUp()
        self.addCleanup(owner.doCleanups)
        self.owner, self.directory, self.key = owner, owner.directory, owner.key
        self.directory.pin = 'a'*64
        self.state = owner.fixture.state
        self.state['genesis_pin'] = self.directory.pin
        self.cluster, self.scope = owner.fixture.cluster, str(uuid.uuid4())
        self.digest, self.size = sha256(canonical([b'index'.hex()])).hexdigest(), len(canonical([b'index'.hex()]))
        record = manifest_record('lab', self.state['placements'][self.cluster], [self.digest], owner.fixture.fixture.keys[:2], sizes={self.digest: self.size})
        self.state['manifests'] = {self.cluster: {'record': record, 'digest': sha256(canonical(record)).hexdigest()}}

    def publisher(self, path=':memory:', **changes):
        target = {'source': 'dm', 'scope': self.scope, 'cluster': self.cluster, 'block_digest': self.digest, 'size': self.size, **changes}
        return RecoveryPublisher(path, self.directory, 'http://127.0.0.1:9999', self.key, **target)

    def prepared(self, publisher):
        return json.loads(publisher.db.execute('SELECT record FROM recovery_publisher_job').fetchone()[0])

    def confirm(self, record):
        body = record['body']
        self.state['recovery_roots'] = {namespace(body['publisher'], body['source'], body['scope']):
            {'record': record, 'digest': sha256(canonical(record)).hexdigest()}}

    def test_lost_reply_restart_exact_bytes_and_fresh_confirmation(self):
        with TemporaryDirectory() as folder:
            path = folder + '/root.sqlite'
            publisher = self.publisher(path)
            with patch('sfera_mesh.recovery_publisher.rpc', side_effect=OSError('lost reply')):
                self.assertEqual(publisher.step()['state'], 'waiting')
            record = self.prepared(publisher); publisher.close()
            publisher = self.publisher(path)
            try:
                with patch('sfera_mesh.recovery_publisher.rpc', return_value={'code': 0}) as send:
                    self.assertEqual(publisher.step()['state'], 'submitted')
                self.assertEqual(base64.b64decode(send.call_args.args[2]['tx']), canonical(record))
                self.confirm(record)
                self.assertEqual(publisher.step()['state'], 'confirmed')
                with patch.object(self.directory, 'anchor', side_effect=ConsensusUnavailable('stale')):
                    self.assertEqual(publisher.step()['state'], 'waiting')
                self.assertEqual(publisher.step()['state'], 'confirmed')
            finally:
                publisher.close()

    def test_other_writer_wins_without_rebasing_old_job(self):
        publisher = self.publisher(); self.addCleanup(publisher.close)
        with patch('sfera_mesh.recovery_publisher.rpc', side_effect=OSError('lost reply')):
            publisher.step()
        original = self.prepared(publisher)
        other = copy.deepcopy(original); other['body']['digest'] = 'c'*64
        other['signature'] = self.key.sign(canonical(other['body'])).hex()
        # Simulate a competing valid payload/index at the verified boundary.
        old = self.state['manifests'][self.cluster]
        record = manifest_record('lab', self.state['placements'][self.cluster], [self.digest, 'c'*64],
            self.owner.fixture.fixture.keys[:2], version=2, previous=old['digest'], sizes={self.digest: self.size, 'c'*64: self.size})
        self.state['manifests'][self.cluster] = {'record': record, 'digest': sha256(canonical(record)).hexdigest()}
        self.confirm(other)
        with patch('sfera_mesh.recovery_publisher.rpc') as send:
            result = publisher.step()
        self.assertEqual(result['state'], 'conflict'); send.assert_not_called()
        self.assertEqual(self.prepared(publisher), original)

    def test_uncommitted_size_never_prepares_or_submits(self):
        publisher = self.publisher(size=self.size+1); self.addCleanup(publisher.close)
        with patch('sfera_mesh.recovery_publisher.rpc') as send:
            self.assertEqual(publisher.step()['state'], 'waiting')
        send.assert_not_called()
        self.assertIsNone(publisher.db.execute('SELECT record FROM recovery_publisher_job').fetchone())

    def test_target_context_cannot_change_on_reopen(self):
        with TemporaryDirectory() as folder:
            path = folder + '/root.sqlite'; publisher = self.publisher(path); publisher.close()
            for changes in ({'source': 'guild'}, {'scope': str(uuid.uuid4())}, {'size': self.size + 1}):
                with self.assertRaisesRegex(ValueError, 'context_changed'):
                    self.publisher(path, **changes)

    def test_corrupt_outbox_is_not_submitted(self):
        publisher = self.publisher(); self.addCleanup(publisher.close)
        with patch('sfera_mesh.recovery_publisher.rpc', side_effect=OSError('lost reply')):
            publisher.step()
        record = self.prepared(publisher); record['signature'] = '0'*128
        with publisher.db:
            publisher.db.execute('UPDATE recovery_publisher_job SET record=?', (canonical(record),))
        with patch('sfera_mesh.recovery_publisher.rpc') as send:
            self.assertEqual(publisher.step()['state'], 'waiting')
        send.assert_not_called()

    def test_foreign_database_remains_unchanged(self):
        import sqlite3
        from contextlib import closing
        from pathlib import Path
        with TemporaryDirectory() as folder:
            path = Path(folder) / 'foreign.sqlite'
            with closing(sqlite3.connect(path)) as db, db:
                db.execute('CREATE TABLE private_application_data(value TEXT)')
                db.execute("INSERT INTO private_application_data VALUES('keep')")
            before = path.read_bytes()
            with self.assertRaisesRegex(ValueError, 'foreign_recovery_publisher_database'):
                self.publisher(path)
            self.assertEqual(path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
