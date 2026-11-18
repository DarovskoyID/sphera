import copy
from hashlib import sha256
import unittest

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .admission import application
from .admission_review import review_body, verify_review, reviewed_approval, validate_operator_set
from .identity import node_id
from .storage import canonical


def digest(value):
    return sha256(value.encode()).hexdigest()


class AdmissionReviewTests(unittest.TestCase):
    def setUp(self):
        self.keys = [Ed25519PrivateKey.generate() for _ in range(4)]
        self.publics = [key.public_key().public_bytes_raw().hex() for key in self.keys]
        self.authorities = {public: {field: digest(field + str(index)) for field in
            ('operator', 'failure_domain', 'provider')} for index, public in enumerate(self.publics)}
        self.committee = {node_id(bytes.fromhex(public)): public for public in self.publics}
        self.candidate = {field: digest(field + 'candidate') for field in ('operator', 'failure_domain', 'provider')}
        self.request = application(Ed25519PrivateKey.generate(), 'lab', 'a'*64, 'b'*64,
            self.candidate['operator'], 'c'*64, now=1000)

    def signed(self, keys=None):
        body = review_body(self.request, 'lab', 'a'*64, 'b'*64, now=1001)
        body['infrastructure'] = self.candidate
        votes = [{'public_key': key.public_key().public_bytes_raw().hex(),
                  'signature': key.sign(canonical(body)).hex()} for key in (keys or self.keys[:2])]
        return {'body': body, 'votes': sorted(votes, key=lambda item: item['public_key'])}

    def verify(self, record, **kwargs):
        return verify_review(record, self.request, 'lab', 'a'*64, 'b'*64,
            kwargs.get('authorities', self.authorities), kwargs.get('candidate', self.candidate), now=kwargs.get('now', 1002))

    def test_independent_reviews_then_distinct_approval_quorum(self):
        self.assertEqual(len(self.verify(self.signed())), 64)
        record = reviewed_approval(self.request, self.signed(), 'lab', 'a'*64, 'b'*64,
            self.committee, self.authorities, self.candidate, self.keys[:3], now=1002)
        self.assertEqual(len(record['votes']), 3)
        with self.assertRaises(ValueError):
            reviewed_approval(self.request, self.signed(), 'lab', 'a'*64, 'b'*64,
                self.committee, self.authorities, self.candidate, self.keys[:2], now=1002)

    def test_self_review_and_shared_failure_domain_rejected(self):
        for field in ('operator', 'failure_domain'):
            authorities = copy.deepcopy(self.authorities)
            authorities[self.publics[0]][field] = self.candidate[field]
            with self.assertRaisesRegex(ValueError, 'interested'):
                self.verify(self.signed(), authorities=authorities)

    def test_duplicate_foreign_and_insufficient_signers(self):
        for keys in ([self.keys[0]], [self.keys[0]]*2, [self.keys[0], Ed25519PrivateKey.generate()]):
            with self.assertRaises(ValueError):
                self.verify(self.signed(keys))

    def test_evidence_policy_infrastructure_and_signature_bound(self):
        for field in ('evidence', 'policy', 'application', 'operator'):
            record = self.signed()
            record['body'][field] = 'f'*64
            with self.assertRaises(ValueError):
                self.verify(record)
        candidate = dict(self.candidate, provider='f'*64)
        with self.assertRaises(ValueError):
            self.verify(self.signed(), candidate=candidate)
        record = self.signed()
        record['votes'][0]['signature'] = '00'*64
        with self.assertRaises(ValueError):
            self.verify(record)

    def test_expiry_and_future_review_rejected(self):
        for now in (1000, 1300):
            with self.assertRaises(ValueError):
                self.verify(self.signed(), now=now)

    def test_affiliated_operator_and_correlated_provider_rejected(self):
        for field in ('operator', 'failure_domain', 'provider'):
            operators = copy.deepcopy(list(self.authorities.values()))
            operators[1][field] = operators[0][field]
            with self.assertRaises(ValueError):
                validate_operator_set(operators)
