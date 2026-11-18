import base64
import copy
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import unittest
import uuid

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .application_sessions import ApplicationSessions
from .cipher_authority import CipherAuthority, DOMAIN, verify_certificate
from .consensus_directory import ConsensusUnavailable
from .devices import DOMAIN as DEVICE_DOMAIN, device_id, verify_event
from .directory import ZERO, user_id
from .identity import node_id
from .storage import canonical


class Directory:
    network, pin = 'lab', 'a' * 64

    def __init__(self):
        self.lock, self.owners, self.available = threading.RLock(), {}, True

    def anchor(self):
        if not self.available:
            raise ConsensusUnavailable('offline')
        return {'height': 10}

    def device_history(self, owner):
        self.anchor()
        public, events = self.owners[owner]
        return {'owner_public': public, 'events': copy.deepcopy(events), 'version': len(events),
            'digest': verify_event(events[-1], self.network, public)[1] if events else ZERO,
            'finality': {'expires_at': 130}}


class CipherAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.directory = Directory()
        self.key = Ed25519PrivateKey.generate()
        self.entry = node_id(self.key.public_key().public_bytes_raw())
        self.path = str(Path(self.temp.name) / 'sessions.sqlite')
        self.backend = ApplicationSessions(self.path, self.directory, self.entry, entry_key=self.key)
        self.addCleanup(self.backend.close)
        self.authority = CipherAuthority(self.backend)
        self.alice, self.bob = self.person(), self.person()
        self.scope = str(uuid.uuid4())

    def event(self, person, operation, device=None):
        owner, root = person['owner'], person['root']
        device = device or person['device_root']
        events = self.directory.owners[owner][1]
        public = device.public_key().public_bytes_raw()
        body = {'domain': DEVICE_DOMAIN, 'network': 'lab', 'user_id': owner, 'version': len(events) + 1,
            'previous': verify_event(events[-1], 'lab', self.directory.owners[owner][0])[1] if events else ZERO,
            'operation': operation, 'device_id': device_id(public), 'device_public': public.hex()}
        events.append({'body': body, 'owner_signature': root.sign(canonical(body)).hex(),
            'device_signature': device.sign(canonical(body)).hex() if operation == 'enroll' else ''})

    def person(self):
        root, device = Ed25519PrivateKey.generate(), Ed25519PrivateKey.generate()
        public = root.public_key().public_bytes_raw()
        person = {'root': root, 'device_root': device, 'owner': user_id(public), 'user': str(uuid.uuid4())}
        self.directory.owners[person['owner']] = (public.hex(), [])
        self.event(person, 'enroll')
        person['device'] = device_id(device.public_key().public_bytes_raw())
        body = self.backend.challenge(person['user'], 'jti', person['owner'], person['device'], now=100)
        person['claim'] = self.backend.complete(person['user'], 'jti', body['challenge'],
            root.sign(canonical(body)).hex(), device.sign(canonical(body)).hex(), 700, now=101)
        person['sdk_signing'] = Ed25519PrivateKey.generate()
        pins = [base64.b64encode(key.public_key().public_bytes_raw()).decode().rstrip('=')
            for key in (person['sdk_signing'], Ed25519PrivateKey.generate())]
        body = {'domain': DOMAIN, 'network': 'lab', 'genesis': self.directory.pin, 'owner': person['owner'],
            'device': person['device'], 'device_public': device.public_key().public_bytes_raw().hex(),
            'ed25519': pins[0], 'curve25519': pins[1]}
        person['certificate'] = {'body': body, 'signature': device.sign(canonical(body)).hex()}
        self.authority.publish(person['user'], person['claim'], person['certificate'], now=102)
        return person

    def proof(self, members=None, **kwargs):
        return self.authority.attest(self.alice['user'], self.alice['claim'], 'dm', self.scope,
            members or [self.alice['user'], self.bob['user']], 'f'*64, now=103, **kwargs)

    def test_archive_key_signer_requires_historical_owner_admission(self):
        alice = self.alice
        public = alice['device_root'].public_key().public_bytes_raw().hex()
        proof = self.authority.archive_device(alice['user'], alice['claim'], alice['device'], public, 'f'*64, now=103)
        self.key.public_key().verify(bytes.fromhex(proof['signature']), canonical(proof['body']))
        rogue = Ed25519PrivateKey.generate().public_key().public_bytes_raw()
        for device, key in [(device_id(rogue), rogue.hex()),
                            (self.bob['device'], self.bob['device_root'].public_key().public_bytes_raw().hex())]:
            with self.assertRaisesRegex(ValueError, 'not_admitted'):
                self.authority.archive_device(alice['user'], alice['claim'], device, key, 'f'*64, now=103)
        replacement = Ed25519PrivateKey.generate()
        self.event(alice, 'enroll', replacement)
        device = device_id(replacement.public_key().public_bytes_raw())
        body = self.backend.challenge(alice['user'], 'archive-new-device', alice['owner'], device, now=104)
        claim = self.backend.complete(alice['user'], 'archive-new-device', body['challenge'],
            alice['root'].sign(canonical(body)).hex(), replacement.sign(canonical(body)).hex(), 700, now=105)
        self.event(alice, 'revoke', alice['device_root'])
        proof = self.authority.archive_device(alice['user'], claim, alice['device'], public, 'e'*64, now=106)
        self.assertEqual(proof['body']['device'], device)
        self.assertEqual(proof['body']['archive_device'], alice['device'])
        self.key.public_key().verify(bytes.fromhex(proof['signature']), canonical(proof['body']))
        with self.assertRaisesRegex(ValueError, 'revoked'):
            self.authority.archive_device(alice['user'], alice['claim'], alice['device'], public, 'f'*64, now=106)
        self.directory.available = False
        with self.assertRaises(ConsensusUnavailable):
            self.authority.archive_device(alice['user'], claim, alice['device'], public, 'f'*64, now=106)

    def test_signed_scope_exact_devices_and_restart_epoch(self):
        proof = self.proof()
        self.key.public_key().verify(bytes.fromhex(proof['signature']), canonical(proof['body']))
        self.assertEqual(proof['body']['epoch'], 1)
        self.assertEqual(len(proof['body']['certificates']), 2)
        self.assertEqual(proof['body']['membership_authority'], 'selected_application')
        other = ApplicationSessions(self.path, self.directory, self.entry, entry_key=self.key)
        self.addCleanup(other.close)
        self.assertEqual(CipherAuthority(other).attest(self.alice['user'], self.alice['claim'], 'dm', self.scope,
            [self.bob['user'], self.alice['user']], 'd'*64, now=104)['body']['epoch'], 1)
        carol = self.person()
        self.assertEqual(self.proof([self.alice['user'], self.bob['user'], carol['user']])['body']['epoch'], 2)
        self.assertEqual(self.proof()['body']['epoch'], 3)

    def test_bad_signature_context_and_immutable_device_pins(self):
        for field, value in [('owner', self.bob['owner']), ('genesis', 'b'*64), ('device', self.bob['device']), ('ed25519', 'A'*43)]:
            cert = copy.deepcopy(self.alice['certificate']); cert['body'][field] = value
            with self.assertRaises(ValueError):
                self.authority.publish(self.alice['user'], self.alice['claim'], cert, now=103)
        cert = copy.deepcopy(self.alice['certificate']); cert['body']['ed25519'] = 'A'*43
        cert['signature'] = self.alice['device_root'].sign(canonical(cert['body'])).hex()
        with self.assertRaisesRegex(ValueError, 'immutable'):
            self.authority.publish(self.alice['user'], self.alice['claim'], cert, now=103)
        with self.assertRaisesRegex(ValueError, 'session_mismatch'):
            self.authority.publish(self.bob['user'], self.bob['claim'], self.alice['certificate'], now=103)

    def test_unbound_extra_device_cannot_be_silently_omitted(self):
        self.event(self.bob, 'enroll', Ed25519PrivateKey.generate())
        with self.assertRaisesRegex(ValueError, 'device_not_bound'):
            self.proof()
        self.assertEqual(self.backend.db.execute('SELECT COUNT(*) FROM cipher_scopes').fetchone()[0], 0)

    def test_revocation_and_consensus_outage_stop_authorization(self):
        self.proof()
        self.event(self.bob, 'revoke')
        # At least two devices are required. Bob cannot retain his old SDK key.
        with self.assertRaisesRegex(ValueError, 'no_active_device'):
            self.proof()
        self.directory.available = False
        with self.assertRaises(ConsensusUnavailable):
            self.proof()
        self.directory.available = True
        self.event(self.alice, 'revoke')
        with self.assertRaises(ValueError):
            self.proof()

    def test_cached_certificate_corruption_is_never_attested(self):
        cert = copy.deepcopy(self.bob['certificate']); cert['signature'] = '0'*128
        with self.backend.db:
            self.backend.db.execute('UPDATE cipher_devices SET certificate=? WHERE owner=?', (canonical(cert), self.bob['owner']))
        with self.assertRaisesRegex(ValueError, 'signature'):
            self.proof()

    def test_acl_change_during_verification_does_not_advance_epoch(self):
        original = self.proof()
        carol = self.person()
        members = [self.alice['user'], self.bob['user'], carol['user']]
        with self.assertRaisesRegex(ValueError, 'acl_changed'):
            self.proof(members, revalidate=lambda: [self.alice['user'], self.bob['user']])
        self.assertEqual(self.proof()['body']['epoch'], original['body']['epoch'])

    def test_corrupt_epoch_checkpoint_is_not_signed(self):
        self.proof()
        with self.backend.db:
            self.backend.db.execute('UPDATE cipher_scopes SET epoch=-1')
        with self.assertRaisesRegex(ValueError, 'checkpoint_corrupt'):
            self.proof()

    def test_no_self_declared_members_or_foreign_user_claim(self):
        with self.assertRaises(ValueError):
            self.proof([self.bob['user']])
        with self.assertRaises(ValueError):
            self.proof([self.alice['user'], self.bob['user'], str(uuid.uuid4())])
        with self.assertRaises(ValueError):
            self.authority.attest(self.bob['user'], self.alice['claim'], 'dm', self.scope,
                [self.alice['user'], self.bob['user']], 'e'*64, now=103)

    def test_certificate_is_portable_but_authority_pin_is_per_entry(self):
        second_key = Ed25519PrivateKey.generate()
        second = ApplicationSessions(str(Path(self.temp.name) / 'second.sqlite'), self.directory,
            node_id(second_key.public_key().public_bytes_raw()), entry_key=second_key)
        self.addCleanup(second.close)
        authority = CipherAuthority(second)
        claims = {}
        for person in (self.alice, self.bob):
            body = second.challenge(person['user'], 'new-entry', person['owner'], person['device'], now=100)
            claims[person['user']] = second.complete(person['user'], 'new-entry', body['challenge'],
                person['root'].sign(canonical(body)).hex(), person['device_root'].sign(canonical(body)).hex(), 700, now=101)
            authority.publish(person['user'], claims[person['user']], person['certificate'], now=102)
        first = self.proof()
        other = authority.attest(self.alice['user'], claims[self.alice['user']], 'dm', self.scope,
            [self.alice['user'], self.bob['user']], 'f'*64, now=103)
        self.assertEqual(first['body']['certificates'], other['body']['certificates'])
        self.assertNotEqual(first['body']['entry'], other['body']['entry'])
        self.assertNotEqual(first['signature'], other['signature'])


if __name__ == '__main__':
    unittest.main()
