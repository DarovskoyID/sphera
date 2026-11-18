import copy
import unittest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .admission import application,approval,verify_application,verify_approval
from .identity import node_id


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.keys=[Ed25519PrivateKey.generate() for _ in range(4)]
        self.committee={node_id(key.public_key().public_bytes_raw()):key.public_key().public_bytes_raw().hex() for key in self.keys}
        self.candidate=Ed25519PrivateKey.generate()
        self.request=application(self.candidate,'lab','a'*64,'b'*64,'c'*64,'d'*64,now=1000)

    def issue(self,keys=None,**kwargs):
        return approval(self.request,'lab','a'*64,'b'*64,self.committee,self.keys[:3] if keys is None else keys,now=1001,**kwargs)

    def verify(self,record,**kwargs):
        return verify_approval(record,self.request,'lab','a'*64,'b'*64,self.committee,now=1002,**kwargs)

    def test_proof_of_key_and_pinned_quorum(self):
        self.assertEqual(len(verify_application(self.request,'lab','a'*64,'b'*64,now=1001)),64)
        self.assertEqual(len(self.verify(self.issue())),64)
        self.verify(self.issue(keys=self.keys))

    def test_insufficient_duplicate_and_foreign_votes(self):
        for keys in (self.keys[:2],[self.keys[0]]*3,[*self.keys[:2],self.candidate]):
            with self.assertRaises(ValueError): self.issue(keys=keys)

    def test_network_genesis_policy_and_request_are_bound(self):
        record=self.issue()
        for field in ('network','genesis','policy','committee','application'):
            bad=copy.deepcopy(record); bad['body'][field]='f'*64
            with self.assertRaises(ValueError): self.verify(bad)
        changed=copy.deepcopy(self.request); changed['body']['operator']='e'*64
        with self.assertRaises(ValueError): verify_application(changed,'lab','a'*64,'b'*64,now=1001)

    def test_expiry_and_history_anchor_reject_replay(self):
        record=self.issue()
        with self.assertRaises(ValueError): verify_approval(record,self.request,'lab','a'*64,'b'*64,self.committee,now=1300)
        with self.assertRaises(ValueError): self.verify(record,expected_version=2,expected_previous='e'*64)
        next_record=self.issue(version=2,previous='e'*64)
        with self.assertRaises(ValueError): self.verify(next_record)
        self.verify(next_record,expected_version=2,expected_previous='e'*64)

    def test_module_claims_cannot_supply_voting_authority(self):
        request=copy.deepcopy(self.request); request['body']['modules']=['office']
        with self.assertRaises(ValueError): verify_application(request,'lab','a'*64,'b'*64,now=1001)
        bad=copy.deepcopy(self.request); bad['body']['public_key']=self.keys[0].public_key().public_bytes_raw().hex()
        with self.assertRaises(ValueError): verify_application(bad,'lab','a'*64,'b'*64,now=1001)
        with self.assertRaises(ValueError): application(self.candidate,'lab','a'*64,'b'*64,'c'*64,'d'*64,now=1000,ttl=True)
