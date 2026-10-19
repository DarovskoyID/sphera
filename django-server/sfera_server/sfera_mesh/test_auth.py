import copy
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .auth import MeshAuth
from .certificates import Committee
from .directory import AccountDirectory, validate_record
from .identity import node_id
from .storage import canonical
from .test_directory import record, certificate


def read_lease(directory, committee, keys, now, voters=3):
    anchor = directory.latest_checkpoint()
    body = {'domain': 'sfera-mesh-directory-read-v1', 'network': committee.network, 'committee': committee.identifier,
            'height': anchor['height'], 'checkpoint_hash': anchor['checkpoint_hash'], 'issued_at': now, 'expires_at': now + 60}
    return {'body': body, 'votes': [(committee.members[i][0], key.sign(canonical(body)).hex()) for i, key in enumerate(keys[:voters])]}


class AuthTests(unittest.TestCase):
    def setUp(self):
        self.folder = TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.keys = [Ed25519PrivateKey.generate() for _ in range(4)]
        self.committee = Committee('lab', 1, tuple((node_id(key.public_key().public_bytes_raw()), key.public_key().public_bytes_raw()) for key in self.keys))
        self.owner = Ed25519PrivateKey.generate()
        self.entry = Ed25519PrivateKey.generate()
        self.directory = AccountDirectory(str(Path(self.folder.name) / 'directory.sqlite'), 'lab', self.committee)
        self.addCleanup(self.directory.close)
        self.first = record(self.owner)
        self.identity = self.first['body']['user_id']
        self.directory.save(self.first)
        self.cert1 = certificate(self.committee, self.keys, self.first)
        self.final1 = self.directory.confirm(self.cert1)
        self.path = str(Path(self.folder.name) / 'auth.sqlite')
        self.auth = MeshAuth(self.path, self.entry, self.directory)
        self.addCleanup(lambda: self.auth.close())

    def ready(self, now=100):
        return self.auth.set_read_lease(read_lease(self.directory, self.committee, self.keys, now), now=now)

    def proof(self, challenge):
        return self.owner.sign(canonical(challenge['body'])).hex()

    def test_fresh_finality_single_use_and_hashed_token(self):
        with self.assertRaises(ValueError): self.auth.challenge(self.identity, 'a' * 64, now=100)
        bad = read_lease(self.directory, self.committee, self.keys, 100, voters=2)
        with self.assertRaises(ValueError): self.auth.set_read_lease(bad, now=100)
        self.ready()
        other_owner = record(Ed25519PrivateKey.generate())
        self.directory.save(other_owner)
        with self.assertRaises(ValueError): self.auth.challenge(other_owner['body']['user_id'], 'f' * 64, now=100)
        challenge = self.auth.challenge(self.identity, 'a' * 64, now=100)
        self.assertEqual(challenge, self.auth.challenge(self.identity, 'a' * 64, now=101))
        with self.assertRaises(ValueError): self.auth.complete(challenge['body']['challenge_id'], '0' * 128, now=101)
        result = self.auth.complete(challenge['body']['challenge_id'], self.proof(challenge), now=101)
        token = result['body']['token']
        self.entry.public_key().verify(bytes.fromhex(result['signature']), canonical(result['body']))
        self.assertNotIn(token, '\n'.join(self.auth.db.iterdump()))
        self.assertEqual(self.auth.session(token, 'b' * 64, now=102)['body']['user_id'], self.identity)
        with self.assertRaises(ValueError): self.auth.complete(challenge['body']['challenge_id'], self.proof(challenge), now=102)
        with self.assertRaises(ValueError): self.auth.challenge(self.identity, 'a' * 64, now=102)
        self.assertTrue(self.auth.logout(token, 'c' * 64, now=103)['body']['revoked'])
        self.assertTrue(self.auth.logout(token, 'd' * 64, now=103)['body']['revoked'])
        with self.assertRaises(ValueError): self.auth.session(token, 'e' * 64, now=104)

    def test_expiry_refresh_and_logout_without_validators(self):
        self.ready()
        challenge = self.auth.challenge(self.identity, 'a' * 64, now=100)
        token = self.auth.complete(challenge['body']['challenge_id'], self.proof(challenge), now=101)['body']['token']
        with self.assertRaises(ValueError): self.auth.session(token, 'b' * 64, now=160)
        self.ready(now=160)
        self.assertEqual(self.auth.session(token, 'b' * 64, now=161)['body']['state'], 'active')
        with self.assertRaises(ValueError): self.auth.complete(challenge['body']['challenge_id'], self.proof(challenge), now=161)
        self.assertTrue(self.auth.logout(token, 'c' * 64, now=222)['body']['revoked'])
        self.ready(now=700)
        with self.assertRaises(ValueError): self.auth.session(token, 'd' * 64, now=701)

    def test_unused_challenge_and_live_token_have_hard_expiry(self):
        self.ready()
        unused = self.auth.challenge(self.identity, 'a' * 64, now=100)
        self.ready(now=160)
        with self.assertRaises(ValueError): self.auth.complete(unused['body']['challenge_id'], self.proof(unused), now=160)
        fresh = self.auth.challenge(self.identity, 'b' * 64, now=160)
        token = self.auth.complete(fresh['body']['challenge_id'], self.proof(fresh), now=161)['body']['token']
        self.ready(now=760)
        self.assertEqual(self.auth.db.execute('SELECT revoked FROM mesh_sessions').fetchone()[0], 0)
        with self.assertRaises(ValueError): self.auth.session(token, 'c' * 64, now=761)

    def test_entry_point_and_restart(self):
        self.ready()
        challenge = self.auth.challenge(self.identity, 'a' * 64, now=100)
        token = self.auth.complete(challenge['body']['challenge_id'], self.proof(challenge), now=101)['body']['token']
        self.auth.close()
        self.auth = MeshAuth(self.path, self.entry, self.directory)
        self.assertEqual(self.auth.session(token, 'b' * 64, now=102)['body']['user_id'], self.identity)
        with self.assertRaises(ValueError): self.auth.complete(challenge['body']['challenge_id'], self.proof(challenge), now=102)
        other = MeshAuth(':memory:', Ed25519PrivateKey.generate(), self.directory)
        try:
            other.set_read_lease(read_lease(self.directory, self.committee, self.keys, 100), now=100)
            with self.assertRaises(ValueError): other.session(token, 'c' * 64, now=102)
            with self.assertRaises(ValueError): other.complete(challenge['body']['challenge_id'], self.proof(challenge), now=102)
        finally:
            other.close()
        with self.assertRaises(ValueError): MeshAuth(self.path, Ed25519PrivateKey.generate(), self.directory)

    def test_changed_checkpoint_invalidates_old_login_request(self):
        self.ready()
        challenge = self.auth.challenge(self.identity, 'a' * 64, now=100)
        second = record(self.owner, 2, validate_record(self.first, 'lab')[1])
        self.directory.save(second)
        self.directory.confirm(certificate(self.committee, self.keys, second, 2, self.final1['checkpoint_hash']))
        with self.assertRaises(ValueError): self.auth.complete(challenge['body']['challenge_id'], self.proof(challenge), now=101)
        self.ready(now=101)
        with self.assertRaises(ValueError): self.auth.complete(challenge['body']['challenge_id'], self.proof(challenge), now=101)
        fresh = self.auth.challenge(self.identity, 'b' * 64, now=101)
        self.assertEqual(fresh['body']['account_version'], 2)

    def test_concurrent_proof_consumption_and_pending_limits(self):
        self.ready()
        challenge = self.auth.challenge(self.identity, 'a' * 64, now=100)
        def finish(_):
            try:
                return self.auth.complete(challenge['body']['challenge_id'], self.proof(challenge), now=101)
            except ValueError:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(finish, range(2)))
        self.assertEqual(sum(result is not None for result in results), 1)
        limited = MeshAuth(':memory:', self.entry, self.directory, pending_limit=2, per_user_limit=2)
        try:
            limited.set_read_lease(read_lease(self.directory, self.committee, self.keys, 100), now=100)
            limited.challenge(self.identity, 'b' * 64, now=100)
            limited.challenge(self.identity, 'c' * 64, now=100)
            with self.assertRaises(ValueError): limited.challenge(self.identity, 'd' * 64, now=100)
        finally:
            limited.close()

    def test_read_lease_context_replay_and_tampering(self):
        lease = read_lease(self.directory, self.committee, self.keys, 100)
        changed = copy.deepcopy(lease)
        changed['body']['checkpoint_hash'] = '0' * 64
        with self.assertRaises(ValueError): self.auth.set_read_lease(changed, now=100)
        repeated = copy.deepcopy(lease)
        repeated['votes'][-1] = repeated['votes'][0]
        with self.assertRaises(ValueError): self.auth.set_read_lease(repeated, now=100)
        with self.assertRaises(ValueError): self.auth.set_read_lease(lease, now=160)
        self.ready(now=110)
        with self.assertRaises(ValueError): self.auth.set_read_lease(lease, now=110)
        with self.assertRaises(ValueError): self.auth.execute('challenge', {'user_id': self.identity, 'client_nonce': 'a' * 64, 'password': 'must-not-be-accepted'})


    def test_http_unavailable_directory_is_not_logout(self):
        import json
        import threading
        from unittest.mock import patch
        from urllib.request import Request, build_opener, ProxyHandler
        from urllib.error import HTTPError
        from .identity import EnvelopeVerifier
        from .transport import BlobStore, LabServer
        self.ready()
        challenge = self.auth.challenge(self.identity, 'a' * 64, now=100)
        token = self.auth.complete(challenge['body']['challenge_id'], self.proof(challenge), now=101)['body']['token']
        public = self.entry.public_key().public_bytes_raw()
        check = EnvelopeVerifier('lab', self.auth.entry_node, {self.auth.entry_node: public}, ':memory:')
        blobs = BlobStore(':memory:')
        server = LabServer(self.entry, check, blobs, self.directory, self.auth)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        opener = build_opener(ProxyHandler({}))
        def request(operation):
            return Request(server.endpoint + '/mesh-lab/auth/' + operation, data=canonical({'client_nonce': 'b' * 64}), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, method='POST')
        try:
            with patch('sfera_mesh.auth.time.time', return_value=161):
                with self.assertRaises(HTTPError) as failure:
                    opener.open(request('session'), timeout=3)
                self.assertEqual(failure.exception.code, 503)
                self.assertEqual(json.loads(failure.exception.read()), {'error': 'mesh_directory_unavailable'})
                failure.exception.close()
                with opener.open(request('logout'), timeout=3) as response:
                    self.assertTrue(json.loads(response.read())['body']['revoked'])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
            check.close()
            blobs.close()
