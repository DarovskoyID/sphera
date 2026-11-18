import copy
from hashlib import sha256
import unittest
import uuid
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .candidates import candidate_record, validate_candidate, validate_registry, registered_candidates
from .identity import node_id
from .storage import canonical
from .topology import choose_replacement


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.issuer = Ed25519PrivateKey.generate()
        public = self.issuer.public_key().public_bytes_raw()
        self.issuer_id = sha256(public).hexdigest()
        self.trusted = {self.issuer_id: public}
        self.keys = [Ed25519PrivateKey.generate() for _ in range(5)]
        self.ids = [node_id(key.public_key().public_bytes_raw()) for key in self.keys]
        self.state = {'block_time': 1000, 'candidates': {}, 'placements': {}}
        for i, key in enumerate(self.keys):
            modules = ['office'] if i < 3 else ['planner', 'conference']
            claims = {'schema': 'sfera-mesh-license-v1', 'issuer': self.issuer_id, 'instance_id': str(uuid.uuid4()), 'node_id': self.ids[i], 'network': 'lab', 'issued_at': 990, 'expires_at': 1290, 'modules': [{'id': module, 'expires_at': 2000} for module in modules]}
            document = {'claims': claims, 'signature': self.issuer.sign(canonical(claims)).hex()}
            record = candidate_record(key, 'lab', document)
            self.state['candidates'][self.ids[i]] = {'record': record, 'digest': sha256(canonical(record)).hexdigest(), 'accepted_at': 1000}
        self.resources = {identity: (f'zone-{i}', True) for i, identity in enumerate(self.ids)}

    def test_registry_and_selection_use_consensus_profiles_and_memberships(self):
        self.state['placements']['cluster'] = {'record': {'body': {'members': self.ids[:2] + [self.ids[4]]}}}
        profiles = registered_candidates(self.state, 'lab', self.trusted, self.resources, now=1000)
        by_id = {profile.node_id: profile for profile in profiles}
        self.assertEqual(by_id[self.ids[0]].memberships, frozenset({'cluster'}))
        survivors = [by_id[identity] for identity in self.ids[:2]]
        chosen = choose_replacement(survivors, [by_id[self.ids[2]], by_id[self.ids[3]]], 'cluster', now=1000)
        self.assertEqual(chosen.node_id, self.ids[2])
        self.assertEqual(registered_candidates(self.state, 'lab', self.trusted, self.resources, now=1290), [])
        # Expiry stops selection, but does not invalidate the accepted history.
        self.state['block_time'] = 5000
        validate_registry(self.state, 'lab', self.trusted)

    def test_tampering_and_duplicate_instance_are_rejected(self):
        changed = copy.deepcopy(self.state)
        head = changed['candidates'][self.ids[0]]
        head['record']['body']['available'] = False
        with self.assertRaises(ValueError): validate_registry(changed, 'lab', self.trusted)
        changed = copy.deepcopy(self.state)
        head = changed['candidates'][self.ids[1]]
        body = head['record']['body']
        body['license']['claims']['instance_id'] = self.state['candidates'][self.ids[0]]['record']['body']['license']['claims']['instance_id']
        body['license']['signature'] = self.issuer.sign(canonical(body['license']['claims'])).hex()
        head['record']['signature'] = self.keys[1].sign(canonical(body)).hex()
        head['digest'] = sha256(canonical(head['record'])).hexdigest()
        with self.assertRaisesRegex(ValueError, 'duplicate_candidate'): validate_registry(changed, 'lab', self.trusted)

    def test_schema_and_local_resource_filters(self):
        head = self.state['candidates'][self.ids[0]]
        for changes in ({'available': 1}, {'version': True}, {'previous': 'a'*64}, {'network': 'other'}):
            record = copy.deepcopy(head['record'])
            record['body'].update(changes)
            record['signature'] = self.keys[0].sign(canonical(record['body'])).hex()
            with self.assertRaises(ValueError): validate_candidate(record, 'lab')
        self.assertEqual(registered_candidates(self.state, 'lab', self.trusted, {}, now=1000), [])
        body = head['record']['body']
        record = candidate_record(self.keys[0], 'lab', body['license'], version=2, previous=head['digest'], available=False)
        self.state['candidates'][self.ids[0]] = {'record': record, 'digest': sha256(canonical(record)).hexdigest(), 'accepted_at': 1000}
        profiles = registered_candidates(self.state, 'lab', self.trusted, self.resources, now=1000)
        self.assertNotIn(self.ids[0], [profile.node_id for profile in profiles])


if __name__ == '__main__':
    unittest.main()
