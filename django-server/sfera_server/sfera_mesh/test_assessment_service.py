from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
import copy
import unittest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .assessment_service import validate_assessment,provision_assessment,assessment_binding
from .identity import node_id


class AssessmentServiceTests(unittest.TestCase):
    def setUp(self):
        self.keys=[Ed25519PrivateKey.generate() for _ in range(4)];self.nodes=[Ed25519PrivateKey.generate() for _ in range(4)]
        self.peers={node_id(k.public_key().public_bytes_raw()):{'public_key':k.public_key().public_bytes_raw().hex(),'endpoint':f'https://observer-{i}.example:8443'} for i,k in enumerate(self.nodes)}
        self.assessors={sha256(k.public_key().public_bytes_raw()).hexdigest():k.public_key().public_bytes_raw().hex() for k in self.keys}
        self.bindings=dict(zip(self.assessors,self.peers));self.verifier=SimpleNamespace(network='configured',recipient=next(iter(self.peers)))
        self.directory=SimpleNamespace(endpoint_policy='https-v1',placement_assessors=self.assessors,network='configured')
        self.policy={'assessor_key':str(Path.cwd()/'fixture-only-assessor.key'),'assessor_sha256':'a'*64,'bindings':self.bindings,'failure_domains':{n:'zone-'+str(i) for i,n in enumerate(self.peers)},
            'capacity_policy':{'bytes_per_slot':1024,'transport_bytes_per_second_per_slot':1024,'disk_bytes_per_second_per_slot':1024,'reserve_bytes':0},'discovery':True}

    def test_exact_genesis_assessor_and_observer_binding(self):
        capacity,failure=provision_assessment(self.policy,self.directory,self.nodes[0],self.verifier,self.peers,SimpleNamespace(verifier=self.verifier),self.keys[0])
        self.assertEqual(failure.assessor,next(iter(self.assessors)));self.assertIs(capacity.assessor_key,self.keys[0])

    def test_wrong_key_or_observer_or_missing_health_cannot_acquire_authority(self):
        for key,verifier,health in ((Ed25519PrivateKey.generate(),self.verifier,SimpleNamespace(verifier=self.verifier)),(self.keys[1],self.verifier,SimpleNamespace(verifier=self.verifier)),(self.keys[0],self.verifier,None)):
            with self.assertRaises(ValueError):provision_assessment(self.policy,self.directory,self.nodes[0],verifier,self.peers,health,key)

    def test_threshold_inventory_and_independence_validation(self):
        for change in ({'bindings':dict.fromkeys(self.assessors,self.verifier.recipient)},{'capacity_policy':{}},{'discovery':'true'},{'assessor_sha256':'placeholder'}):
            with self.assertRaises(ValueError):validate_assessment({**self.policy,**change},self.peers)

    def test_relocated_encrypted_backup_does_not_change_identity_policy_binding(self):
        relocated={**self.policy,'assessor_key':str(Path.cwd()/'isolated-recovery/operator/assessor.key')}
        self.assertEqual(assessment_binding(self.policy),assessment_binding(relocated))
        self.assertNotEqual(assessment_binding(self.policy),assessment_binding({**self.policy,'assessor_sha256':'b'*64}))


if __name__=='__main__':unittest.main()
