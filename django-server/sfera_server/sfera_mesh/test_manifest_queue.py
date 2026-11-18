import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from hashlib import sha256
from .test_manifest_publisher import ManifestPublisherTests
from .manifest_queue import ManifestQueue
from .storage import canonical


class ManifestQueueTests(unittest.TestCase):
    def setUp(self,fixture_type=ManifestPublisherTests):
        self.fixture=fixture_type();self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.path=Path(self.temp.name)/'queue.sqlite'
        self.queue=self.open();self.addCleanup(lambda:self.queue.close())
        self.body={'cluster':self.fixture.fixture.cluster,'sizes':{self.fixture.digest:4}};self.sender=self.fixture.verifier.recipient

    def open(self):
        f=self.fixture
        return ManifestQueue(self.path,f.directory,'http://127.0.0.1:9999',f.key,f.verifier,f.fixture.journal.endpoints,f.store)

    def test_durable_deduplication_and_receipt_after_restart(self):
        result=self.queue.submit(self.sender,self.body);self.assertEqual(self.queue.submit(self.sender,self.body),result)
        self.queue.close();self.queue=self.open()
        self.assertEqual(self.queue.receipt(self.sender,{'request_id':result['request_id']}),result)
        self.assertEqual(self.queue.db.execute('SELECT COUNT(*) FROM manifest_requests').fetchone(),(1,))

    def test_requires_current_holders_and_actual_local_copy(self):
        with self.assertRaisesRegex(ValueError,'holders_required'):self.queue.submit('f'*64,self.body)
        body={**self.body,'sizes':{'a'*64:4}}
        with self.assertRaisesRegex(ValueError,'local_copy'):self.queue.submit(self.sender,body)
        self.assertEqual(self.queue.db.execute('SELECT COUNT(*) FROM manifest_requests').fetchone(),(0,))

    def test_lost_broadcast_reply_keeps_exact_outbox_and_verified_confirmation(self):
        result=self.queue.submit(self.sender,self.body)
        with patch('sfera_mesh.manifest_publisher.exchange',side_effect=self.fixture.consent),patch('sfera_mesh.manifest_publisher.rpc',side_effect=OSError('lost reply')):
            self.assertEqual(self.queue.step()['state'],'waiting')
        pending=json.loads(self.queue.db.execute('SELECT record FROM manifest_job').fetchone()[0]);self.queue.close();self.queue=self.open()
        with self.queue.db:self.queue.db.execute('UPDATE manifest_job SET retry_at=0')
        with patch('sfera_mesh.manifest_publisher.exchange') as consents,patch('sfera_mesh.manifest_publisher.rpc',return_value={'code':0}):
            self.assertEqual(self.queue.step()['state'],'submitted');consents.assert_not_called()
        self.fixture.fixture.state['manifests']={self.body['cluster']:{'record':pending,'digest':sha256(canonical(pending)).hexdigest()}}
        with self.queue.db:self.queue.db.execute('UPDATE manifest_job SET retry_at=0')
        self.assertEqual(self.queue.step()['state'],'confirmed')
        self.assertEqual(self.queue.receipt(self.sender,{'request_id':result['request_id']})['state'],'confirmed')

    def test_backlog_limit_before_acceptance(self):
        with self.queue.db:
            for number in range(64):self.queue.db.execute("INSERT INTO manifest_requests(digest,sender,body,state) VALUES(?,?,?,'queued')",(sha256(str(number).encode()).hexdigest(),self.sender,canonical(self.body)))
        with self.assertRaisesRegex(ValueError,'queue_full'):self.queue.submit(self.sender,self.body)

    def test_separate_job_slots_do_not_cross_confirm_requests(self):
        self.queue.submit(self.sender,self.body)
        other=b'efgh';digest=sha256(other).hexdigest();self.fixture.store.execute('put',{'digest':digest,'ciphertext':other.hex()})
        self.queue.submit(self.sender,{'cluster':self.body['cluster'],'sizes':{digest:4}})
        with patch('sfera_mesh.manifest_publisher.exchange',side_effect=self.fixture.consent),patch('sfera_mesh.manifest_publisher.rpc',return_value={'code':0}):
            self.queue.step();self.queue.step()
        records=[json.loads(row[0])['body']['digests'] for row in self.queue.db.execute('SELECT record FROM manifest_job ORDER BY singleton')]
        self.assertEqual(records,[[self.fixture.digest],[digest]])


del ManifestPublisherTests
if __name__=='__main__':unittest.main()
