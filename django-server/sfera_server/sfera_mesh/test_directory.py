import copy
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import unittest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .directory import AccountDirectory, user_id, validate_record, ZERO, verify_account_result
from .certificates import Committee, statement
from .storage import canonical
from .identity import node_id, EnvelopeVerifier
from .transport import BlobStore, LabServer, exchange
from .directory_client import publish_account, resolve_account


def record(key, version=1, previous=ZERO):
    public = key.public_key().public_bytes_raw()
    body = {'domain': 'sfera-mesh-account-v1', 'network': 'lab', 'user_id': user_id(public), 'public_key': public.hex(), 'version': version, 'previous': previous, 'vault_digest': sha256(b'encrypted-vault-' + str(version).encode()).hexdigest(), 'dialogs_digest': sha256(b'encrypted-dialog-index').hexdigest()}
    return {'body': body, 'signature': key.sign(canonical(body)).hex()}


def certificate(committee, keys, item, height=1, previous=ZERO, voters=3):
    body, digest = validate_record(item, 'lab')
    checkpoint = {'kind': 'account', 'user_id': body['user_id'], 'version': body['version'], 'record_hash': digest}
    votes = [(committee.members[i][0], key.sign(statement(committee, height, previous, checkpoint)).hex()) for i, key in enumerate(keys[:voters])]
    return {'height': height, 'previous': previous, 'checkpoint': checkpoint, 'votes': votes}


class DirectoryTests(unittest.TestCase):
    def setUp(self):
        self.owner = Ed25519PrivateKey.generate()
        self.keys = [Ed25519PrivateKey.generate() for _ in range(4)]
        self.committee = Committee('lab', 1, tuple((node_id(key.public_key().public_bytes_raw()), key.public_key().public_bytes_raw()) for key in self.keys))
        self.first = record(self.owner)
        self.identity = self.first['body']['user_id']

    def test_owner_signature_context_fork_and_gap(self):
        store = AccountDirectory(':memory:', 'lab')
        try:
            first = store.save(self.first)
            self.assertEqual(store.save(self.first), first)
            tampered = copy.deepcopy(self.first)
            tampered['body']['vault_digest'] = 'a' * 64
            with self.assertRaises(ValueError): store.save(tampered)
            with self.assertRaises(ValueError): store.save(record(self.owner, 3, first['record_hash']))
            second = record(self.owner, 2, first['record_hash'])
            store.save(second)
            fork_body = {**second['body'], 'vault_digest': 'a' * 64}
            fork = {'body': fork_body, 'signature': self.owner.sign(canonical(fork_body)).hex()}
            with self.assertRaises(ValueError): store.save(fork)
            store.save(self.first)  # Idempotent historical put does not rewind head.
            self.assertEqual(store.get(self.identity)['record']['body']['version'], 2)
            self.assertEqual(store.get(self.identity, confirmed=True), {'error': 'not_found'})
            with self.assertRaises(ValueError): validate_record(self.first, 'other')
        finally:
            store.close()

    def test_invalid_owner_schema_is_rejected_even_when_signed(self):
        for changes in ({'version': True}, {'version': 0}, {'previous': 'a' * 64}, {'user_id': '0' * 64}, {'unknown': 'field'}, {'vault_digest': 'not-a-digest'}):
            body = {**self.first['body'], **changes}
            item = {'body': body, 'signature': self.owner.sign(canonical(body)).hex()}
            with self.assertRaises(ValueError): validate_record(item, 'lab')

    def test_certified_head_restart_and_rollback(self):
        with TemporaryDirectory() as temp:
            path = str(Path(temp) / 'directory.sqlite')
            store = AccountDirectory(path, 'lab', self.committee)
            receipt = store.save(self.first)
            with self.assertRaises(ValueError): store.confirm(certificate(self.committee, self.keys, self.first, voters=2))
            cert1 = certificate(self.committee, self.keys, self.first)
            final1 = store.confirm(cert1)
            second = record(self.owner, 2, receipt['record_hash'])
            store.save(second)
            self.assertFalse(store.get(self.identity)['confirmed'])
            self.assertEqual(store.get(self.identity, confirmed=True)['record']['body']['version'], 1)
            cert2 = certificate(self.committee, self.keys, second, 2, final1['checkpoint_hash'])
            store.confirm(cert2)
            store.confirm(cert1)
            self.assertEqual(store.get(self.identity, confirmed=True)['record']['body']['version'], 2)
            with self.assertRaises(ValueError): store.confirm(certificate(self.committee, self.keys, self.first, 3, sha256(statement(self.committee, 2, final1['checkpoint_hash'], cert2['checkpoint'])).hexdigest()))
            store.close()
            store = AccountDirectory(path, 'lab', self.committee)
            try:
                result = store.get(self.identity, confirmed=True)
                self.assertEqual(result['record']['body']['version'], 2)
                with self.assertRaises(ValueError): verify_account_result(result, 'lab', self.identity, require_confirmed=True)
                self.assertEqual(verify_account_result(result, 'lab', self.identity, require_confirmed=True, committee=self.committee), result)
                other = copy.deepcopy(result)
                other['certificate'] = certificate(self.committee, self.keys, record(Ed25519PrivateKey.generate()))
                with self.assertRaises(ValueError): verify_account_result(other, 'lab', self.identity, committee=self.committee)
                bad = copy.deepcopy(result)
                bad['certificate']['votes'] = bad['certificate']['votes'][:2]
                with self.assertRaises(ValueError): verify_account_result(bad, 'lab', self.identity, committee=self.committee)
            finally:
                store.close()
            with self.assertRaises(ValueError): AccountDirectory(path, 'other', None)

    def test_bounded_sync_progress_and_equivocation_detection(self):
        from unittest.mock import patch
        cache = AccountDirectory(':memory:', 'lab')
        first = self.first
        second = record(self.owner, 2, validate_record(first, 'lab')[1])
        third = record(self.owner, 3, validate_record(second, 'lab')[1])
        records = [first, second, third]
        verifier = type('Verifier', (), {'network': 'lab'})()
        def reply(endpoint, key, verifier, recipient, operation, payload, **kwargs):
            item = records[-1] if payload['version'] is None else records[payload['version'] - 1]
            return {'record': item, 'record_hash': validate_record(item, 'lab')[1], 'confirmed': False, 'certificate': None}
        try:
            with patch('sfera_mesh.directory_client.exchange', side_effect=reply):
                partial = resolve_account(self.identity, [('peer', 'endpoint')], None, verifier, cache, batch_limit=2)
                self.assertFalse(partial['synced'])
                self.assertEqual(partial['account']['record']['body']['version'], 2)
                complete = resolve_account(self.identity, [('peer', 'endpoint')], None, verifier, cache, batch_limit=2)
                self.assertTrue(complete['synced'])
            body = {**third['body'], 'vault_digest': 'f' * 64}
            fork = {'body': body, 'signature': self.owner.sign(canonical(body)).hex()}
            def fork_reply(endpoint, *args, **kwargs):
                item = third if endpoint == 'one' else fork
                return {'record': item, 'record_hash': validate_record(item, 'lab')[1], 'confirmed': False, 'certificate': None}
            with patch('sfera_mesh.directory_client.exchange', side_effect=fork_reply):
                with self.assertRaises(ValueError): resolve_account(self.identity, [('p1', 'one'), ('p2', 'two')], None, verifier, cache)
        finally:
            cache.close()


class SevenNodeDirectoryTests(unittest.TestCase):
    def test_other_entry_point_resolves_replicated_account_and_verifies_certificate(self):
        with TemporaryDirectory() as temp:
            keys = [Ed25519PrivateKey.generate() for _ in range(7)]
            ids = [node_id(key.public_key().public_bytes_raw()) for key in keys]
            roster = {identity: key.public_key().public_bytes_raw() for identity, key in zip(ids, keys)}
            committee = Committee('lab', 1, tuple((ids[i], keys[i].public_key().public_bytes_raw()) for i in range(4)))
            checks, blobs, directories, servers, threads = [], [], [], [], []
            stopped = set()
            try:
                for i in range(7):
                    checks.append(EnvelopeVerifier('lab', ids[i], roster, str(Path(temp) / f'{i}-nonces.sqlite')))
                    blobs.append(BlobStore(str(Path(temp) / f'{i}-blobs.sqlite')))
                    directories.append(AccountDirectory(str(Path(temp) / f'{i}-directory.sqlite'), 'lab', committee))
                    servers.append(LabServer(keys[i], checks[i], blobs[i], directories[i]))
                    thread = threading.Thread(target=servers[i].serve_forever, daemon=True)
                    thread.start()
                    threads.append(thread)
                owner = Ed25519PrivateKey.generate()
                first = record(owner)
                identity = first['body']['user_id']
                peers = [(ids[i], servers[i].endpoint) for i in range(3)]
                self.assertEqual(len(publish_account(first, peers, keys[6], checks[6])), 3)
                cert = certificate(committee, keys, first)
                exchange(servers[1].endpoint, keys[6], checks[6], ids[1], 'account-confirm', {'certificate': cert}, committee=committee)
                final = exchange(servers[1].endpoint, keys[6], checks[6], ids[1], 'account-get', {'user_id': identity, 'version': None, 'confirmed': True}, committee=committee)
                self.assertTrue(final['confirmed'])
                with self.assertRaises(ValueError):
                    exchange(servers[1].endpoint, keys[6], checks[6], ids[1], 'account-get', {'user_id': identity, 'version': None, 'confirmed': True})
                servers[0].shutdown()
                servers[0].server_close()
                stopped.add(0)
                resolved = resolve_account(identity, peers, keys[6], checks[6], directories[6])
                self.assertTrue(resolved['synced'])
                self.assertEqual(resolved['account']['record']['body']['vault_digest'], first['body']['vault_digest'])
                self.assertFalse(resolved['account']['confirmed'])  # Lookup isn't BFT finalisation.
                second = record(owner, 2, validate_record(first, 'lab')[1])
                # Only one live peer advances; resolver finds it instead of taking first reply.
                publish_account(second, [peers[2]], keys[6], checks[6])
                resolved = resolve_account(identity, peers, keys[6], checks[6], directories[6])
                self.assertEqual(resolved['account']['record']['body']['version'], 2)
                with self.assertRaises(ValueError): resolve_account(identity, [peers[1]], keys[6], checks[6], directories[6])
            finally:
                for i, server in enumerate(servers):
                    if i not in stopped:
                        server.shutdown()
                        server.server_close()
                for thread in threads: thread.join(timeout=2)
                for directory in directories: directory.close()
                for blob in blobs: blob.close()
                for check in checks: check.close()
