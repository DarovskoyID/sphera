"""Fixed-genesis laboratory bridge; deliberately separate from fixture certificates.

Trust the locally installed Go verifier and locally pinned genesis, never a roster
returned by a peer. This is NOT the product login or a public mesh discovery API.
"""
import base64
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from .storage import canonical
from .directory import validate_record, digest64


class ConsensusUnavailable(ValueError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_address(address):
    if not isinstance(address, str) or len(address) > 2048:
        raise ValueError('lab_loopback_required')
    parsed = urlsplit(address)
    if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or not parsed.port or parsed.path not in ('', '/') or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError('lab_loopback_required')


def rpc(address, method, params, *, stop_event=None):
    validate_address(address)
    request = urllib.request.Request(address, data=canonical({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}), headers={'Content-Type': 'application/json'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    deadline = time.monotonic() + 4
    chunks, length = [], 0
    with opener.open(request, timeout=4) as response:
        while length <= 2 * 1048576:
            if time.monotonic() >= deadline or (stop_event is not None and stop_event.is_set()):
                raise ConsensusUnavailable('rpc_deadline_or_stop')
            chunk = response.read1(min(65536, 2 * 1048576 + 1 - length))
            if not chunk:
                break
            chunks.append(chunk)
            length += len(chunk)
    data = b''.join(chunks)
    if len(data) > 2 * 1048576:
        raise ValueError('rpc_response_too_large')
    result = json.loads(data)
    if not isinstance(result, dict) or result.get('id') != 1 or 'error' in result:
        raise ConsensusUnavailable('consensus_rpc_error')
    return result['result']


def fetch_evidence(address, *, stop_event=None):
    if stop_event is not None and stop_event.is_set():
        raise ConsensusUnavailable('refresh_stopped')
    response = rpc(address, 'abci_query', {'path': '/snapshot', 'prove': False}, stop_event=stop_event)['response']
    if response.get('code', 0):
        raise ConsensusUnavailable('snapshot_unavailable')
    raw = base64.b64decode(response['value'], validate=True)
    if len(raw) > 1048576:
        raise ValueError('snapshot_too_large')
    state = json.loads(raw)
    if canonical(state) != raw or type(state.get('height')) is not int or state['height'] < 1 or int(response['height']) != state['height']:
        raise ValueError('invalid_snapshot_height')
    # ABCI state H may be visible just before consensus has committed H+1.
    # Keep this same snapshot and wait briefly for its actual signed anchor.
    deadline = time.monotonic() + 4
    while True:
        try:
            if stop_event is not None and stop_event.is_set():
                raise ConsensusUnavailable('refresh_stopped')
            header = rpc(address, 'commit', {'height': str(state['height'] + 1)}, stop_event=stop_event)['signed_header']
            break
        except ConsensusUnavailable:
            if time.monotonic() >= deadline:
                raise
            if stop_event is None:
                time.sleep(.5)
            elif stop_event.wait(.5):
                raise ConsensusUnavailable('refresh_stopped')
    return {'state': state, 'signed_header': header}


class ConsensusDirectory:
    """Durable high-water mark plus fresh, independently verified whole snapshot."""
    def __init__(self, path, binary, genesis):
        self.binary = str(Path(binary).resolve())
        self.genesis = str(Path(genesis).resolve())
        self.pin = sha256(Path(self.genesis).read_bytes()).hexdigest()
        self.network = json.loads(Path(self.genesis).read_bytes())['chain_id']
        self.lock = threading.RLock()
        self.refresh_lock = threading.RLock()
        self.closed = False
        self.update_owner = None
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS consensus_pin (singleton INTEGER PRIMARY KEY CHECK(singleton=1), digest TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS consensus_snapshot (singleton INTEGER PRIMARY KEY CHECK(singleton=1), height INTEGER NOT NULL, header_hash TEXT NOT NULL, evidence BLOB NOT NULL);
        ''')
        row = self.db.execute('SELECT digest FROM consensus_pin').fetchone()
        if row and row[0] != self.pin:
            self.db.close()
            raise ValueError('pinned_genesis_changed')
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO consensus_pin VALUES (1,?)', (self.pin,))
        self.current = None

    def _verify(self, evidence):
        if sha256(Path(self.genesis).read_bytes()).hexdigest() != self.pin:
            raise ValueError('pinned_genesis_changed')
        raw = canonical(evidence)
        if len(raw) > 2 * 1048576:
            raise ValueError('evidence_too_large')
        result = subprocess.run([self.binary, '--verify-genesis', self.genesis], input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=8, check=False)
        if result.returncode:
            raise ConsensusUnavailable('invalid_or_stale_consensus_evidence')
        verified = json.loads(result.stdout)
        state = verified['state']
        if state['network'] != self.network or not digest64(verified['header_hash']):
            raise ValueError('invalid_verifier_output')
        for identity, head in state['accounts'].items():
            _, digest = validate_record(head['record'], self.network, identity)
            if digest != head['digest']:
                raise ValueError('invalid_verified_record')
        return verified

    def import_evidence(self, evidence):
        # Slow cryptographic verification must not block reads of a fresh cache.
        with self.refresh_lock:
            verified = self._verify(evidence)
            return self._install(verified, evidence)

    def _install(self, verified, evidence):
        with self.lock:
            if self.closed:
                raise ConsensusUnavailable('directory_closed')
            height, block = verified['state']['height'], verified['header_hash']
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                row = self.db.execute('SELECT height,header_hash FROM consensus_snapshot').fetchone()
                if row and (height < row[0] or (height == row[0] and block != row[1])):
                    raise ValueError('consensus_rollback_or_fork')
                # An account cannot disappear or regress in this immutable state machine.
                previous = self.current
                if previous is not None:
                    for identity, head in previous['state']['accounts'].items():
                        new = verified['state']['accounts'].get(identity)
                        if not new or new['record']['body']['version'] < head['record']['body']['version'] or (new['record']['body']['version'] == head['record']['body']['version'] and new['digest'] != head['digest']):
                            raise ValueError('account_rollback_or_fork')
                self.db.execute('INSERT OR REPLACE INTO consensus_snapshot VALUES (1,?,?,?)', (height, block, canonical(evidence)))
            self.current = verified
            return self.anchor()

    def refresh(self, address, *, stop_event=None):
        evidence = fetch_evidence(address, stop_event=stop_event)
        if stop_event is not None and stop_event.is_set():
            raise ConsensusUnavailable('refresh_stopped')
        return self.import_evidence(evidence)

    def restore(self):
        with self.lock:
            row = self.db.execute('SELECT evidence FROM consensus_snapshot').fetchone()
            if row is None:
                raise ConsensusUnavailable('no_consensus_snapshot')
            evidence = json.loads(row[0])
        return self.import_evidence(evidence)

    def anchor(self, *, now=None):
        with self.lock:
            current = self.current
            now = time.time() if now is None else now
            if self.closed or current is None or not now - 30 < current['header_time'] <= now + 5:
                raise ConsensusUnavailable('consensus_snapshot_not_fresh')
            return {'network': self.network, 'height': current['state']['height'], 'header_hash': current['header_hash'], 'validators_hash': current['validators_hash'], 'expires_at': current['header_time'] + 30}

    def get(self, identity):
        with self.lock:
            if not digest64(identity):
                raise ValueError('invalid_account_id')
            anchor = self.anchor()
            head = self.current['state']['accounts'].get(identity)
            if head is None:
                return {'error': 'not_found', 'finality': anchor}
            # JSON roundtrip prevents callers mutating the cached verified snapshot.
            return {'record': json.loads(canonical(head['record'])), 'record_hash': head['digest'], 'finality': anchor}

    def close(self):
        with self.refresh_lock, self.lock:
            if self.update_owner is not None:
                raise ValueError('stop_directory_updater_before_close')
            if not self.closed:
                self.current = None
                self.closed = True
                self.db.close()

    def execute(self, operation, payload):
        # Old account-confirm wire format must never inject fixture certificates.
        raise ValueError('cometbft_snapshot_protocol_required')
