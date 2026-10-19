import copy
from hashlib import sha256
import unittest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .directory import ZERO
from .identity import node_id
from .placements import cluster_id, consent_placement, validate_placement, validate_history
from .storage import canonical


class PlacementTests(unittest.TestCase):
    def setUp(self):
        self.keys = sorted([Ed25519PrivateKey.generate() for _ in range(3)], key=lambda key: node_id(key.public_key().public_bytes_raw()))
        members = [node_id(key.public_key().public_bytes_raw()) for key in self.keys]
        body = {'domain': 'sfera-mesh-placement-v1', 'network': 'lab', 'cluster': cluster_id('lab', members), 'epoch': 1, 'previous': ZERO, 'members': members}
        self.record = {'body': body, 'consents': [consent_placement(body, key) for key in self.keys]}

    def test_all_members_sign_the_same_network_epoch_and_content(self):
        body, digest = validate_placement(self.record, 'lab')
        self.assertEqual(digest, sha256(canonical(self.record)).hexdigest())
        self.assertEqual(body['epoch'], 1)
        for mutate in ('missing', 'duplicate', 'epoch', 'members', 'cluster'):
            forged = copy.deepcopy(self.record)
            if mutate == 'missing': forged['consents'].pop()
            elif mutate == 'duplicate': forged['consents'][1] = forged['consents'][0]
            elif mutate == 'epoch': forged['body']['epoch'] = 2
            elif mutate == 'members': forged['body']['members'].reverse()
            else: forged['body']['cluster'] = 'a' * 64
            with self.assertRaises(ValueError): validate_placement(forged, 'lab')
        with self.assertRaises(ValueError): validate_placement(self.record, 'other-network')
        with self.assertRaises(ValueError): consent_placement(body, Ed25519PrivateKey.generate())

    def test_signed_bad_schema_does_not_become_valid(self):
        for changes in ({'epoch': True}, {'epoch': 0}, {'previous': 'bad'}, {'unknown': 'value'}):
            body = {**self.record['body'], **changes}
            forged = {'body': body, 'consents': [{'public_key': key.public_key().public_bytes_raw().hex(), 'signature': key.sign(canonical(body)).hex()} for key in self.keys]}
            with self.assertRaises(ValueError): validate_placement(forged, 'lab')

    def test_missing_or_reordered_history_is_rejected(self):
        body, digest = validate_placement(self.record, 'lab')
        head = {'record': self.record, 'digest': digest}
        state = {'placements': {body['cluster']: head}, 'placement_history': {body['cluster']: [head]}}
        validate_history(state, 'lab')
        for history in ([], [head, head]):
            bad = {**state, 'placement_history': {body['cluster']: history}}
            with self.assertRaises(ValueError): validate_history(bad, 'lab')
