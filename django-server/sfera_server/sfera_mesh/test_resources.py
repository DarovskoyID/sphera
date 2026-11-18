import copy
from hashlib import sha256
import unittest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .resources import resource_record, validate_resource, validate_resources, assessed_checks
from .storage import canonical
from .directory import ZERO


class ResourceTests(unittest.TestCase):
    def setUp(self):
        self.keys = [Ed25519PrivateKey.generate() for _ in range(4)]
        self.assessors = {sha256(key.public_key().public_bytes_raw()).hexdigest(): key.public_key().public_bytes_raw().hex() for key in self.keys}
        self.body = {'domain':'sfera-mesh-resource-v1','network':'lab','node_id':'a'*64,'candidate_hash':'b'*64,'version':1,'previous':ZERO,'failure_domain':'zone-a','capacity_slots':2,'issued_at':990,'expires_at':1290}
        self.record = resource_record(self.body, self.keys[:3])

    def test_three_distinct_pinned_signatures_and_schema(self):
        validate_resource(self.record, 'lab', self.assessors)
        for kind in ('missing', 'duplicate', 'unknown', 'tampered', 'capacity', 'context'):
            bad = copy.deepcopy(self.record)
            if kind == 'missing': bad['consents'].pop()
            elif kind == 'duplicate': bad['consents'][1] = bad['consents'][0]
            elif kind == 'unknown': bad = resource_record(self.body, [Ed25519PrivateKey.generate() for _ in range(3)])
            elif kind == 'tampered': bad['body']['failure_domain'] = 'other'
            elif kind == 'capacity': bad = resource_record({**self.body,'capacity_slots':True}, self.keys[:3])
            else: bad = resource_record({**self.body,'network':'other'}, self.keys[:3])
            with self.assertRaises(ValueError): validate_resource(bad, 'lab', self.assessors)

    def test_historical_checks_and_candidate_binding(self):
        head = {'record':self.record,'digest':sha256(canonical(self.record)).hexdigest(),'accepted_at':1000}
        state = {'resources':{'a'*64:head},'placement_assessors':self.assessors,'block_time':5000,'candidates':{'a'*64:{'digest':'b'*64}},'placements':{}}
        validate_resources(state, 'lab', self.assessors)
        self.assertEqual(assessed_checks(state, now=5000), {})
        self.assertEqual(assessed_checks(state, now=1000)['a'*64], ('zone-a',True))
        with self.assertRaises(ValueError): validate_resources(state, 'lab', {})
        state['candidates']['a'*64]['digest'] = 'c'*64
        self.assertEqual(assessed_checks(state, now=1000), {})

    def test_slot_reservations_count_consensus_memberships(self):
        record = resource_record({**self.body,'capacity_slots':1}, self.keys[:3])
        state = {'resources':{'a'*64:{'record':record}},'candidates':{'a'*64:{'digest':'b'*64}},'placements':{'home':{'record':{'body':{'members':['a'*64]}}}}}
        self.assertFalse(assessed_checks(state, now=1000)['a'*64][1])
        self.assertTrue(assessed_checks(state, now=1000, cluster='home')['a'*64][1])


if __name__ == '__main__':
    unittest.main()
