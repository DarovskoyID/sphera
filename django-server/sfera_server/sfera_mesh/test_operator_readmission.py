import copy
import threading
from types import SimpleNamespace
import unittest

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .admission import application, approval
from .admission_registry import AdmissionRegistry
from .operator_readmission import prepare_readmission, step_readmission
from . import test_admission


class OperatorReadmissionTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_admission.AdmissionTests()
        self.fixture.setUp()
        self.registry = AdmissionRegistry(':memory:', 'lab', 'a'*64, 'b'*64, self.fixture.committee)
        self.addCleanup(self.registry.close)
        self.registry.accept(self.fixture.request, self.fixture.issue(), now=1002)
        self.old_node = self.fixture.request['body']['node_id']
        self.original = self.registry.history(self.old_node)[-1]
        self.new_key = Ed25519PrivateKey.generate()
        self.calls = []
        self.at = 1003
        self.directory = SimpleNamespace(network='lab', pin='a'*64, lock=threading.RLock(),
            refresh=lambda address: self.refresh(), anchor=lambda: {'height': 10})
        self.publisher = SimpleNamespace(directory=self.directory, address='fixture',
            committee=self.fixture.committee, step=self.publish)
        self.plan = self.prepare()
        # Recovery never reads this attribute or asks the lost key to sign.
        self.fixture.candidate = None
        self.refresh()

    def prepare(self, *, at=1003, revoked=None, operator='c'*64, key=None):
        request = application(key or self.new_key, 'lab', 'a'*64, 'b'*64, operator, 'e'*64, now=at)
        approved = approval(request, 'lab', 'a'*64, 'b'*64, self.fixture.committee,
                            self.fixture.keys[:3], now=at)
        return prepare_readmission(self.original, request, approved, 'lab', 'a'*64, 'b'*64,
            self.fixture.committee, self.fixture.keys[:3], now=at, revoked=revoked)

    def refresh(self):
        nodes = [row[0] for row in self.registry.db.execute('SELECT DISTINCT node FROM admission_history')]
        self.directory.current = {'state': {'genesis_pin': 'a'*64, 'admission_policy': 'b'*64,
            'block_time': self.at, 'admissions': {node: self.registry.history(node) for node in nodes},
            'admission_rotations': {}}}

    def publish(self, packet):
        self.calls.append(packet)
        if packet['body']['operation'] == 'revoke':
            self.registry.revoke(packet['revocation'], now=self.at)
        else:
            self.registry.accept(packet['application'], packet['approval'], now=self.at)
        return {'state': 'submitted'}

    def test_lost_key_recovery_requires_confirmed_revocation_first(self):
        self.assertEqual(step_readmission(self.publisher, self.plan)['state'], 'revoking')
        self.assertIsNone(self.registry.head(self.plan['new_node'], now=self.at))
        self.assertEqual(step_readmission(self.publisher, self.plan)['state'], 'admitting')
        result = step_readmission(self.publisher, self.plan)
        self.assertEqual(result['state'], 'confirmed')
        self.assertFalse(result['roles_inherited'])
        self.assertTrue(result['document_live'])
        self.assertTrue(self.registry.head(self.old_node, now=self.at)['revoked'])
        self.assertNotEqual(self.old_node, result['new_node'])

    def test_pending_or_hidden_reply_never_skips_old_revocation(self):
        self.publisher.step = lambda packet: {'state': 'waiting'}
        for _ in range(3):
            self.assertEqual(step_readmission(self.publisher, self.plan)['state'], 'revoking')
        self.assertIsNone(self.registry.head(self.plan['new_node'], now=self.at))

    def test_resumes_after_outage_with_renewed_application_not_old_secret(self):
        step_readmission(self.publisher, self.plan)
        revoked = self.plan['revoke']['revocation']
        self.at = 1400
        with self.assertRaises(ValueError):
            step_readmission(self.publisher, self.plan)
        renewed = self.prepare(at=self.at, revoked=revoked)
        self.assertEqual(renewed['revoke'], self.plan['revoke'])
        self.assertEqual(step_readmission(self.publisher, renewed)['state'], 'admitting')
        self.assertEqual(step_readmission(self.publisher, renewed)['state'], 'confirmed')

    def test_retry_does_not_extend_expiry_or_reissue_roles(self):
        for _ in range(3):
            step_readmission(self.publisher, self.plan)
        self.at = 2000
        result = step_readmission(self.publisher, self.plan)
        self.assertEqual(result['state'], 'confirmed')
        self.assertFalse(result['document_live'])
        self.assertEqual(len(self.calls), 2)

    def test_cannot_reassign_operator_or_reuse_old_key(self):
        with self.assertRaisesRegex(ValueError, 'same_operator'):
            self.prepare(operator='f'*64)
        for field in ('old_node', 'new_node', 'genesis', 'policy'):
            bad = copy.deepcopy(self.plan)
            bad[field] = 'f'*64
            with self.assertRaises(ValueError):
                step_readmission(self.publisher, bad)
        self.assertEqual(self.calls, [])

    def test_tampered_or_cross_target_revocation_rejected(self):
        bad = copy.deepcopy(self.plan)
        bad['revoke']['revocation']['votes'][0]['signature'] = '00'*64
        with self.assertRaises(ValueError):
            step_readmission(self.publisher, bad)
        with self.assertRaisesRegex(ValueError, 'target_mismatch'):
            self.prepare(key=Ed25519PrivateKey.generate(), revoked=self.plan['revoke']['revocation'])
        self.assertEqual(self.calls, [])

    def test_later_revocation_is_not_a_live_recovery(self):
        for _ in range(3):
            step_readmission(self.publisher, self.plan)
        from .admission_revocation import revocation
        target = self.registry.head(self.plan['new_node'], now=self.at)
        revoked = revocation(target, 'lab', 'a'*64, 'b'*64, self.fixture.committee,
            self.fixture.keys[:3], 'f'*64, now=self.at)
        self.registry.revoke(revoked, now=self.at)
        with self.assertRaisesRegex(ValueError, 'target_revoked'):
            step_readmission(self.publisher, self.plan)
