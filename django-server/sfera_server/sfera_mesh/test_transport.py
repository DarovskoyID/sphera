import copy
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import unittest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .identity import create_identity, load_identity, node_id, envelope, EnvelopeVerifier
from .transport import BlobStore, LabServer, exchange


class IdentityTests(unittest.TestCase):
    def test_identity_survives_restart_and_cannot_be_overwritten(self):
        with TemporaryDirectory() as temp:
            path = Path(temp) / "node.key"
            key = create_identity(path)
            self.assertEqual(key.private_bytes_raw(), load_identity(path).private_bytes_raw())
            with self.assertRaises(FileExistsError): create_identity(path)
            self.assertEqual(key.private_bytes_raw(), load_identity(path).private_bytes_raw())

    def test_signature_context_time_and_persistent_replay(self):
        key = Ed25519PrivateKey.generate()
        public = key.public_key().public_bytes_raw()
        sender = node_id(public)
        with TemporaryDirectory() as temp:
            path = str(Path(temp) / "replays.sqlite")
            check = EnvelopeVerifier("n", "recipient", {sender: public}, path)
            valid = envelope(key, "n", "recipient", "put", {"ciphertext": "abc"}, now=100)
            modified = copy.deepcopy(valid)
            modified["record"]["payload"] = {"ciphertext": "changed"}
            with self.assertRaises(ValueError): check.verify(modified, "put", now=100)
            with self.assertRaises(ValueError): check.verify(valid, "get", now=100)
            with self.assertRaises(ValueError): check.verify(valid, "put", now=161)
            self.assertEqual(check.verify(valid, "put", now=100)[0], sender)
            check.close()
            check = EnvelopeVerifier("n", "recipient", {sender: public}, path)
            try:
                with self.assertRaises(ValueError): check.verify(valid, "put", now=101)
                wrong = envelope(key, "other-network", "recipient", "put", {}, now=101)
                with self.assertRaises(ValueError): check.verify(wrong, "put", now=101)
            finally:
                check.close()


class SevenNodeTransportTests(unittest.TestCase):
    def test_ciphertext_replication_node_failure_and_replacement(self):
        with TemporaryDirectory() as temp:
            keys = [Ed25519PrivateKey.generate() for _ in range(7)]
            ids = [node_id(k.public_key().public_bytes_raw()) for k in keys]
            roster = {identity: key.public_key().public_bytes_raw() for identity, key in zip(ids, keys)}
            checks, stores, servers, threads = [], [], [], []
            stopped = set()
            try:
                for i in range(7):
                    checks.append(EnvelopeVerifier("lab", ids[i], roster, str(Path(temp) / f"{i}-nonce.sqlite")))
                    stores.append(BlobStore(str(Path(temp) / f"{i}-blobs.sqlite")))
                    servers.append(LabServer(keys[i], checks[i], stores[i]))
                    thread = threading.Thread(target=servers[i].serve_forever, daemon=True)
                    thread.start()
                    threads.append(thread)
                encrypted = b"opaque-encrypted-test-payload"
                digest = sha256(encrypted).hexdigest()
                payload = {"digest": digest, "ciphertext": encrypted.hex()}
                for i in (0, 1, 2):
                    receipt = exchange(servers[i].endpoint, keys[6], checks[6], ids[i], "put", payload)
                    self.assertTrue(receipt["stored"])
                # Stop a storage peer, then copy from a surviving replica to a
                # node in the second triple. No consensus claim is made here.
                servers[2].shutdown()
                servers[2].server_close()
                stopped.add(2)
                recovered = exchange(servers[0].endpoint, keys[6], checks[6], ids[0], "get", {"digest": digest})
                self.assertEqual(bytes.fromhex(recovered["ciphertext"]), encrypted)
                exchange(servers[3].endpoint, keys[6], checks[6], ids[3], "put", recovered)
                # Transfer the temporary replica to the spare node.
                recovered = exchange(servers[3].endpoint, keys[6], checks[6], ids[3], "get", {"digest": digest})
                exchange(servers[6].endpoint, keys[0], checks[0], ids[6], "put", recovered)
                self.assertEqual(stores[6].execute("get", {"digest": digest})["ciphertext"], encrypted.hex())
                # Retrying an immutable put with a fresh signed request is safe.
                exchange(servers[6].endpoint, keys[0], checks[0], ids[6], "put", recovered)
                with self.assertRaises(ValueError):
                    stores[6].execute("put", {"digest": digest, "ciphertext": b"tampered".hex()})
                with self.assertRaises(ValueError):
                    exchange("https://example.com", keys[0], checks[0], ids[6], "get", {})
            finally:
                for i, server in enumerate(servers):
                    if i not in stopped:
                        server.shutdown()
                        server.server_close()
                for thread in threads: thread.join(timeout=2)
                for store in stores: store.close()
                for check in checks: check.close()
