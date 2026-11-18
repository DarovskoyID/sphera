import unittest
from unittest.mock import patch
from . import test_preparation
from .replication import ReplicaJournal


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_preparation.PreparationTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.journal = self.fixture.journal
        self.directory, self.cluster = self.fixture.directory, self.fixture.cluster
        self.payload = b'ciphertext observed on three holders'
        self.digest = self.journal.stage(self.cluster, self.payload)
        self.fixture.publish_manifest([self.digest])
        def request(node, operation, body):
            return {'digest': self.digest, 'ciphertext': self.payload.hex()} if operation == 'get' else {'digest': self.digest, 'stored': True}
        with patch.object(self.journal, '_request', side_effect=request):
            self.journal.run_batch(self.cluster)

    def test_complete_requires_exact_current_epoch_receipts(self):
        self.assertTrue(self.journal.transfer_status(self.directory,self.cluster)['complete'])
        reports = self.journal.transfer_history(self.cluster)
        self.assertEqual(len(reports),1)
        self.assertEqual(reports[0]['receipts'][0]['digest'],self.digest)
        with self.journal.db:
            self.journal.db.execute('UPDATE replica_receipts SET epoch=99 WHERE cluster=? AND node=?', (self.cluster,self.fixture.old_members[0]))
        result = self.journal.transfer_status(self.directory,self.cluster)
        self.assertFalse(result['complete'])
        self.assertEqual(result['reason'],'current_epoch_receipts_incomplete')
        self.assertEqual(self.journal.status(self.cluster,self.digest)['state'],'pending')
        self.assertEqual(self.journal.transfer_history(self.cluster),reports)  # Audit is historical, not live authority.

    def test_new_index_and_unindexed_local_data_prevent_completion(self):
        self.assertTrue(self.journal.transfer_status(self.directory,self.cluster)['complete'])
        self.fixture.publish_manifest(sorted([self.digest,'f'*64]))
        self.assertFalse(self.journal.transfer_status(self.directory,self.cluster)['complete'])
        self.fixture.publish_manifest([self.digest])
        self.journal.stage(self.cluster,b'not yet indexed')
        self.assertFalse(self.journal.transfer_status(self.directory,self.cluster)['complete'])

    def test_unreachable_holder_blocks_completion_until_retry_succeeds(self):
        missing = self.fixture.old_members[0]
        with self.journal.db:
            self.journal.db.execute('DELETE FROM replica_receipts WHERE cluster=? AND node=?',(self.cluster,missing))
        self.assertFalse(self.journal.transfer_status(self.directory,self.cluster)['complete'])
        def response(node, operation, body):
            if node == missing: return None
            return {'digest':self.digest,'ciphertext':self.payload.hex()} if operation=='get' else {'digest':self.digest,'stored':True}
        with patch.object(self.journal,'_request',side_effect=response):
            self.journal.run_batch(self.cluster)
        self.assertFalse(self.journal.transfer_status(self.directory,self.cluster)['complete'])
        self.assertEqual(self.journal.transfer_history(self.cluster),[])
        with patch.object(self.journal,'_request',side_effect=lambda node,operation,body: {'digest':self.digest,'ciphertext':self.payload.hex()} if operation=='get' else {'digest':self.digest,'stored':True}):
            self.journal.run_batch(self.cluster)
        self.assertTrue(self.journal.transfer_status(self.directory,self.cluster)['complete'])

    def test_report_survives_reopen_and_rechecks_current_state(self):
        # Backup/reopen exercises the persisted schema rather than an in-memory flag.
        from pathlib import Path
        from tempfile import TemporaryDirectory
        self.assertTrue(self.journal.transfer_status(self.directory,self.cluster)['complete'])
        with TemporaryDirectory() as temp:
            import sqlite3
            path = str(Path(temp)/'replicas.sqlite')
            db = sqlite3.connect(path)
            self.journal.db.backup(db)
            db.close()
            reopened = ReplicaJournal(path,self.journal.key,self.journal.verifier,self.journal.endpoints,require_consensus=True)
            try:
                self.assertEqual(reopened.transfer_history(self.cluster),self.journal.transfer_history(self.cluster))
                self.assertTrue(reopened.transfer_status(self.directory,self.cluster)['complete'])
                with reopened.db:
                    reopened.db.execute('DELETE FROM replica_receipts WHERE cluster=?',(self.cluster,))
                self.assertFalse(reopened.transfer_status(self.directory,self.cluster)['complete'])
            finally:
                reopened.close()
