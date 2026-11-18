import copy
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import unittest
import uuid

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .application_sessions import ApplicationSessions
from .consensus_directory import ConsensusUnavailable
from .devices import DeviceRegistry, DOMAIN, device_id, verify_event
from .directory import user_id, ZERO
from .storage import canonical


class Directory:
    network, pin = 'lab', 'a' * 64

    def __init__(self, owner):
        self.lock, self.events, self.available = threading.RLock(), [], True
        self.owner = owner.public_key().public_bytes_raw().hex()

    def device_history(self, identity):
        if not self.available:
            raise ConsensusUnavailable('offline')
        if identity != user_id(bytes.fromhex(self.owner)):
            raise ValueError('unknown_owner')
        return {'owner_public': self.owner, 'events': copy.deepcopy(self.events),
                'version': len(self.events), 'digest': verify_event(self.events[-1], self.network, self.owner)[1] if self.events else ZERO,
                'finality': {'expires_at': 130}}


class ApplicationSessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.owner, self.device = Ed25519PrivateKey.generate(), Ed25519PrivateKey.generate()
        self.directory = Directory(self.owner)
        self.user, self.jti = str(uuid.uuid4()), uuid.uuid4().hex
        self.identity = user_id(bytes.fromhex(self.directory.owner))
        self.did = device_id(self.device.public_key().public_bytes_raw())
        self.path = str(Path(self.temp.name) / 'sessions.sqlite')
        self.backend = ApplicationSessions(self.path, self.directory, 'b' * 64)
        self.addCleanup(self.backend.close)
        self.event('enroll')

    def event(self, operation):
        events = self.directory.events
        body = {'domain': DOMAIN, 'network': 'lab', 'user_id': self.identity,
                'version': len(events) + 1, 'previous': verify_event(events[-1], 'lab', self.directory.owner)[1] if events else ZERO,
                'operation': operation, 'device_id': self.did,
                'device_public': self.device.public_key().public_bytes_raw().hex()}
        events.append({'body': body, 'owner_signature': self.owner.sign(canonical(body)).hex(),
                       'device_signature': self.device.sign(canonical(body)).hex() if operation == 'enroll' else ''})

    def challenge(self):
        return self.backend.challenge(self.user, self.jti, self.identity, self.did, now=100)

    def complete(self, body, **kwargs):
        return self.backend.complete(self.user, self.jti, body['challenge'],
                                     self.owner.sign(canonical(body)).hex(), self.device.sign(canonical(body)).hex(),
                                     700, now=101, **kwargs)

    def test_both_signatures_single_use_and_restart(self):
        body = self.challenge()
        with self.assertRaises(ValueError):
            self.backend.complete(self.user, self.jti, body['challenge'], self.owner.sign(canonical(body)).hex(), '0'*128, 700, now=101)
        claim = self.complete(body)
        self.backend.require(self.user, claim, now=102)
        with self.assertRaises(ValueError):
            self.complete(body)
        other = ApplicationSessions(self.path, self.directory, 'b'*64)
        self.addCleanup(other.close)
        other.require(self.user, claim, now=102)
        with self.assertRaises(ValueError):
            ApplicationSessions(self.path, self.directory, 'c'*64)
        with self.assertRaises(ValueError):
            other.require(str(uuid.uuid4()), claim, now=102)
        for field in claim:
            changed = {**claim, field: 'd'*64}
            with self.assertRaises(ValueError):
                other.require(self.user, changed, now=102)

    def test_revocation_stale_directory_and_offline_logout(self):
        claim = self.complete(self.challenge())
        self.directory.available = False
        with self.assertRaises(ConsensusUnavailable):
            self.backend.require(self.user, claim, now=102)
        self.backend.revoke(self.user, claim)
        self.directory.available = True
        with self.assertRaises(ValueError):
            self.backend.require(self.user, claim, now=102)
        fresh = self.complete(self.challenge())
        self.event('revoke')
        with self.assertRaises(ValueError):
            self.backend.require(self.user, fresh, now=102)
        with self.assertRaises(ValueError):
            self.challenge()

    def test_wrong_login_expiry_and_history_change(self):
        body = self.challenge()
        original_jti = self.jti
        self.jti = uuid.uuid4().hex
        with self.assertRaises(ValueError):
            self.complete(body)
        self.jti = original_jti
        with self.assertRaises(ValueError):
            self.backend.complete(self.user, self.jti, body['challenge'], '', '', 700, now=130)
        self.event('revoke')
        with self.assertRaises(ValueError):
            self.complete(body)

    def test_concurrent_consumption_across_connections(self):
        body = self.challenge()
        other = ApplicationSessions(self.path, self.directory, 'b'*64)
        self.addCleanup(other.close)
        def consume(backend):
            try:
                return backend.complete(self.user, self.jti, body['challenge'],
                                        self.owner.sign(canonical(body)).hex(), self.device.sign(canonical(body)).hex(), 700, now=101)
            except ValueError:
                return None
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(consume, [self.backend, other]))
        self.assertEqual(sum(result is not None for result in results), 1)

    def test_limits_and_expired_session(self):
        for _ in range(4):
            self.challenge()
        with self.assertRaises(ValueError):
            self.challenge()
        row = self.backend.db.execute('SELECT body FROM app_challenges LIMIT 1').fetchone()
        import json
        claim = self.complete(json.loads(row[0]))
        with self.assertRaises(ValueError):
            self.backend.require(self.user, claim, now=700)

    def test_identity_cannot_be_reassigned_and_login_domain_cannot_bind(self):
        self.complete(self.challenge())
        login = self.backend.login_challenge(self.identity, self.did, now=100)
        with self.assertRaises(ValueError):
            self.complete(login)
        claim = self.backend.complete(self.user, login['login_jti'], login['challenge'],
            self.owner.sign(canonical(login)).hex(), self.device.sign(canonical(login)).hex(),
            700, now=101, purpose='login')
        self.backend.require(self.user, claim, now=102)
        other_user = str(uuid.uuid4())
        body = self.backend.challenge(other_user, self.jti, self.identity, self.did, now=100)
        with self.assertRaises(ValueError):
            self.backend.complete(other_user, self.jti, body['challenge'],
                self.owner.sign(canonical(body)).hex(), self.device.sign(canonical(body)).hex(), 700, now=101)
        other = ApplicationSessions(self.path, self.directory, 'b'*64)
        self.addCleanup(other.close)
        self.assertEqual(other.login_challenge(self.identity, self.did, now=100)['application_user'], self.user)
