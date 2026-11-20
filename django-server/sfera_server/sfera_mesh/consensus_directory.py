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
from .placements import validate_placement, validate_history
from .candidates import validate_registry, registered_candidates
from .resources import pinned_assessors, validate_resources, assessed_checks
from .manifests import validate_manifests


class ConsensusUnavailable(ValueError):
    pass


class ConsensusTransactionPending(ConsensusUnavailable):
    """The exact transaction is already queued; this is not commit evidence."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_http_state = threading.local()


def _http_opener(context=None):
    factory = urllib.request.build_opener
    if getattr(_http_state, 'factory', None) is not factory or getattr(_http_state,'context',None) is not context:
        handlers=[urllib.request.ProxyHandler({}),NoRedirect()]
        if context is not None:handlers.append(urllib.request.HTTPSHandler(context=context))
        _http_state.opener = factory(*handlers)
        _http_state.factory = factory
        _http_state.context=context
    return _http_state.opener


def validate_address(address):
    from .consensus_gateway import GatewaySource
    if isinstance(address,GatewaySource):
        GatewaySource(address);return
    if not isinstance(address, str) or len(address) > 2048:
        raise ValueError('lab_loopback_required')
    parsed = urlsplit(address)
    if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or not parsed.port or parsed.path not in ('', '/') or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError('lab_loopback_required')


def rpc(address, method, params, *, stop_event=None):
    validate_address(address)
    from .consensus_gateway import GatewaySource,validate_request
    value={'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}
    if isinstance(address,GatewaySource):validate_request(value)
    target=str(address)+'/mesh/network/v1/rpc' if isinstance(address,GatewaySource) else address
    request = urllib.request.Request(target, data=canonical(value), headers={'Content-Type': 'application/json'})
    opener = _http_opener(getattr(address,'context',None))
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
    if (isinstance(result,dict) and result.get('id') == 1 and method == 'broadcast_tx_sync'
            and isinstance(result.get('error'),dict) and result['error'].get('code') == -32603
            and result['error'].get('data') == 'tx already exists in cache'):
        raise ConsensusTransactionPending('consensus_transaction_pending')
    if not isinstance(result, dict) or result.get('id') != 1 or 'error' in result:
        raise ConsensusUnavailable('consensus_rpc_error')
    return result['result']


def committee_evidence(address, height, *, stop_event=None):
    response = rpc(address, 'abci_query', {'path': '/committee-history', 'prove': False}, stop_event=stop_event)['response']
    if response.get('code', 0):
        raise ConsensusUnavailable('committee_history_unavailable')
    raw = base64.b64decode(response['value'], validate=True)
    if len(raw) > 262144:
        raise ValueError('committee_history_too_large')
    proofs = json.loads(raw)
    if not isinstance(proofs, list) or len(proofs) > 16:
        raise ValueError('invalid_committee_history')
    result = []
    for proof in proofs:
        if not isinstance(proof, dict) or type(proof.get('height')) is not int:
            raise ValueError('invalid_committee_proof')
        if proof['height'] <= height:
            header = rpc(address, 'commit', {'height': str(proof['height'] + 1)}, stop_event=stop_event)['signed_header']
            result.append({'proof': proof, 'signed_header': header})
    return result


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
    evidence = {'state': state, 'signed_header': header}
    if state.get('committees'):
        evidence['committee_transitions'] = committee_evidence(address, state['height'], stop_event=stop_event)
    return evidence


class ConsensusDirectory:
    """Durable high-water mark plus fresh, independently verified whole snapshot."""
    def __init__(self, path, binary, genesis):
        self.binary = str(Path(binary).resolve())
        self.genesis = str(Path(genesis).resolve())
        self.pin = sha256(Path(self.genesis).read_bytes()).hexdigest()
        genesis = json.loads(Path(self.genesis).read_bytes())
        self.network = genesis['chain_id']
        self.endpoint_policy=(genesis.get('app_state') or {}).get('endpoint_policy','')
        if self.endpoint_policy not in ('','https-v1'):raise ValueError('unsupported_endpoint_policy')
        self.license_issuers = (genesis.get('app_state') or {}).get('license_issuers', {})
        self.placement_assessors = pinned_assessors(genesis)
        self.lock = threading.RLock()
        self.refresh_lock = threading.RLock()
        self.closed = False
        self.update_owner = None
        self.refresh_lock_path = None if str(path) == ':memory:' else str(Path(path).resolve()) + '.refresh.lock'
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS consensus_pin (singleton INTEGER PRIMARY KEY CHECK(singleton=1), digest TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS consensus_snapshot (singleton INTEGER PRIMARY KEY CHECK(singleton=1), height INTEGER NOT NULL, header_hash TEXT NOT NULL, evidence BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS consensus_committees (singleton INTEGER PRIMARY KEY CHECK(singleton=1), history BLOB NOT NULL);
        ''')
        try:
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                row = self.db.execute('SELECT digest FROM consensus_pin').fetchone()
                if row and row[0] != self.pin:
                    raise ValueError('pinned_genesis_changed')
                self.db.execute('INSERT OR IGNORE INTO consensus_pin VALUES (1,?)', (self.pin,))
        except Exception:
            self.db.close()
            raise
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
        if state.get('endpoint_policy','')!=self.endpoint_policy:raise ValueError('verified_endpoint_policy_changed')
        if state.get('license_issuers',{}) != self.license_issuers:
            raise ValueError('verified_issuer_configuration_changed')
        if state['network'] != self.network or not digest64(verified['header_hash']):
            raise ValueError('invalid_verifier_output')
        from .account_controls import validate_controls, controller_public
        validate_controls(state,self.network,self.pin)
        for identity, head in state['accounts'].items():
            _, digest = validate_record(head['record'], self.network, identity, controller_public=controller_public(state, identity, head['record']['body']['version']))
            if digest != head['digest']:
                raise ValueError('invalid_verified_record')
        counts = {}
        validate_resources(state, self.network, self.placement_assessors)
        validate_registry(state, self.network, {issuer:bytes.fromhex(public) for issuer,public in self.license_issuers.items()})
        validate_history(state, self.network, trusted_issuers={issuer:bytes.fromhex(public) for issuer,public in self.license_issuers.items()})
        for cluster, head in state.get('placements', {}).items():
            body, digest = validate_placement(head['record'], self.network)
            if body['cluster'] != cluster or digest != head['digest']:
                raise ValueError('invalid_verified_placement')
            for member in body['members']:
                counts[member] = counts.get(member, 0) + 1
                if counts[member] > 2:
                    raise ValueError('placement_membership_limit')
        validate_manifests(state,self.network)
        from .recovery_roots import validate_recovery_roots
        validate_recovery_roots(state, self.network, self.pin)
        from .recovery_tree import validate_state as validate_recovery_trees
        validate_recovery_trees(state, self.network, self.pin)
        from .write_queue import validate_write_queue
        validate_write_queue(state,self.network)
        from .transfer_consensus import validate_transfers
        validate_transfers(state,self.network)
        from .admission_consensus import validate_admission_state,committee_from_assessors
        if state.get('genesis_pin',self.pin)!=self.pin: raise ValueError('verified_genesis_pin_changed')
        validate_admission_state(state,self.network,self.pin,committee_from_assessors(self.placement_assessors))
        from .devices import validate_device_state
        validate_device_state(state,self.network)
        from .cipher_device_pins import validate_cipher_devices
        validate_cipher_devices(state,self.network,self.pin)
        from .cipher_profiles import validate_profiles
        validate_profiles(state,self.network,self.pin)
        from .application_profiles import validate_profiles as validate_application_profiles
        validate_application_profiles(state,self.network,self.pin)
        from .application_dialogs import validate_dialogs
        validate_dialogs(state,self.network,self.pin)
        from .application_keys import replay as validate_application_keys
        validate_application_keys(state,self.network,self.pin)
        from .discovery import validate_endpoints
        validate_endpoints(state,self.network)
        from .growth import validate_growth_grants
        validate_growth_grants(state,self.network)
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
                row = self.db.execute('SELECT height,header_hash,evidence FROM consensus_snapshot').fetchone()
                if row and (height < row[0] or (height == row[0] and block != row[1])):
                    raise ValueError('consensus_rollback_or_fork')
                # Recovery pointers retain their high-water mark even on the
                # first import after this reader process was restarted.
                from .recovery_roots import check_progress
                prior_state = self.current['state'] if self.current is not None else (json.loads(row[2])['state'] if row else {})
                from .account_controls import check_progress as check_control_progress
                check_control_progress(prior_state,verified['state'])
                from .cipher_device_pins import check_progress as check_cipher_progress
                check_cipher_progress(prior_state, verified['state'])
                from .cipher_profiles import check_progress as check_profile_progress
                check_profile_progress(prior_state, verified['state'])
                from .application_profiles import check_progress as check_application_profile_progress
                check_application_profile_progress(prior_state, verified['state'])
                from .application_dialogs import check_progress as check_application_dialog_progress
                check_application_dialog_progress(prior_state, verified['state'])
                from .application_keys import check_progress as check_application_key_progress
                check_application_key_progress(prior_state, verified['state'])
                check_progress(prior_state, verified['state'])
                from .recovery_tree import check_progress as check_tree_progress
                check_tree_progress(prior_state, verified['state'])
                # An account cannot disappear or regress in this immutable state machine.
                checkpoint = self.db.execute('SELECT history FROM consensus_committees').fetchone()
                history = json.loads(checkpoint[0]) if checkpoint else (json.loads(row[2]).get('state', {}).get('committees', []) if row else [])
                current_history = verified['state'].get('committees', [])
                if len(current_history) < len(history) or canonical(current_history[:len(history)]) != canonical(history):
                    raise ValueError('committee_history_rollback_or_fork')
                previous = self.current
                if previous is not None:
                    for identity,head in previous['state'].get('endpoints',{}).items():
                        new=verified['state'].get('endpoints',{}).get(identity)
                        if not new or new['record']['body']['version']<head['record']['body']['version'] or (new['record']['body']['version']==head['record']['body']['version'] and new['digest']!=head['digest']):
                            raise ValueError('endpoint_rollback_or_fork')
                    for identity, history in previous['state'].get('devices', {}).items():
                        new = verified['state'].get('devices', {}).get(identity, [])
                        if len(new) < len(history) or any(new[index]['digest'] != head['digest'] for index, head in enumerate(history)):
                            raise ValueError('device_history_rollback_or_fork')
                    for cluster, head in previous['state'].get('placements', {}).items():
                        new = verified['state'].get('placements', {}).get(cluster)
                        if not new or new['record']['body']['epoch'] < head['record']['body']['epoch'] or (new['record']['body']['epoch'] == head['record']['body']['epoch'] and new['digest'] != head['digest']):
                            raise ValueError('placement_rollback_or_fork')
                    for identity, head in previous['state']['accounts'].items():
                        new = verified['state']['accounts'].get(identity)
                        if not new or new['record']['body']['version'] < head['record']['body']['version'] or (new['record']['body']['version'] == head['record']['body']['version'] and new['digest'] != head['digest']):
                            raise ValueError('account_rollback_or_fork')
                self.db.execute('INSERT OR REPLACE INTO consensus_snapshot VALUES (1,?,?,?)', (height, block, canonical(evidence)))
                self.db.execute('INSERT OR REPLACE INTO consensus_committees VALUES (1,?)', (canonical(current_history),))
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
            result = {'record': json.loads(canonical(head['record'])), 'record_hash': head['digest'], 'finality': anchor}
            controls = self.current['state'].get('account_controls', {}).get(identity, [])
            if controls:
                result.update(controller_public=controls[-1]['record']['body']['new_public'], control_digest=controls[-1]['digest'], control_history=json.loads(canonical(controls)))
            return result

    def initial_plan(self, count):
        """Snapshot-bound proposal only; does not reserve or register clusters."""
        from .initial_planning import plan_initial_clusters, initial_pool_hash
        with self.lock:
            if not self.placement_assessors:
                raise ValueError('quorum_placement_policy_required')
            anchor = self.anchor()
            profiles = self.placement_candidates()
            now=int(time.time())
            groups = plan_initial_clusters(profiles,count,now=now,network=self.network,
                                           existing_clusters=self.current['state'].get('placements',{}))
            selected = sorted(node.node_id for group in groups for node in group)
            state = self.current['state']
            return {'domain':'sfera-mesh-initial-plan-lab-v1','network':self.network,'finality':anchor,
                    'requested_count':count,'complete':len(groups)==count,
                    'pool_hash':initial_pool_hash(profiles,state,now=now),
                    'groups':[[node.node_id for node in group] for group in groups],
                    'candidates':{node:state['candidates'][node]['digest'] for node in selected},
                    'resources':{node:state['resources'][node]['digest'] for node in selected}}

    def borrowed_memberships(self):
        """Evidence only; does not propose a transition or release storage."""
        from .membership_origins import borrowed_memberships
        with self.lock:
            self.anchor()
            return borrowed_memberships(self.current['state'])

    def placement_history(self, cluster):
        with self.lock:
            self.anchor()
            history = self.current['state'].get('placement_history', {}).get(cluster)
            if history is None:
                raise ValueError('placement_history_required')
            return json.loads(canonical(history))

    def manifest(self,cluster):
        with self.lock:
            anchor=self.anchor()
            head=self.current['state'].get('manifests',{}).get(cluster)
            if head is None: raise ValueError('confirmed_manifest_required')
            return {**json.loads(canonical(head)),'finality':anchor}

    def cipher_device(self, owner, device):
        with self.lock:
            if not digest64(owner) or not digest64(device):
                raise ValueError('invalid_global_cipher_device')
            finality = self.anchor()
            head = self.current['state'].get('cipher_devices', {}).get(owner + ':' + device)
            return {'head': json.loads(canonical(head)) if head else None, 'finality': finality}

    def device_history(self, identity):
        """Fresh BFT-confirmed metadata only; does not grant an application session."""
        with self.lock:
            anchor = self.anchor()
            account = self.current['state']['accounts'].get(identity)
            if account is None:
                raise ValueError('confirmed_device_owner_required')
            history = self.current['state'].get('devices', {}).get(identity, [])
            result = {'network': self.network, 'user_id': identity,
                    'owner_public': account['record']['body']['public_key'],
                    'events': [json.loads(canonical(head['event'])) for head in history],
                    'version': len(history), 'digest': history[-1]['digest'] if history else '0' * 64,
                    'finality': anchor, 'confirmed_by_consensus': True}
            controls = self.current['state'].get('account_controls', {}).get(identity, [])
            if controls:
                result.update(controller_public=controls[-1]['record']['body']['new_public'], control_history=json.loads(canonical(controls)))
            return result

    def placement_candidates(self, resource_checks=None, *, now=None, cluster=None):
        with self.lock:
            self.anchor(now=now)
            current_time = int(time.time() if now is None else now)
            if self.placement_assessors:
                checks = assessed_checks(self.current['state'], now=current_time, cluster=cluster)
                if resource_checks is not None:
                    checks = {identity:(domain, capacity and resource_checks.get(identity, ('', False))[1]) for identity,(domain,capacity) in checks.items()}
                resource_checks = checks
            return registered_candidates(self.current['state'], self.network,
                {issuer:bytes.fromhex(public) for issuer,public in self.license_issuers.items()},
                resource_checks or {}, now=current_time)

    def close(self):
        with self.refresh_lock, self.lock:
            if self.update_owner is not None:
                raise ValueError('stop_directory_updater_before_close')
            if not self.closed:
                self.current = None
                self.closed = True
                self.db.close()

    def placement(self, cluster):
        with self.lock:
            anchor = self.anchor()
            head = self.current['state'].get('placements', {}).get(cluster)
            if head is None:
                raise ValueError('placement_not_confirmed')
            return {'record': json.loads(canonical(head['record'])), 'record_hash': head['digest'], 'finality': anchor}

    def execute(self, operation, payload):
        # Old account-confirm wire format must never inject fixture certificates.
        raise ValueError('cometbft_snapshot_protocol_required')
