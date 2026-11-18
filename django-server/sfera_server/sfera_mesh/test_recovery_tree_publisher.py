import base64
from contextlib import closing
import copy
from hashlib import sha256
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from . import test_recovery_publisher as legacy_fixture
from .recovery_tree import RecoveryTree, head_record
from .recovery_roots import namespace, root_record
from .recovery_tree_publisher import RecoveryTreePublisher
from .storage import canonical


class RecoveryTreePublisherTests(unittest.TestCase):
    def setUp(self):
        self.fixture = legacy_fixture.RecoveryPublisherTests(); self.fixture.setUp(); self.addCleanup(self.fixture.doCleanups)
        self.directory, self.key, self.state = self.fixture.directory, self.fixture.key, self.fixture.state
        self.tree = RecoveryTree()
        self.message = '11111111-2222-2222-2222-222222222222'
        updates = [self.tree.update(self.message, 1)]
        self.record = head_record(self.key, self.directory.network, self.directory.pin, 'dm', self.fixture.scope,
            self.fixture.cluster, self.fixture.digest, self.fixture.size, self.tree.root, 1, 0, updates=updates)
        self.tx = {**self.record, 'updates': updates}

    def publisher(self, path=':memory:', tx=None):
        return RecoveryTreePublisher(path, self.directory, 'http://127.0.0.1:9999', tx or self.tx)

    def confirm(self, record):
        body = record['body']; key = namespace(body['publisher'], body['source'], body['scope'])
        self.state['recovery_trees'] = {key: {'record': record, 'digest': sha256(canonical(record)).hexdigest()}}

    def test_lost_reply_restart_resends_exact_proofs_then_confirms(self):
        with TemporaryDirectory() as folder:
            path = folder + '/tree.sqlite'; publisher = self.publisher(path)
            with patch('sfera_mesh.recovery_tree_publisher.rpc', side_effect=OSError('lost reply')):
                self.assertEqual(publisher.step()['state'], 'waiting')
            publisher.close(); publisher = self.publisher(path)
            try:
                with patch('sfera_mesh.recovery_tree_publisher.rpc', return_value={'code': 0}) as send:
                    self.assertEqual(publisher.step()['state'], 'submitted')
                self.assertEqual(base64.b64decode(send.call_args.args[2]['tx']), canonical(self.tx))
                self.confirm(self.record)
                with patch('sfera_mesh.recovery_tree_publisher.rpc') as send:
                    self.assertEqual(publisher.step()['state'], 'confirmed'); send.assert_not_called()
            finally: publisher.close()

    def test_competing_head_does_not_rebase_pending_proofs(self):
        publisher = self.publisher(); self.addCleanup(publisher.close)
        other = RecoveryTree()
        updates = [other.update(self.message, 2)]
        record = head_record(self.key, self.directory.network, self.directory.pin, 'dm', self.fixture.scope,
            self.fixture.cluster, self.fixture.digest, self.fixture.size, other.root, 1, 1, updates=updates)
        self.confirm(record)
        with patch('sfera_mesh.recovery_tree_publisher.rpc') as send:
            self.assertEqual(publisher.step()['state'], 'conflict'); send.assert_not_called()

    def test_uncommitted_exact_size_and_corrupt_outbox_never_broadcast(self):
        publisher = self.publisher(); self.addCleanup(publisher.close)
        self.state['manifests'][self.fixture.cluster]['record']['body']['sizes'][0] += 1
        with patch('sfera_mesh.recovery_tree_publisher.rpc') as send:
            self.assertEqual(publisher.step()['state'], 'waiting'); send.assert_not_called()
        with publisher.db:
            publisher.db.execute('UPDATE recovery_tree_outbox SET transaction_bytes=?', (b'{}',))
        with patch('sfera_mesh.recovery_tree_publisher.rpc') as send:
            self.assertEqual(publisher.step()['error'], 'recovery_tree_outbox_corrupt'); send.assert_not_called()

    def test_legacy_migration_keeps_exact_registry(self):
        legacy = root_record(self.key, self.directory.network, self.directory.pin, 'dm', self.fixture.scope,
            self.fixture.cluster, self.fixture.digest, self.fixture.size, messages=[self.message], deleted=[self.message])
        body = legacy['body']; identity_key = namespace(body['publisher'], 'dm', self.fixture.scope)
        digest = sha256(canonical(legacy)).hexdigest()
        self.state['recovery_roots'] = {identity_key: {'record': legacy, 'digest': digest}}
        tree = RecoveryTree([self.message], [self.message])
        record = head_record(self.key, self.directory.network, self.directory.pin, 'dm', self.fixture.scope,
            self.fixture.cluster, self.fixture.digest, self.fixture.size, tree.root, 1, 1, version=2, previous=digest)
        publisher = self.publisher(tx={**record, 'updates': []}); self.addCleanup(publisher.close)
        with patch('sfera_mesh.recovery_tree_publisher.rpc', return_value={'code': 0}):
            self.assertEqual(publisher.step()['state'], 'submitted')

    def test_bad_proof_context_change_and_foreign_database_are_rejected(self):
        bad = copy.deepcopy(self.tx); bad['updates'][0]['path'][0] = 'e' * 64
        with self.assertRaises(ValueError): self.publisher(tx=bad)
        with TemporaryDirectory() as folder:
            path = folder + '/tree.sqlite'; publisher = self.publisher(path); publisher.close()
            other = copy.deepcopy(self.tx); other['body']['scope'] = '22222222-2222-2222-2222-222222222222'
            other['signature'] = self.key.sign(canonical(other['body'])).hex()
            with self.assertRaisesRegex(ValueError, 'context_changed'): self.publisher(path, other)
            foreign = Path(folder) / 'foreign.sqlite'
            with closing(sqlite3.connect(foreign)) as db, db:
                db.execute('CREATE TABLE private_application_data(value TEXT)')
            before = foreign.read_bytes()
            with self.assertRaisesRegex(ValueError, 'foreign_recovery_tree_database'): self.publisher(foreign)
            self.assertEqual(foreign.read_bytes(), before)
