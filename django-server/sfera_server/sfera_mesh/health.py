"""Local reachability observations, not Byzantine failure proof or placement votes."""
from hashlib import sha256
import math
from pathlib import Path
import secrets
import sqlite3
import threading
import time
from urllib.error import HTTPError

from .consensus_directory import validate_address, ConsensusDirectory
from .identity import node_id
from .refresh_lock import RefreshLock
from .storage import canonical
from .transport import exchange


class HealthJournal:
    def __init__(self, path, key, verifier, endpoints, *, interval=5, failure_count=3, failure_window=10, recovery_count=2):
        if type(interval) is not int or not 2 <= interval <= 30 or type(failure_count) is not int or not 3 <= failure_count <= 10 or type(recovery_count) is not int or not 2 <= recovery_count <= 10 or type(failure_window) is not int or not 4 <= failure_window <= 120:
            raise ValueError('invalid_health_policy')
        if not isinstance(endpoints, dict) or not 1 <= len(endpoints) <= 64 or any(node not in verifier.roster for node in endpoints):
            raise ValueError('pinned_health_roster_required')
        identity = node_id(key.public_key().public_bytes_raw())
        if identity != verifier.recipient:
            raise ValueError('health_observer_identity_mismatch')
        for endpoint in endpoints.values():
            validate_address(endpoint)
            if endpoint.endswith('/'):
                raise ValueError('health_endpoint_path_forbidden')
        self.key, self.verifier, self.endpoints = key, verifier, dict(endpoints)
        self.interval, self.failure_count, self.failure_window, self.recovery_count = interval, failure_count, failure_window, recovery_count
        self.lock = threading.RLock()
        self.monitor_owner = None
        self.closed = False
        self.process_lock = RefreshLock(None if str(path) == ':memory:' else str(Path(path).resolve()) + '.health.lock')
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS health_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), context BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS health_nodes (node TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'unknown', failures INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0, failure_since REAL, last_check REAL, last_success REAL, next_probe REAL NOT NULL DEFAULT 0, error TEXT);
        ''')
        context = canonical({'network': verifier.network, 'observer': identity, 'roster': {node: verifier.roster[node].hex() for node in sorted(endpoints)}, 'policy': [interval, failure_count, failure_window, recovery_count]})
        try:
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                old = self.db.execute('SELECT context FROM health_identity').fetchone()
                if old and old[0] != context:
                    raise ValueError('health_context_changed')
                self.db.execute('INSERT OR IGNORE INTO health_identity VALUES (1,?)', (context,))
                self.db.executemany('INSERT OR IGNORE INTO health_nodes(node) VALUES (?)', [(node,) for node in endpoints])
        except Exception:
            self.db.close()
            raise

    def close(self):
        with self.lock:
            if self.monitor_owner is not None:
                raise ValueError('stop_health_monitor_before_close')
            if not self.closed:
                self.db.close()
                self.closed = True

    def status(self, node, *, now=None):
        with self.lock:
            if self.closed:
                raise ValueError('health_journal_closed')
            row = self.db.execute('SELECT state,failures,successes,failure_since,last_check,last_success,next_probe,error FROM health_nodes WHERE node=?', (node,)).fetchone()
            if row is None:
                raise ValueError('unknown_health_peer')
            result = dict(zip(('state','failures','successes','failure_since','last_check','last_success','next_probe','error'), row))
            current = time.time() if now is None else now
            result['fresh'] = row[4] is not None and row[4] <= current <= row[4] + max(15,3*self.interval)
            result['observed_state'] = result['state']
            if not result['fresh']:
                result['state'] = 'unknown'
            result['replacement_authorised'] = False
            return result

    def probe(self, node, *, now=None):
        current = time.time() if now is None else now
        if isinstance(current, bool) or not isinstance(current, (int,float)) or not math.isfinite(current) or current < 0 or node not in self.endpoints:
            raise ValueError('invalid_health_probe')
        with self.lock:
            if not self.process_lock.acquire():
                return {'probed': False, 'reason': 'observer_busy'}
            try:
                return self._probe(node, current, now is None)
            finally:
                self.process_lock.release()

    def _probe(self, node, current, realtime):
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            row = self.status(node, now=current)
            if row['last_check'] is not None and current < row['last_check']:
                raise ValueError('health_clock_rollback')
            if current < row['next_probe']:
                return {'probed': False, 'reason': 'not_due'}
            # Reserve the interval before I/O, including across a crash/restart.
            self.db.execute('UPDATE health_nodes SET next_probe=? WHERE node=?', (current + self.interval, node))
            if not row['fresh']:
                row.update(failures=0, successes=0, failure_since=None)
        challenge = secrets.token_hex(32)
        error = None
        try:
            exchange(self.endpoints[node], self.key, self.verifier, node, 'probe', {'challenge': challenge})
        except HTTPError as exc:
            exc.close()
            error = 'invalid_response'
        except OSError:
            error = 'unreachable_from_observer'
        except (ValueError, KeyError, TypeError):
            error = 'invalid_response'
        finished = max(current, time.time()) if realtime else current
        failures, successes, since, last_success = row['failures'], row['successes'], row['failure_since'], row['last_success']
        if error is None:
            successes, failures, since, last_success = min(successes + 1, self.recovery_count), 0, None, finished
            state = 'healthy' if successes >= self.recovery_count else 'recovering'
        else:
            failures, successes = min(failures + 1, self.failure_count), 0
            since = current if since is None else since
            state = 'unreachable' if failures >= self.failure_count and finished - since >= self.failure_window else 'suspect'
        with self.db:
            self.db.execute('UPDATE health_nodes SET state=?,failures=?,successes=?,failure_since=?,last_check=?,last_success=?,next_probe=?,error=? WHERE node=?', (state,failures,successes,since,finished,last_success,finished + self.interval,error,node))
        return {'probed': True, 'state': state, 'replacement_authorised': False}

    def run_batch(self, *, limit=16, stop_event=None):
        if type(limit) is not int or not 1 <= limit <= 64:
            raise ValueError('invalid_health_batch')
        with self.lock:
            peers = self.db.execute('SELECT node FROM health_nodes WHERE next_probe<=? ORDER BY next_probe,node LIMIT ?', (time.time(),limit)).fetchall()
        count = 0
        for node, in peers:
            if stop_event is not None and stop_event.is_set():
                break
            count += int(self.probe(node)['probed'])
        return {'probed': count}

    def advisory(self, directory, cluster, *, now=None):
        if not isinstance(directory, ConsensusDirectory) or directory.network != self.verifier.network:
            raise ValueError('matching_verified_directory_required')
        placement = directory.placement(cluster)
        with self.lock:
            members = placement['record']['body']['members']
            if any(node not in self.endpoints for node in members):
                raise ValueError('cluster_health_roster_incomplete')
            observations = {node:self.status(node, now=now) for node in members}
            failed = [node for node in members if observations[node]['state'] == 'unreachable']
            healthy = [node for node in members if observations[node]['state'] == 'healthy']
            result = {'cluster':cluster, 'epoch':placement['record']['body']['epoch'], 'unreachable_from_observer':failed, 'healthy_survivors':healthy, 'can_request_consents':len(failed)==1 and len(healthy)==2, 'replacement_authorised':False}
        if directory.placement(cluster)['record_hash'] != placement['record_hash']:
            raise ValueError('health_placement_changed')
        return result


class HealthMonitor:
    """Bounded local background observation. Never changes any placement."""
    def __init__(self, journal, *, batch_size=16):
        if type(batch_size) is not int or not 1 <= batch_size <= 64:
            raise ValueError('invalid_health_batch')
        self.journal, self.batch_size = journal, batch_size
        self.stop_event = threading.Event()
        self.thread = None
        self.error = None

    def start(self):
        with self.journal.lock:
            if self.thread is not None or self.journal.monitor_owner is not None or self.journal.closed:
                raise ValueError('health_monitor_already_started')
            self.journal.monitor_owner = self
            self.thread = threading.Thread(target=self._run, name='mesh-health-monitor', daemon=True)
            try:
                self.thread.start()
            except BaseException:
                self.journal.monitor_owner = None
                raise
        return self

    def stop(self):
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout=20)
            if self.thread.is_alive():
                raise RuntimeError('health_monitor_did_not_stop')

    def _run(self):
        try:
            while not self.stop_event.is_set():
                try:
                    self.journal.run_batch(limit=self.batch_size, stop_event=self.stop_event)
                    self.error = None
                except (ValueError, OSError, sqlite3.Error):
                    self.error = 'observation_unavailable'
                self.stop_event.wait(self.journal.interval)
        except Exception:
            self.error = 'internal_error'
        finally:
            with self.journal.lock:
                if self.journal.monitor_owner is self:
                    self.journal.monitor_owner = None
