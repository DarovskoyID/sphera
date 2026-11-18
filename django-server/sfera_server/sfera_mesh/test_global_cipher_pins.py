import copy
from hashlib import sha256
import unittest
from . import test_cipher_authority as fixture
from .cipher_authority import CipherAuthority
from .cipher_device_pins import validate_cipher_devices, check_progress
from .storage import canonical


class GlobalPinTests(unittest.TestCase):
    def setUp(self):
        self.base = fixture.CipherAuthorityTests()
        self.addCleanup(self.base.doCleanups)
        self.base.setUp()
        self.base.backend.require_consensus_cipher_pins = True
        self.pins = {}
        for person in (self.base.alice, self.base.bob):
            certificate = person['certificate']
            self.pins[person['owner'] + ':' + person['device']] = {'certificate': certificate, 'digest': sha256(canonical(certificate)).hexdigest()}
        self.base.directory.cipher_device = lambda owner, device: {'head': copy.deepcopy(self.pins.get(owner + ':' + device)), 'finality': self.base.directory.anchor()}
        self.authority = CipherAuthority(self.base.backend)

    def state(self):
        return {'cipher_devices': copy.deepcopy(self.pins), 'devices': {owner: [{'event': event, 'digest': sha256(canonical(event)).hexdigest()} for event in events] for owner, (_, events) in self.base.directory.owners.items()}}

    def test_checked_state_and_persistent_progress(self):
        state = self.state()
        validate_cipher_devices(state, 'lab', self.base.directory.pin)
        check_progress(state, copy.deepcopy(state))
        for changed in ({}, {'cipher_devices': {}}, {'cipher_devices': {key: {**head, 'digest': '0' * 64} for key, head in self.pins.items()}}):
            with self.assertRaisesRegex(ValueError, 'rollback_or_fork'): check_progress(state, changed)
        damaged = copy.deepcopy(state); next(iter(damaged['cipher_devices'].values()))['digest'] = '0' * 64
        with self.assertRaises(ValueError): validate_cipher_devices(damaged, 'lab', self.base.directory.pin)
        with self.assertRaises(ValueError): validate_cipher_devices(state, 'lab', 'b' * 64)

    def test_missing_global_pin_never_trusts_existing_local_cache(self):
        self.pins.clear()
        with self.assertRaisesRegex(ValueError, 'global_pin_pending'):
            self.authority.publish(self.base.alice['user'], self.base.alice['claim'], self.base.alice['certificate'], now=103)
        with self.assertRaisesRegex(ValueError, 'not_globally_bound'):
            self.authority.attest(self.base.alice['user'], self.base.alice['claim'], 'dm', self.base.scope, [self.base.alice['user'], self.base.bob['user']], 'e' * 64, now=103)

    def test_scope_resolves_global_pins_without_local_cache_and_rejects_poison(self):
        with self.base.backend.db: self.base.backend.db.execute('DELETE FROM cipher_devices')
        def scope():
            return self.authority.attest(self.base.alice['user'], self.base.alice['claim'], 'dm', self.base.scope, [self.base.alice['user'], self.base.bob['user']], 'e' * 64, now=103)
        self.assertEqual(len(scope()['body']['certificates']), 2)
        forged = copy.deepcopy(self.base.alice['certificate'])
        forged['body']['ed25519'] = self.base.bob['certificate']['body']['ed25519']
        forged['signature'] = self.base.alice['device_root'].sign(canonical(forged['body'])).hex()
        with self.assertRaisesRegex(ValueError, 'global_pin_conflict'):
            self.authority.publish(self.base.alice['user'], self.base.alice['claim'], forged, now=103)
        with self.base.backend.db:
            self.base.backend.db.execute('INSERT INTO cipher_devices VALUES(?,?,?)', (self.base.alice['owner'], self.base.alice['device'], canonical(forged)))
        with self.assertRaisesRegex(ValueError, 'cache_conflict'): scope()
