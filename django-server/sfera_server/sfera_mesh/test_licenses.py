import copy
from hashlib import sha256
import unittest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .storage import canonical
from .licenses import verify_attestation, placement_candidate
from .identity import node_id
from .topology import choose_cluster


class LicenseTests(unittest.TestCase):
    def setUp(self):
        self.key = Ed25519PrivateKey.generate()
        public = self.key.public_key().public_bytes_raw()
        self.issuer = sha256(public).hexdigest()
        self.trusted = {self.issuer: public}
        self.node = node_id(Ed25519PrivateKey.generate().public_key().public_bytes_raw())
        self.claims = {'schema': 'sfera-mesh-license-v1', 'issuer': self.issuer, 'instance_id': '12345678-1234-4234-8234-123456789012', 'node_id': self.node, 'network': 'test', 'issued_at': 100, 'expires_at': 400, 'modules': [{'id': 'office', 'expires_at': 500}]}

    def document(self, **changes):
        claims = {**self.claims, **changes}
        return {'claims': claims, 'signature': self.key.sign(canonical(claims)).hex()}

    def test_valid_signature_and_placement_expiry(self):
        document = self.document()
        grant = verify_attestation(document, self.trusted, self.node, 'test', now=100)
        self.assertEqual(grant.modules, frozenset({'office'}))
        candidates = []
        for i in range(3):
            node = str(i) * 64
            candidates.append(placement_candidate(self.document(node_id=node), self.trusted, node, 'test', str(i), now=100))
        self.assertEqual(len(choose_cluster(candidates, now=399)), 3)
        self.assertEqual(choose_cluster(candidates, now=400), ())

    def test_tamper_identity_trust_and_expiration(self):
        document = self.document()
        tampered = copy.deepcopy(document)
        tampered['claims']['modules'].append({'id': 'diary', 'expires_at': 500})
        for value, trust, node, network, now in [(tampered, self.trusted, self.node, 'test', 100), (document, {}, self.node, 'test', 100), (document, self.trusted, 'other', 'test', 100), (document, self.trusted, self.node, 'other', 100), (document, self.trusted, self.node, 'test', 400)]:
            with self.assertRaises(ValueError): verify_attestation(value, trust, node, network, now=now)

    def test_invalid_even_if_signed(self):
        for changes in [dict(expires_at=401), dict(issued_at=True), dict(modules=[{'id': 'unknown', 'expires_at': 500}]), dict(modules=self.claims['modules'] * 2), dict(modules=[{'id': 'office', 'expires_at': 399}])]:
            with self.assertRaises(ValueError): verify_attestation(self.document(**changes), self.trusted, self.node, 'test', now=100)
