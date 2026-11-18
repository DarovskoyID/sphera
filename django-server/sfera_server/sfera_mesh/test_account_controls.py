import copy
from hashlib import sha256
import unittest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .account_controls import validate_controls, check_progress, controller_public, history_signer
from .directory import user_id, validate_record
from .devices import device_id, validate_device_state
from .storage import canonical


class AccountControlTests(unittest.TestCase):
    def setUp(self):
        self.old, self.new, device = [Ed25519PrivateKey.generate() for _ in range(3)]
        self.anchor = self.old.public_key().public_bytes_raw().hex(); self.owner = user_id(bytes.fromhex(self.anchor))
        def record(key, version, previous):
            body = {'domain': 'sfera-mesh-account-v1', 'network': 'lab', 'user_id': self.owner, 'public_key': self.anchor,
                'version': version, 'previous': previous, 'vault_digest': '8' * 64, 'dialogs_digest': '9' * 64}
            return {'body': body, 'signature': key.sign(canonical(body)).hex()}
        self.first = record(self.old, 1, '0' * 64)
        self.current = record(self.new, 2, self.digest(self.first))
        public = device.public_key().public_bytes_raw()
        body = {'domain': 'sfera-mesh-device-event-lab-v1', 'network': 'lab', 'user_id': self.owner, 'version': 1, 'previous': '0' * 64,
            'operation': 'enroll', 'device_id': device_id(public), 'device_public': public.hex()}
        event = {'body': body, 'owner_signature': self.old.sign(canonical(body)).hex(), 'device_signature': device.sign(canonical(body)).hex()}
        body = {'domain': 'sfera-mesh-account-control-v1', 'network': 'lab', 'genesis': 'a' * 64, 'owner': self.owner,
            'epoch': 1, 'previous': '0' * 64, 'old_public': self.anchor, 'new_public': self.new.public_key().public_bytes_raw().hex(),
            'account_version': 1, 'account_digest': self.digest(self.first), 'devices_version': 1, 'devices_digest': self.digest(event), 'replacement_digest': self.digest(self.current)}
        control = {'body': body, 'old_signature': self.old.sign(canonical(body)).hex(), 'new_signature': self.new.sign(canonical(body)).hex()}
        self.state = {'accounts': {self.owner: {'record': self.current, 'digest': self.digest(self.current)}},
            'devices': {self.owner: [{'event': event, 'digest': self.digest(event)}]},
            'account_controls': {self.owner: [{'record': control, 'digest': self.digest(control)}]}}

    @staticmethod
    def digest(value): return sha256(canonical(value)).hexdigest()

    def test_stable_identity_and_historical_authority(self):
        validate_controls(self.state, 'lab', 'a' * 64)
        validate_device_state(self.state, 'lab')
        self.assertEqual(controller_public(self.state, self.owner, 1), self.anchor)
        self.assertEqual(controller_public(self.state, self.owner), self.new.public_key().public_bytes_raw().hex())
        validate_record(self.current, 'lab', self.owner, controller_public=controller_public(self.state, self.owner))
        with self.assertRaises(ValueError): validate_record(self.current, 'lab', self.owner)
        history = {'owner_public': self.anchor, 'control_history': self.state['account_controls'][self.owner]}
        self.assertEqual(history_signer(history, 1), self.anchor)
        self.assertEqual(history_signer(history, 2), controller_public(self.state, self.owner))

    def test_corrupt_signature_checkpoint_and_progress_rejected(self):
        for name in ('digest', 'new_signature', 'devices_digest'):
            state = copy.deepcopy(self.state); head = state['account_controls'][self.owner][0]
            if name == 'digest': head['digest'] = '0' * 64
            elif name == 'new_signature': head['record']['new_signature'] = '0' * 128
            else: head['record']['body']['devices_digest'] = '0' * 64
            with self.assertRaises(ValueError): validate_controls(state, 'lab', 'a' * 64)
        check_progress(self.state, copy.deepcopy(self.state))
        with self.assertRaises(ValueError): check_progress(self.state, {})
        changed = copy.deepcopy(self.state); changed['account_controls'][self.owner][0]['digest'] = '0' * 64
        with self.assertRaises(ValueError): check_progress(self.state, changed)
