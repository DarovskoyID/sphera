"""One bounded background refresher per laboratory directory, never per login."""
import random
import subprocess
import threading
import time

from .consensus_directory import ConsensusUnavailable, validate_address


class ConsensusUpdater:
    def __init__(self, directory, addresses, *, interval=5, max_backoff=20):
        if not isinstance(addresses, (list, tuple)) or not 1 <= len(addresses) <= 16:
            raise ValueError('explicit_peers_required')
        for address in addresses:
            validate_address(address)
        if len(set(addresses)) != len(addresses):
            raise ValueError('duplicate_consensus_peer')
        if isinstance(interval, bool) or isinstance(max_backoff, bool) or not 2 <= interval <= 10 or not interval <= max_backoff <= 20:
            raise ValueError('invalid_refresh_schedule')
        self.directory, self.addresses = directory, tuple(addresses)
        self.interval, self.max_backoff = interval, max_backoff
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.thread = None
        self.stats = {'attempts': 0, 'successes': 0, 'failures': 0, 'last_success': None, 'last_error': None}

    def start(self):
        with self.directory.lock:
            if self.thread is not None or self.directory.update_owner is not None or self.directory.closed:
                raise ValueError('directory_updater_already_started_or_closed')
            self.directory.update_owner = self
            self.thread = threading.Thread(target=self._run, name='mesh-directory-refresh', daemon=True)
            try:
                self.thread.start()
            except BaseException:
                self.directory.update_owner = None
                raise
        return self

    def stop(self):
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout=25)
            if self.thread.is_alive():
                raise RuntimeError('directory_updater_did_not_stop')

    def status(self):
        with self.lock:
            result = dict(self.stats)
        try:
            result['anchor'] = self.directory.anchor()
            result['ready'] = True
        except ConsensusUnavailable:
            result['anchor'], result['ready'] = None, False
        result['running'] = self.thread is not None and self.thread.is_alive()
        return result

    def _run(self):
        index, failures = 0, 0
        try:
            # Restoration re-verifies persisted evidence; an expired proof is not ready.
            try:
                self.directory.restore()
            except (ValueError, OSError, subprocess.SubprocessError):
                pass
            while not self.stop_event.is_set():
                with self.lock:
                    self.stats['attempts'] += 1
                error = None
                try:
                    self.directory.refresh(self.addresses[index], stop_event=self.stop_event)
                except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as exc:
                    error = 'unavailable' if isinstance(exc, (ConsensusUnavailable, OSError)) else 'invalid_response'
                except Exception:
                    # Fail closed, expose no payload/credentials, do not retry programming errors.
                    with self.lock:
                        self.stats['last_error'] = 'internal_error'
                    break
                if self.stop_event.is_set():
                    break
                with self.lock:
                    if error is None:
                        failures = 0
                        self.stats['successes'] += 1
                        self.stats['last_success'] = int(time.time())
                        self.stats['last_error'] = None
                    else:
                        failures = min(failures + 1, 8)
                        self.stats['failures'] += 1
                        self.stats['last_error'] = error
                        index = (index + 1) % len(self.addresses)
                delay = min(self.max_backoff, self.interval * 2 ** min(failures, 4))
                # Jitter spreads load while preserving a strict minimum and maximum delay.
                delay = min(self.max_backoff, max(self.interval, delay * random.SystemRandom().uniform(.8, 1.2)))
                self.stop_event.wait(delay)
        finally:
            with self.directory.lock:
                if self.directory.update_owner is self:
                    self.directory.update_owner = None
