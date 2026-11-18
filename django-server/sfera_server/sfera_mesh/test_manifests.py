import copy
from hashlib import sha256
import unittest
from . import test_replacement
from .manifests import manifest_body, manifest_record, validate_manifest, validate_manifests
from .storage import canonical


class ManifestTests(unittest.TestCase):
    def test_holder_checks_local_bytes_before_signing_sizes(self):
        from .transport import BlobStore
        store=BlobStore(':memory:',max_bytes=16); self.addCleanup(store.close)
        data=b'abcd'; digest=sha256(data).hexdigest(); sender=self.fixture.fixture.ids[0]
        body=manifest_body('lab',self.head,[digest],sizes={digest:4})
        signer=self.fixture.signers[sender]
        with self.assertRaisesRegex(ValueError,'local_copy_mismatch'):
            signer.manifest_consent({'body':body},store,sender)
        store.execute('put',{'digest':digest,'ciphertext':data.hex()})
        signer.manifest_consent({'body':body},store,sender)
        bad=copy.deepcopy(body); bad['sizes']=[5]
        with self.assertRaisesRegex(ValueError,'local_copy_mismatch'):
            signer.manifest_consent({'body':bad},store,sender)
        with self.assertRaisesRegex(ValueError,'current_holder'):
            signer.manifest_consent({'body':body},store,self.fixture.fixture.ids[3])
        self.fixture.state['manifests']={self.fixture.cluster:{'record':manifest_record('lab',self.head,[digest],self.keys[:2],sizes={digest:4}),'digest':'a'*64}}
        with self.assertRaisesRegex(ValueError,'proposal_changed'):
            signer.manifest_consent({'body':body},store,sender)

    def test_manifest_consent_authenticated_http_and_majority_validation(self):
        import threading
        from .identity import EnvelopeVerifier
        from .transport import BlobStore,LabServer,exchange
        base=self.fixture.fixture; first,second=base.ids[:2]
        roster={identity:key.public_key().public_bytes_raw() for identity,key in zip(base.ids,base.keys)}
        store=BlobStore(':memory:',max_bytes=16)
        client=EnvelopeVerifier('lab',second,roster,':memory:'); target=EnvelopeVerifier('lab',first,roster,':memory:')
        server=LabServer(base.keys[0],target,store,placement_signer=self.fixture.signers[first])
        thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        try:
            data=b'abcd'; digest=sha256(data).hexdigest(); store.execute('put',{'digest':digest,'ciphertext':data.hex()})
            body=manifest_body('lab',self.head,[digest],sizes={digest:4})
            a=exchange(server.endpoint,base.keys[1],client,first,'manifest-consent',{'body':body})
            b=self.fixture.signers[second].manifest_consent({'body':body},store,second)
            record={'body':body,'consents':sorted([a['consent'],b['consent']],key=lambda item:item['public_key'])}
            validate_manifest(record,'lab',self.head)
        finally:
            server.shutdown(); server.server_close(); thread.join(2)
            store.close(); client.close(); target.close()

    def test_sized_manifest_binds_exact_sizes_and_preserves_v1_format(self):
        sized=manifest_record('lab',self.head,['b'*64,'a'*64],self.keys[:2],sizes={'a'*64:4,'b'*64:8})
        self.assertEqual(sized['body']['sizes'],[4,8])
        validate_manifest(sized,'lab',self.head)
        self.assertNotIn('sizes',self.record['body'])
        for sizes in ([4],[4,0],[4,True],[4,262145],None):
            bad=copy.deepcopy(sized); bad['body']['sizes']=sizes
            with self.assertRaises(ValueError): validate_manifest(bad,'lab',self.head)
        bad=copy.deepcopy(sized); bad['body']['sizes'][0]=5
        with self.assertRaises(ValueError): validate_manifest(bad,'lab',self.head)
        empty=manifest_record('lab',self.head,[],self.keys[:2],sizes={})
        self.assertEqual(empty['body']['sizes'],[])
        validate_manifest(empty,'lab',self.head)

    def setUp(self):
        self.fixture=test_replacement.ReplacementTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.head=self.fixture.state['placements'][self.fixture.cluster]
        self.keys=self.fixture.fixture.keys
        self.record=manifest_record('lab',self.head,['a'*64,'b'*64],self.keys[:2])

    def test_majority_context_and_content_are_bound(self):
        validate_manifest(self.record,'lab',self.head)
        for kind in ('missing','duplicate','tampered','unknown','unordered'):
            bad=copy.deepcopy(self.record)
            if kind=='missing': bad['consents'].pop()
            elif kind=='duplicate': bad['consents'][1]=bad['consents'][0]
            elif kind=='tampered': bad['body']['digests'].pop()
            elif kind=='unknown':
                with self.assertRaises(ValueError): manifest_record('lab',self.head,['a'*64],[self.keys[0],self.keys[3]])
                continue
            else: bad['body']['digests'].reverse()
            with self.assertRaises(ValueError): validate_manifest(bad,'lab',self.head)

    def test_snapshot_requires_the_certified_historical_placement(self):
        state={'manifests':{self.fixture.cluster:{'record':self.record,'digest':sha256(canonical(self.record)).hexdigest()}},'placement_history':{self.fixture.cluster:[self.head]}}
        validate_manifests(state,'lab')
        state['placement_history'][self.fixture.cluster]=[]
        with self.assertRaises(ValueError): validate_manifests(state,'lab')

    def test_manifest_bounds_and_schema_are_strict(self):
        for values in (['a'*64]*2,['not-a-digest'],['%064x'%i for i in range(513)]):
            with self.assertRaises(ValueError): manifest_record('lab',self.head,values,self.keys[:2])
        for changes in ({'version':True},{'epoch':True},{'previous':'a'*64}):
            record=copy.deepcopy(self.record); record['body'].update(changes)
            with self.assertRaises(ValueError): validate_manifest(record,'lab',self.head)
