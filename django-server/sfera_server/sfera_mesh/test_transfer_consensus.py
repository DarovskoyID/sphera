from hashlib import sha256
import json
from pathlib import Path
import time
import unittest
from unittest.mock import patch

from . import test_publication
from .manifests import manifest_record
from .storage import canonical
from .transfer_consensus import TransferCoordinator, transfer_consent, validate_transfers


class TransferConsensusTests(unittest.TestCase):
    def setUp(self):
        base = test_publication.ReplicaPublicationTests(); base.setUp()
        self.addCleanup(base.doCleanups)
        self.base, self.fixture = base, base.fixture
        self.cluster = base.cluster
        head = self.fixture.state['placements'][self.cluster]
        record = manifest_record('lab',head,[base.digest],self.fixture.fixture.keys[:2],sizes={base.digest:4})
        self.fixture.state['manifests'] = {self.cluster:{'record':record,'digest':sha256(canonical(record)).hexdigest()}}
        self.fixture.state['placement_history'] = {self.cluster:[head]}
        self.path = Path(base.temp.name)/'transfers.sqlite'
        self.coordinator = TransferCoordinator(self.path,base.publication)
        self.addCleanup(lambda:self.coordinator.close())

    def consent(self,endpoint,key,verifier,recipient,operation,payload):
        return transfer_consent(self.fixture.signers[recipient],payload,self.base.owner.store,verifier.recipient)

    def step(self,reply=None):
        with patch('sfera_mesh.transfer_consensus.exchange',side_effect=self.consent), \
             patch('sfera_mesh.transfer_consensus.rpc',side_effect=reply or (lambda *args:{'code':0})):
            return self.coordinator.step(self.cluster)

    def pending(self):
        return json.loads(self.coordinator.db.execute('SELECT record FROM transfer_outbox').fetchone()[0])

    def accept(self):
        record = self.pending()
        self.fixture.state['transfers'] = {self.cluster:{'record':record,'digest':sha256(canonical(record)).hexdigest(),
                                                      'accepted_at':self.fixture.state['block_time']}}
        validate_transfers(self.fixture.state,'lab')

    def test_outbox_restart_and_no_completion_before_consensus(self):
        def lost(*args): raise OSError('lost reply')
        self.assertFalse(self.step(lost)['complete'])
        pending = self.pending()
        self.coordinator.close(); self.coordinator = TransferCoordinator(self.path,self.base.publication)
        self.assertEqual(self.step()['state'],'submitted')
        self.assertEqual(self.pending(),pending)
        self.accept()
        self.assertTrue(self.step()['complete'])

    def test_missing_holder_and_missing_bytes_never_emit_partial_report(self):
        failed = self.fixture.fixture.ids[2]
        def missing(*args):
            if args[3]==failed: raise OSError('offline')
            return self.consent(*args)
        with patch('sfera_mesh.transfer_consensus.exchange',side_effect=missing),patch('sfera_mesh.transfer_consensus.rpc') as broadcast:
            self.assertFalse(self.coordinator.step(self.cluster)['complete']); broadcast.assert_not_called()
        self.assertEqual(self.coordinator.db.execute('SELECT COUNT(*) FROM transfer_outbox').fetchone()[0],0)
        with self.base.owner.store.db:
            self.base.owner.store.db.execute('DELETE FROM blobs')
        with self.assertRaisesRegex(ValueError,'copy_mismatch'):
            self.step()

    def test_expiry_renews_but_old_record_remains_historically_valid(self):
        self.step(); self.accept()
        first = self.pending(); future = int(time.time())+31
        with patch('time.time',return_value=future):
            validate_transfers(self.fixture.state,'lab')
            self.assertFalse(self.step()['complete'])
        second = self.pending()
        self.assertEqual(second['body']['version'],2)
        self.assertEqual(second['body']['previous'],sha256(canonical(first)).hexdigest())

    def test_index_change_invalidates_old_completion_without_deleting_history(self):
        self.step(); self.accept()
        self.assertTrue(self.step()['complete'])
        head = self.fixture.state['manifests'][self.cluster]
        head['digest'] = 'e'*64
        with patch('sfera_mesh.transfer_consensus.exchange',side_effect=OSError('offline')):
            self.assertFalse(self.coordinator.step(self.cluster)['complete'])
        validate_transfers(self.fixture.state,'lab')

    def test_snapshot_corruption_and_changed_pin_are_rejected(self):
        self.step(); self.accept()
        self.fixture.state['transfers'][self.cluster]['digest'] = '0'*64
        with self.assertRaisesRegex(ValueError,'digest_mismatch'):
            validate_transfers(self.fixture.state,'lab')
        self.coordinator.close()
        with patch.object(self.base.directory,'pin','changed'):
            with self.assertRaisesRegex(ValueError,'context_changed'):
                TransferCoordinator(self.path,self.base.publication)
