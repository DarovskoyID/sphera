from dataclasses import replace
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import time
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .identity import node_id, EnvelopeVerifier
from .replication import ReplicaJournal
from .topology import Candidate, module_available
from .transport import BlobStore, LabServer
from .storage import Storage


class ReplicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.keys = [Ed25519PrivateKey.generate() for _ in range(7)]
        self.ids = [node_id(key.public_key().public_bytes_raw()) for key in self.keys]
        roster = {identity: key.public_key().public_bytes_raw() for identity, key in zip(self.ids, self.keys)}
        self.checks = [EnvelopeVerifier('replica-lab', identity, roster, ':memory:') for identity in self.ids]
        self.stores = [BlobStore(str(Path(self.temp.name) / f'blob-{i}.sqlite')) for i in range(7)]
        self.servers = [LabServer(key, check, store) for key, check, store in zip(self.keys, self.checks, self.stores)]
        self.threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in self.servers]
        for thread in self.threads:
            thread.start()
        self.endpoints = {node: server.endpoint for node, server in zip(self.ids, self.servers)}
        self.profiles = [Candidate(node, f'domain-{i}', frozenset({'office'}), grant_verified=True, grant_expires_at=int(time.time()) + 300) for i, node in enumerate(self.ids)]
        self.path = str(Path(self.temp.name) / 'journal.sqlite')
        self.journal = ReplicaJournal(self.path, self.keys[0], self.checks[0], self.endpoints)
        self.journal.register_cluster('A', self.profiles[:3])
        self.journal.register_cluster('B', self.profiles[3:6])

    def tearDown(self):
        self.journal.close()
        for server in self.servers:
            server.shutdown()
            server.server_close()
        for thread in self.threads:
            thread.join(2)
        for check in self.checks:
            check.close()
        for store in self.stores:
            store.close()
        self.temp.cleanup()

    def reopen(self):
        self.journal.close()
        self.journal = ReplicaJournal(self.path, self.keys[0], self.checks[0], self.endpoints)

    def test_restart_repair_borrowed_node_then_new_spare(self):
        data = b'encrypted message block; no plaintext user data'
        digest = self.journal.stage('A', data)
        self.assertEqual(self.journal.stage('A', data), digest)
        self.assertEqual(self.journal.run_batch('A')['processed'], 1)
        self.assertTrue(self.journal.status('A', digest)['replicated'])
        self.assertFalse(self.journal.status('A', digest)['consensus_committed'])
        self.servers[2].shutdown()
        self.servers[2].server_close()
        profiles = [replace(node, capacity_ok=False) if i in (2, 6) else node for i, node in enumerate(self.profiles)]
        for invalid in ([replace(node, grant_expires_at=None) for node in profiles], [replace(node, grant_expires_at=1) for node in profiles]):
            with self.assertRaises(ValueError):
                self.journal.replace_failed('A', self.ids[2], invalid, expected_epoch=1)
        plan = self.journal.replace_failed('A', self.ids[2], profiles, expected_epoch=1)
        self.assertTrue(plan['temporary'])
        self.assertIn(plan['replacement'], self.ids[3:6])
        with self.journal.db:
            self.journal.db.execute('UPDATE replica_jobs SET payload=NULL')
        self.reopen()
        self.journal.run_batch('A')
        self.assertTrue(self.journal.status('A', digest)['replicated'])
        target = self.ids.index(plan['replacement'])
        self.assertEqual(self.stores[target].execute('get', {'digest': digest})['ciphertext'], data.hex())
        with self.assertRaises(ValueError):
            self.journal.register_cluster('C', [self.profiles[target], self.profiles[2], self.profiles[6]])
        with self.assertRaises(ValueError):
            self.journal.replace_failed('A', self.ids[2], profiles, expected_epoch=1)
        profiles[6] = self.profiles[6]
        permanent = self.journal.replace_failed('A', plan['replacement'], profiles, expected_epoch=2)
        self.assertEqual(permanent['replacement'], self.ids[6])
        self.assertFalse(permanent['temporary'])
        self.journal.run_batch('A')
        self.assertTrue(self.journal.status('A', digest)['replicated'])
        self.assertEqual(self.journal._memberships(plan['replacement']), frozenset({'B'}))
        # Repair never deletes the old copy or grants modules to the entry point.
        self.assertEqual(self.stores[target].execute('get', {'digest': digest})['ciphertext'], data.hex())
        self.assertFalse(module_available(set(), {'office'}, 'office', True))

    def test_missing_ciphertext_is_reported_not_invented_and_survives_restart(self):
        digest = self.journal.stage('A', b'ciphertext')
        with self.journal.db:
            self.journal.db.execute('UPDATE replica_jobs SET payload=NULL')
        self.journal.run_batch('A')
        status = self.journal.status('A', digest)
        self.assertEqual(status['error'], 'missing_on_known_replicas')
        self.assertFalse(status['replicated'])
        self.assertEqual(status['copies'], [])
        self.assertEqual(self.journal.run_batch('A')['processed'], 0)  # Persistent backoff.
        self.reopen()
        self.assertEqual(self.journal.status('A', digest), status)
        self.assertEqual(self.journal.run_batch('A')['processed'], 0)
        self.servers[2].shutdown()
        self.servers[2].server_close()
        with self.journal.db:
            self.journal.db.execute('UPDATE replica_jobs SET retry_at=0')
        self.journal.run_batch('A')
        self.assertEqual(self.journal.status('A', digest)['error'], 'source_unavailable')

    def test_old_layout_receipts_cannot_complete_new_repair(self):
        digest = self.journal.stage('A', b'encrypted block')
        other = ReplicaJournal(self.path, self.keys[0], self.checks[0], self.endpoints)
        original = self.journal._request
        changed = False
        def concurrent_plan(node, operation, payload):
            nonlocal changed
            result = original(node, operation, payload)
            if not changed:
                changed = True
                other.replace_failed('A', self.ids[2], self.profiles, expected_epoch=1)
            return result
        try:
            with patch.object(self.journal, '_request', side_effect=concurrent_plan):
                self.journal.run_batch('A')
            status = self.journal.status('A', digest)
            self.assertEqual(status['epoch'], 2)
            self.assertFalse(status['replicated'])
            self.assertEqual(status['copies'], [])
            self.journal.run_batch('A')
            self.assertTrue(self.journal.status('A', digest)['replicated'])
        finally:
            other.close()

    def test_bad_replica_and_cache_do_not_count_as_verified_copy(self):
        data = b'encrypted bytes'
        digest = self.journal.stage('A', data)
        self.journal.run_batch('A')
        with self.stores[1].db:
            self.stores[1].db.execute('UPDATE blobs SET data=? WHERE digest=?', (b'corrupt', digest))
        with self.journal.db:
            self.journal.db.execute("UPDATE replica_jobs SET payload=?,state='pending',retry_at=0", (b'corrupt-cache',))
        actual = self.stores[1].execute
        def lying_read(operation, payload):
            if operation == 'get':
                return {'digest': digest, 'ciphertext': b'wrong ciphertext'.hex()}
            return actual(operation, payload)
        with patch.object(self.stores[1], 'execute', side_effect=lying_read):
            self.journal.run_batch('A')
        status = self.journal.status('A', digest)
        self.assertEqual(len(status['copies']), 2)
        self.assertFalse(status['replicated'])
        self.assertEqual(status['error'], 'copies_incomplete')
        # Even a signed response from a known node must contain the right bytes.
        self.assertNotIn(self.ids[1], [node for node, checked in status['copies']])
        self.assertEqual(sha256(data).hexdigest(), digest)
        with self.journal.db:
            self.journal.db.execute('UPDATE replica_jobs SET retry_at=0')
        self.journal.run_batch('A')
        self.assertTrue(self.journal.status('A', digest)['replicated'])
        self.assertEqual(self.stores[1].execute('get', {'digest': digest})['ciphertext'], data.hex())

    def test_indexed_manifest_pages_resume_without_history_walk(self):
        storage = Storage(':memory:', ':memory:')
        try:
            for i in range(7):
                storage.append('dialog', f'block-{i}', 'A' if i % 2 == 0 else 'B', [f'ciphertext-{i}'.encode()])
            checkpoint = storage.checkpoint('dialog')
            cursor, count = None, 0
            while True:
                page = self.journal.enqueue_manifest(storage, 'A', after=cursor, limit=1)
                count += page['enqueued']
                cursor = page['cursor']
                if not page['more_possible']:
                    break
            self.assertEqual(count, 4)
            self.assertEqual(self.journal.run_batch('A', limit=1)['processed'], 1)
            self.assertEqual(self.journal.run_batch('A')['processed'], 3)
            with storage.payload:
                storage.payload.execute("DELETE FROM payloads WHERE block_id IN ('block-0','block-2','block-4','block-6')")
            with self.journal.db:
                self.journal.db.execute("UPDATE replica_jobs SET payload=NULL,state='pending',retry_at=0")
            self.reopen()
            self.journal.enqueue_manifest(storage, 'A')  # Hash references survive missing local bytes.
            self.journal.run_batch('A')
            for _, _, _, digest in storage.affected_page('A'):
                self.assertTrue(self.journal.status('A', digest)['replicated'])
            restored = self.journal.restore_manifest_page(storage, 'A')
            self.assertEqual(restored['restored'], 4)
            self.assertEqual(storage.read('block-2'), (b'ciphertext-2',))
            with self.assertRaises(ValueError):
                storage.restore_payload('block-2', b'forged ciphertext')
            self.assertEqual(storage.checkpoint('dialog'), checkpoint)
            self.assertEqual(len(storage.affected_page('B')), 3)
        finally:
            storage.close()

    def test_required_consensus_mode_cannot_be_disabled_by_reopening(self):
        self.journal.close()
        self.journal = ReplicaJournal(self.path, self.keys[0], self.checks[0], self.endpoints, require_consensus=True)
        self.reopen()  # Default False must not erase the persisted requirement.
        with self.assertRaises(ValueError):
            self.journal.stage('A', b'encrypted bytes')
        with self.assertRaises(ValueError):
            self.journal.run_batch('A')
        with self.assertRaises(ValueError):
            self.journal.register_cluster('C', self.profiles[:3])


if __name__ == '__main__':
    unittest.main()
