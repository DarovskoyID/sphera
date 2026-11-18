import copy
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import unittest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .identity import create_identity, load_identity, node_id, envelope, EnvelopeVerifier
from .transport import BlobStore, LabServer, Handler, exchange


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


class ReusedHTTPHandlerTests(unittest.TestCase):
    def test_reused_client_does_not_keep_peer_cookies(self):
        keys = [Ed25519PrivateKey.generate() for _ in range(2)]
        ids = [node_id(key.public_key().public_bytes_raw()) for key in keys]
        roster = dict(zip(ids, [key.public_key().public_bytes_raw() for key in keys]))
        server_check = EnvelopeVerifier('reuse', ids[0], roster, ':memory:')
        client_check = EnvelopeVerifier('reuse', ids[1], roster, ':memory:')
        store = BlobStore(':memory:')
        seen = []
        class CookieHandler(Handler):
            def do_POST(self):
                seen.append(self.headers.get('Cookie'))
                return super().do_POST()
            def end_headers(self):
                self.send_header('Set-Cookie', 'untrusted-peer-cookie=discard')
                return super().end_headers()
        server = LabServer(keys[0], server_check, store); server.RequestHandlerClass = CookieHandler
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            data = b'cached handlers, signed fresh envelopes'; digest = sha256(data).hexdigest()
            store.execute('put', {'digest': digest, 'ciphertext': data.hex()})
            for _ in range(2):
                result = exchange(server.endpoint, keys[1], client_check, ids[0], 'get', {'digest': digest})
                self.assertEqual(result['ciphertext'], data.hex())
            self.assertEqual(seen, [None, None])
        finally:
            server.shutdown(); server.server_close(); thread.join(3)
            store.close(); client_check.close(); server_check.close()

    def test_reused_client_never_follows_redirect(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from urllib.error import HTTPError
        seen = []
        class Redirect(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                seen.append(self.path)
                self.send_response(302)
                self.send_header('Location', f'http://127.0.0.1:{self.server.server_port}/redirect-target')
                self.send_header('Content-Length', '0'); self.end_headers()
            def do_GET(self):
                seen.append(self.path); self.send_response(200)
                self.send_header('Content-Length', '0'); self.end_headers()
        server = ThreadingHTTPServer(('127.0.0.1', 0), Redirect)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        key = Ed25519PrivateKey.generate(); identity = node_id(key.public_key().public_bytes_raw())
        check = EnvelopeVerifier('reuse', identity, {identity: key.public_key().public_bytes_raw()}, ':memory:')
        try:
            with self.assertRaises(HTTPError) as error:
                exchange(f'http://127.0.0.1:{server.server_port}', key, check, identity, 'get', {'digest': 'a' * 64})
            self.assertEqual(error.exception.code, 302); error.exception.close()
            self.assertEqual(seen, ['/mesh-lab/v1/get'])
        finally:
            server.shutdown(); server.server_close(); thread.join(3); check.close()


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
