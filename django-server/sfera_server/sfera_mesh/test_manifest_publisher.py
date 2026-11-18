from hashlib import sha256
import json
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from . import test_manifests
from .manifest_publisher import ManifestPublisher
from .manifests import manifest_record
from .storage import canonical
from .transport import BlobStore


class ManifestPublisherTests(unittest.TestCase):
    def setUp(self):
        owner=test_manifests.ManifestTests(); owner.setUp(); self.addCleanup(owner.doCleanups)
        self.fixture=owner.fixture; self.directory=self.fixture.directory
        base=self.fixture.fixture; self.key=base.keys[0]
        self.verifier=SimpleNamespace(network='lab',recipient=base.ids[0],roster={identity:key.public_key().public_bytes_raw() for identity,key in zip(base.ids,base.keys)})
        self.store=BlobStore(':memory:',max_bytes=32); self.addCleanup(self.store.close)
        self.digest=sha256(b'abcd').hexdigest(); self.store.execute('put',{'digest':self.digest,'ciphertext':b'abcd'.hex()})

    def publisher(self,path=':memory:',sizes=None):
        return ManifestPublisher(path,self.directory,'http://127.0.0.1:9999',self.key,self.verifier,self.fixture.journal.endpoints,cluster=self.fixture.cluster,sizes=sizes or {self.digest:4})

    def consent(self,endpoint,key,verifier,recipient,operation,payload):
        return self.fixture.signers[recipient].manifest_consent(payload,self.store,verifier.recipient)

    def test_exact_outbox_reopens_and_confirms_only_from_verified_index(self):
        with TemporaryDirectory() as temp:
            path=temp+'/publisher.sqlite'; publisher=self.publisher(path)
            with patch('sfera_mesh.manifest_publisher.exchange',side_effect=self.consent) as consents,patch('sfera_mesh.manifest_publisher.rpc',side_effect=OSError('lost reply')):
                self.assertEqual(publisher.step()['state'],'waiting'); self.assertEqual(consents.call_count,2)
            pending=json.loads(publisher.db.execute('SELECT record FROM manifest_job').fetchone()[0])
            publisher.close(); publisher=self.publisher(path)
            try:
                with publisher.db: publisher.db.execute('UPDATE manifest_job SET retry_at=0')
                with patch('sfera_mesh.manifest_publisher.exchange') as consents,patch('sfera_mesh.manifest_publisher.rpc',return_value={'code':0}):
                    self.assertEqual(publisher.step()['state'],'submitted'); consents.assert_not_called()
                self.fixture.state['manifests']={self.fixture.cluster:{'record':pending,'digest':sha256(canonical(pending)).hexdigest()}}
                with publisher.db: publisher.db.execute('UPDATE manifest_job SET retry_at=0')
                self.assertEqual(publisher.step()['state'],'confirmed')
                with patch('sfera_mesh.manifest_publisher.rpc') as broadcast:
                    self.assertEqual(publisher.step()['state'],'confirmed'); broadcast.assert_not_called()
            finally: publisher.close()
            with self.assertRaisesRegex(ValueError,'context_changed'): self.publisher(path,sizes={self.digest:5})

    def test_partial_consents_never_persist_or_broadcast(self):
        publisher=self.publisher(); self.addCleanup(publisher.close)
        allowed=self.fixture.fixture.ids[0]
        def one(*args):
            if args[3]!=allowed: raise OSError('offline')
            return self.consent(*args)
        with patch('sfera_mesh.manifest_publisher.exchange',side_effect=one),patch('sfera_mesh.manifest_publisher.rpc') as broadcast:
            self.assertEqual(publisher.step()['state'],'waiting'); broadcast.assert_not_called()
        self.assertIsNone(publisher.db.execute('SELECT record FROM manifest_job').fetchone()[0])
        with publisher.db: publisher.db.execute('UPDATE manifest_job SET retry_at=0')
        def two(*args):
            if args[3]==allowed: raise OSError('offline')
            return self.consent(*args)
        with patch('sfera_mesh.manifest_publisher.exchange',side_effect=two),patch('sfera_mesh.manifest_publisher.rpc',return_value={'code':0}):
            self.assertEqual(publisher.step()['state'],'submitted')

    def test_noncanonical_consent_does_not_block_two_other_holders(self):
        publisher=self.publisher(); self.addCleanup(publisher.close)
        first=sorted(self.fixture.fixture.ids[:3])[0]
        def malformed(*args):
            result=self.consent(*args)
            if args[3]==first: result['consent']['signature']=result['consent']['signature'].upper()
            return result
        with patch('sfera_mesh.manifest_publisher.exchange',side_effect=malformed),patch('sfera_mesh.manifest_publisher.rpc',return_value={'code':0}):
            self.assertEqual(publisher.step()['state'],'submitted')

    def test_verified_competing_index_rebases_without_discarding_committed_blocks(self):
        publisher=self.publisher(); self.addCleanup(publisher.close)
        with patch('sfera_mesh.manifest_publisher.exchange',side_effect=self.consent),patch('sfera_mesh.manifest_publisher.rpc',side_effect=OSError('unknown')):
            publisher.step()
        extra=sha256(b'xy').hexdigest(); self.store.execute('put',{'digest':extra,'ciphertext':b'xy'.hex()})
        head=self.fixture.state['placements'][self.fixture.cluster]
        record=manifest_record('lab',head,[extra],self.fixture.fixture.keys[:2],sizes={extra:2})
        self.fixture.state['manifests']={self.fixture.cluster:{'record':record,'digest':sha256(canonical(record)).hexdigest()}}
        with publisher.db: publisher.db.execute('UPDATE manifest_job SET retry_at=0')
        with patch('sfera_mesh.manifest_publisher.exchange',side_effect=self.consent),patch('sfera_mesh.manifest_publisher.rpc',return_value={'code':0}):
            self.assertEqual(publisher.step()['state'],'submitted')
        pending=json.loads(publisher.db.execute('SELECT record FROM manifest_job').fetchone()[0])
        self.assertEqual(set(pending['body']['digests']),{self.digest,extra})
        self.assertEqual(pending['body']['version'],2)
