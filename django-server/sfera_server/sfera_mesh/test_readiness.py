import copy
from hashlib import sha256
import unittest
from . import test_preparation
from .readiness import readiness_proof, validate_readiness
from .replacement import PlacementSigner
from .storage import canonical
from .transport import BlobStore


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.fixture=test_preparation.PreparationTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.publish_manifest([])
        self.proposal=self.fixture.proposal
        self.target=self.fixture.target
        keys=dict(zip(self.fixture.fixture.fixture.ids,self.fixture.fixture.fixture.keys))
        self.key=keys[self.target]

    def test_proof_is_bound_to_index_proposal_and_expiry(self):
        proof=readiness_proof(self.proposal['body'],self.key,now=1000)
        body={**self.proposal['body'],'readiness_hash':sha256(canonical(proof)).hexdigest()}
        validate_readiness(proof,body,now=1000)
        with self.assertRaises(ValueError): validate_readiness(proof,body,now=1030)
        with self.assertRaises(ValueError): validate_readiness(proof,{**body,'manifest_hash':'e'*64},now=1000)
        altered=copy.deepcopy(proof); altered['body']['expires_at']=5000
        with self.assertRaises(ValueError): validate_readiness(altered,{**body,'readiness_hash':sha256(canonical(altered)).hexdigest()},now=1000)

    def test_target_checks_each_indexed_block_before_signing(self):
        data=b'indexed ciphertext'; digest=sha256(data).hexdigest()
        self.fixture.publish_manifest([digest])
        store=BlobStore(':memory:')
        self.addCleanup(store.close)
        signer=PlacementSigner(self.key,self.fixture.directory)
        with self.assertRaisesRegex(ValueError,'copy_missing'): signer.ready(self.fixture.proposal,store)
        store.execute('put',{'digest':digest,'ciphertext':data.hex()})
        proof=signer.ready(self.fixture.proposal,store)
        proposal={**self.fixture.proposal,'body':{**self.fixture.proposal['body'],'readiness_hash':sha256(canonical(proof)).hexdigest()},'readiness':proof}
        signer.consent(proposal)
        with self.assertRaises(ValueError): signer.consent(self.fixture.proposal)
