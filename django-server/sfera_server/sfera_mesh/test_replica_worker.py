import threading
import unittest
from unittest.mock import Mock,patch
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .consensus_directory import ConsensusDirectory
from .identity import node_id
from .replica_worker import VerifiedReplicaWorker


class ReplicaWorkerTests(unittest.TestCase):
    def setUp(self):
        self.key=Ed25519PrivateKey.generate();self.identity=node_id(self.key.public_key().public_bytes_raw())
        self.directory=Mock(spec=ConsensusDirectory);self.directory.endpoint_policy='https-v1';self.directory.network='lab'
        self.directory.placement_assessors={str(index):'pinned-test-assessor' for index in range(4)}
        self.directory.lock=threading.RLock();self.directory.current={'state':{'placements':{'owned':{'record':{'body':{'members':[self.identity]}}}},'manifests':{'owned':{}}}}
        self.directory.placement.return_value={'record':{'body':{'members':[self.identity]}}}
        self.directory.placement_candidates.return_value=['verified-profile']
        self.journal=Mock();self.journal.run_batch.return_value={'processed':2}
    def worker(self):return VerifiedReplicaWorker(':memory:',self.key,self.directory,['http://127.0.0.1:26657'],':memory:')

    def test_only_confirmed_owned_placement_and_manifest_are_processed(self):
        worker=self.worker()
        with patch('sfera_mesh.replica_worker.ReplicaJournal.from_discovery',return_value=self.journal) as create:
            self.assertEqual(worker.run_once(),2)
        self.assertTrue(create.call_args.kwargs['https_only']);self.assertIs(create.call_args.kwargs['stop_event'],worker.stopped)
        self.journal.apply_confirmed_placement.assert_called_once_with(self.directory,'owned',['verified-profile'])
        self.journal.enqueue_confirmed_manifest.assert_called_once_with(self.directory,'owned')
        self.journal.schedule_recheck.assert_called_once_with('owned',limit=4)
        self.assertFalse(worker.status()['placement_authorised'])

    def test_network_io_does_not_hold_directory_lock(self):
        worker=self.worker()
        def copy(*args,**kwargs):
            acquired=[]
            def other():
                result=self.directory.lock.acquire(timeout=1);acquired.append(result)
                if result:self.directory.lock.release()
            thread=threading.Thread(target=other);thread.start();thread.join(timeout=2)
            self.assertEqual(acquired,[True]);return {'processed':1}
        self.journal.run_batch.side_effect=copy
        with patch('sfera_mesh.replica_worker.ReplicaJournal.from_discovery',return_value=self.journal):self.assertEqual(worker.run_once(),1)

    def test_missing_or_changed_assignment_does_not_copy(self):
        worker=self.worker();self.directory.placement.return_value={'record':{'body':{'members':['other']}}}
        with patch('sfera_mesh.replica_worker.ReplicaJournal.from_discovery',return_value=self.journal):self.assertEqual(worker.run_once(),0)
        self.journal.run_batch.assert_not_called();self.journal.apply_confirmed_placement.assert_not_called()

    def test_policy_and_membership_limit_fail_closed(self):
        self.directory.endpoint_policy=''
        with self.assertRaises(ValueError):self.worker()
        self.directory.endpoint_policy='https-v1';worker=self.worker()
        self.directory.current['state']['placements']={str(index):{'record':{'body':{'members':[self.identity]}}} for index in range(3)}
        with patch('sfera_mesh.replica_worker.ReplicaJournal.from_discovery',return_value=self.journal):
            with self.assertRaisesRegex(ValueError,'membership_limit'):worker.run_once()
        self.journal.run_batch.assert_not_called()

    def test_stop_prevents_copying_assigned_data(self):
        worker=self.worker();worker.stopped.set()
        with patch('sfera_mesh.replica_worker.ReplicaJournal.from_discovery',return_value=self.journal):
            self.assertEqual(worker.run_once(),0)
        self.journal.run_batch.assert_not_called()
