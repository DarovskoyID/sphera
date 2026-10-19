import json
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import time
import unittest
from unittest.mock import patch

from .consensus_directory import ConsensusDirectory, ConsensusUnavailable
from .consensus_updater import ConsensusUpdater


class UnavailableDirectory:
    def __init__(self):
        self.lock = threading.RLock()
        self.closed, self.update_owner = False, None
        self.calls = 0
        self.called = threading.Event()

    def restore(self):
        raise ConsensusUnavailable('not_ready')

    def anchor(self):
        raise ConsensusUnavailable('not_ready')

    def refresh(self, address, *, stop_event=None):
        self.calls += 1
        self.called.set()
        raise ConsensusUnavailable('peer_unavailable')


class UpdaterTests(unittest.TestCase):
    def test_failure_does_not_spin_and_stop_interrupts_backoff(self):
        directory = UnavailableDirectory()
        updater = ConsensusUpdater(directory, ['http://127.0.0.1:12345'], interval=2).start()
        try:
            self.assertTrue(directory.called.wait(2))
            time.sleep(.15)
            for _ in range(50):
                self.assertFalse(updater.status()['ready'])
            self.assertEqual(directory.calls, 1)  # Status/read does not trigger HTTP.
            with self.assertRaises(ValueError):
                ConsensusUpdater(directory, ['http://127.0.0.1:12345']).start()
            started = time.monotonic()
            updater.stop()
            self.assertLess(time.monotonic() - started, 1)
            self.assertIsNone(directory.update_owner)
            self.assertFalse(updater.status()['running'])
        finally:
            updater.stop()

    def test_explicit_bounded_loopback_sources_and_schedule(self):
        directory = UnavailableDirectory()
        for peers in ([], ['https://example.com'], ['http://127.0.0.1:80'] * 2, ['http://127.0.0.1:80'] * 17, ['http://127.0.0.1:80/?redirect=x']):
            with self.assertRaises(ValueError):
                ConsensusUpdater(directory, peers)
        for interval, maximum in ((0, 20), (1, 20), (11, 20), (5, 4), (5, 60)):
            with self.assertRaises(ValueError):
                ConsensusUpdater(directory, ['http://127.0.0.1:80'], interval=interval, max_backoff=maximum)

    def test_verification_does_not_block_reads_and_close_is_final(self):
        with TemporaryDirectory() as temp:
            genesis = Path(temp) / 'genesis.json'
            genesis.write_text(json.dumps({'chain_id': 'lab'}))
            directory = ConsensusDirectory(':memory:', str(Path(temp) / 'unused-verifier'), genesis)
            first = {'state': {'network': 'lab', 'height': 1, 'accounts': {}}, 'header_hash': 'a' * 64, 'header_time': int(time.time()), 'validators_hash': 'b' * 64}
            with patch.object(directory, '_verify', return_value=first):
                directory.import_evidence({})
            entered, release = threading.Event(), threading.Event()
            def slow_verify(evidence):
                entered.set()
                if not release.wait(3):
                    raise AssertionError('verification never released')
                return {**first, 'state': {**first['state'], 'height': 2}, 'header_hash': 'c' * 64}
            with patch.object(directory, '_verify', side_effect=slow_verify):
                worker = threading.Thread(target=lambda: directory.import_evidence({}))
                worker.start()
                try:
                    self.assertTrue(entered.wait(2))
                    self.assertEqual(directory.anchor()['height'], 1)
                finally:
                    release.set()
                    worker.join(3)
                self.assertEqual(directory.anchor()['height'], 2)
            directory.close()
            with self.assertRaises(ConsensusUnavailable):
                directory.anchor()


if __name__ == '__main__':
    unittest.main()
