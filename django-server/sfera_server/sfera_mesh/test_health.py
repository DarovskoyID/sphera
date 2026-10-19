from pathlib import Path
import io
import json
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .health import HealthJournal, HealthMonitor
from .identity import node_id, EnvelopeVerifier, envelope
from .storage import canonical
from .transport import BlobStore, LabServer, exchange


class HealthTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.keys = [Ed25519PrivateKey.generate() for _ in range(2)]
        self.ids = [node_id(key.public_key().public_bytes_raw()) for key in self.keys]
        roster = {node: key.public_key().public_bytes_raw() for node,key in zip(self.ids,self.keys)}
        self.checks = [EnvelopeVerifier('health-lab', node, roster, ':memory:') for node in self.ids]
        self.store = BlobStore(':memory:')
        self.server = LabServer(self.keys[1], self.checks[1], self.store)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.endpoints = {self.ids[1]: self.server.endpoint}
        self.path = str(Path(self.temp.name) / 'health.sqlite')
        self.health = HealthJournal(self.path, self.keys[0], self.checks[0], self.endpoints)

    def tearDown(self):
        self.health.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        for check in self.checks: check.close()
        self.store.close()
        self.temp.cleanup()

    def reopen(self):
        self.health.close()
        self.health = HealthJournal(self.path, self.keys[0], self.checks[0], self.endpoints)

    def test_live_signed_probes_persistent_schedule_and_recovery_hysteresis(self):
        peer = self.ids[1]
        self.assertEqual(self.health.probe(peer, now=100)['state'], 'recovering')
        self.assertEqual(self.health.probe(peer, now=105)['state'], 'healthy')
        with patch('sfera_mesh.health.exchange', side_effect=OSError('simulated link outage')) as send:
            for now,state in ((110,'suspect'),(115,'suspect'),(120,'unreachable')):
                self.assertEqual(self.health.probe(peer, now=now)['state'], state)
            self.assertEqual(send.call_count, 3)
        self.reopen()
        self.assertEqual(self.health.status(peer, now=120)['state'], 'unreachable')
        self.assertFalse(self.health.probe(peer, now=121)['probed'])
        self.assertFalse(self.health.status(peer, now=120)['replacement_authorised'])
        self.assertEqual(self.health.probe(peer, now=125)['state'], 'recovering')
        self.assertEqual(self.health.probe(peer, now=130)['state'], 'healthy')
        self.assertEqual(self.health.status(peer, now=200)['state'], 'unknown')
        self.assertEqual(self.health.probe(peer, now=200)['state'], 'recovering')

    def test_real_socket_failure_and_invalid_response_do_not_authorise_replacement(self):
        peer = self.ids[1]
        self.server.shutdown()
        self.server.server_close()
        self.assertEqual(self.health.probe(peer, now=100)['state'], 'suspect')
        self.assertEqual(self.health.status(peer, now=100)['error'], 'unreachable_from_observer')
        with patch('sfera_mesh.health.exchange', side_effect=ValueError('bad signature')):
            self.health.probe(peer, now=105)
            result = self.health.probe(peer, now=110)
        self.assertEqual(result['state'], 'unreachable')
        self.assertFalse(result['replacement_authorised'])

    def test_probe_payload_and_responder_context_are_verified(self):
        with self.assertRaises(HTTPError) as failure:
            exchange(self.server.endpoint, self.keys[0], self.checks[0], self.ids[0], 'probe', {'challenge': 'a'*64})
        failure.exception.close()
        response = exchange(self.server.endpoint, self.keys[0], self.checks[0], self.ids[1], 'probe', {'challenge': 'b'*64})
        self.assertEqual(response, {'challenge': 'b'*64, 'alive': True})
        class WrongChallenge:
            def open(inner, request, timeout):
                nonce = json.loads(request.data)['record']['nonce']
                reply = envelope(self.keys[1], 'health-lab', self.ids[0], 'probe-response', {'request_nonce':nonce, 'result':{'challenge':'c'*64, 'alive':True}})
                return io.BytesIO(canonical(reply))
        with patch('sfera_mesh.transport.build_opener', return_value=WrongChallenge()):
            with self.assertRaises(ValueError):
                exchange(self.server.endpoint, self.keys[0], self.checks[0], self.ids[1], 'probe', {'challenge':'b'*64})

    def test_context_clock_and_failure_window_cannot_be_bypassed(self):
        peer = self.ids[1]
        with patch('sfera_mesh.health.exchange', side_effect=OSError()):
            self.health.probe(peer, now=100)
            for now in (101,102,103,104): self.assertFalse(self.health.probe(peer, now=now)['probed'])
            self.health.probe(peer, now=105)
            self.assertEqual(self.health.status(peer, now=105)['state'], 'suspect')
            with self.assertRaises(ValueError): self.health.probe(peer, now=99)
        with self.assertRaises(ValueError):
            HealthJournal(self.path, self.keys[0], self.checks[0], self.endpoints, interval=10)
        with self.assertRaises(ValueError):
            HealthJournal(':memory:', self.keys[0], self.checks[0], {peer:'https://example.com'})

    def test_monitor_background_probes_are_bounded_and_stop_interrupts_wait(self):
        monitor = HealthMonitor(self.health).start()
        try:
            with self.assertRaises(ValueError): HealthMonitor(self.health).start()
            with self.assertRaises(ValueError): self.health.close()
            import time
            deadline = time.monotonic() + 3
            while self.health.status(self.ids[1])['last_check'] is None and time.monotonic() < deadline:
                time.sleep(.02)
            status = self.health.status(self.ids[1])
            self.assertEqual(status['successes'], 1)
            self.assertIsNone(monitor.error)
            for _ in range(20): self.health.status(self.ids[1])
            self.assertEqual(self.health.status(self.ids[1])['last_check'], status['last_check'])
        finally:
            monitor.stop()
        self.assertFalse(monitor.thread.is_alive())

    def test_shared_journal_has_one_inflight_probe_and_persistent_reservation(self):
        other = HealthJournal(self.path, self.keys[0], self.checks[0], self.endpoints)
        entered, release = threading.Event(), threading.Event()
        results = []
        original = exchange
        def paused(*args, **kwargs):
            entered.set()
            if not release.wait(3): raise AssertionError('probe not released')
            return original(*args, **kwargs)
        try:
            with patch('sfera_mesh.health.exchange', side_effect=paused) as send:
                worker = threading.Thread(target=lambda: results.append(self.health.probe(self.ids[1], now=100)))
                worker.start()
                try:
                    self.assertTrue(entered.wait(2))
                    self.assertEqual(other.probe(self.ids[1], now=100), {'probed':False, 'reason':'observer_busy'})
                finally:
                    release.set()
                    worker.join(4)
                self.assertEqual(results[0]['state'], 'recovering')
                self.assertEqual(other.probe(self.ids[1], now=100), {'probed':False, 'reason':'not_due'})
                self.assertEqual(send.call_count, 1)
        finally:
            other.close()
