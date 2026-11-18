"""Bounded laboratory disk/transport measurements; not proof of storage."""
from dataclasses import dataclass
from hashlib import sha256
import os
from pathlib import Path
import secrets
import shutil
import tempfile
import threading
import time
from urllib.error import HTTPError
from .consensus_directory import validate_address
from .storage import canonical
from .transport import exchange


class CapacitySampler:
    def __init__(self, storage_path, *, interval=5, budget=None):
        self.budget=budget
        self.path = Path(storage_path).resolve(strict=True)
        if not self.path.is_dir() or type(interval) is not int or not 1 <= interval <= 60:
            raise ValueError('invalid_capacity_sampler')
        self.interval, self.last = interval, None
        self.cached = None
        self.lock = threading.Lock()

    def sample(self):
        with self.lock:
            now = time.monotonic()
            if self.last is not None and now-self.last < self.interval:
                if self.cached is not None:
                    result=dict(self.cached)
                    if self.budget is not None:
                        available=self.budget.usage()['available_bytes']
                        if available is not None:result['free_bytes']=min(result['free_bytes'],available)
                    return result
                raise ValueError('capacity_sample_rate_limit')
            self.last = now
            data = secrets.token_bytes(65536)
            started = time.perf_counter_ns()
            # Only a new private temporary file in the configured storage path.
            with tempfile.TemporaryFile(dir=self.path, prefix='mesh-capacity-') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
                stream.seek(0)
                if stream.read() != data:
                    raise ValueError('capacity_disk_readback_failed')
            elapsed = max(1, time.perf_counter_ns()-started)
            free=shutil.disk_usage(self.path).free
            if self.budget is not None:
                available=self.budget.usage()['available_bytes']
                if available is not None:free=min(free,available)
            self.cached = {'free_bytes': free,
                    'disk_bytes_per_second': 2*len(data)*1_000_000_000//elapsed,
                    'sampled_at': int(time.time())}
            return dict(self.cached)


class CapacityAssessor:
    """One pinned assessor; no coordinator receives its private key."""
    def __init__(self, directory, assessor_key, probe_key, verifier, endpoints, failure_domains, policy):
        self.directory, self.assessor_key, self.probe_key = directory, assessor_key, probe_key
        self.verifier, self.endpoints, self.failure_domains, self.policy = verifier, dict(endpoints), dict(failure_domains), policy

    def consent(self, payload):
        if not isinstance(payload, dict) or set(payload) != {'body'} or not isinstance(payload['body'],dict) or payload['body'].get('capacity_slots') not in (1, 2):
            raise ValueError('positive_capacity_proposal_required')
        body = payload['body']
        consent = measured_resource_consent(body,self.directory,self.assessor_key,self.probe_key,self.verifier,self.endpoints,self.failure_domains,self.policy)
        with self.directory.lock:
            count = sum(body['node_id'] in head['record']['body']['members'] for head in self.directory.current['state'].get('placements',{}).values())
            if body['capacity_slots'] < count: raise ValueError('positive_renewal_cannot_reduce_membership_capacity')
        return {'body_hash':sha256(canonical(body)).hexdigest(),'consent':consent}


@dataclass(frozen=True)
class CapacityPolicy:
    bytes_per_slot: int
    transport_bytes_per_second_per_slot: int
    disk_bytes_per_second_per_slot: int
    reserve_bytes: int = 0

    def __post_init__(self):
        if any(type(value) is not int or not 1 <= value <= 2**63-1 for value in
               (self.bytes_per_slot, self.transport_bytes_per_second_per_slot, self.disk_bytes_per_second_per_slot)) or type(self.reserve_bytes) is not int or not 0 <= self.reserve_bytes <= 2**63-1:
            raise ValueError('explicit_capacity_thresholds_required')


def measure_capacity(endpoint, key, verifier, recipient, policy, *, memberships=0):
    from .transport import validate_peer_endpoint
    validate_peer_endpoint(verifier,recipient,endpoint)
    if type(memberships) is not int or not 0 <= memberships <= 2:
        raise ValueError('invalid_capacity_memberships')
    payload = {'challenge': secrets.token_hex(32), 'data': secrets.token_bytes(32768).hex()}
    started = time.perf_counter_ns()
    try:
        result = exchange(endpoint, key, verifier, recipient, 'capacity-probe', payload)
    except HTTPError as exc:
        exc.close()
        raise
    elapsed = max(1, time.perf_counter_ns()-started)
    sample = result['sample']
    if any(type(sample.get(field)) is not int or not 0 <= sample[field] <= 2**63-1 for field in ('free_bytes','disk_bytes_per_second','sampled_at')) or not int(time.time())-30 <= sample['sampled_at'] <= int(time.time())+5:
        raise ValueError('invalid_capacity_sample')
    # End-to-end payload goodput includes disk sampling and signing overhead;
    # it is a conservative short loopback observation, not link capacity.
    transport_rate = len(payload['data'])*1_000_000_000//elapsed
    storage_slots = memberships + max(0, sample['free_bytes']-policy.reserve_bytes)//policy.bytes_per_slot
    slots = min(2, storage_slots,
                transport_rate//policy.transport_bytes_per_second_per_slot,
                sample['disk_bytes_per_second']//policy.disk_bytes_per_second_per_slot)
    return {**sample, 'transport_bytes_per_second': transport_rate, 'capacity_slots': slots}


def measured_resource_consent(body, directory, assessor_key, probe_key, verifier, endpoints, failure_domains, policy):
    """One assessor measures independently and signs only its own consent.

    Failure domains are operator-pinned inventory, never a node's own claim.
    No helper here possesses or synthesises a quorum of private keys.
    """
    from .resources import validate_resource_body
    validate_resource_body(body, directory.network)
    public = assessor_key.public_key().public_bytes_raw()
    if directory.placement_assessors.get(sha256(public).hexdigest()) != public.hex():
        raise ValueError('unpinned_capacity_assessor')
    identity = body['node_id']
    if failure_domains.get(identity) != body['failure_domain'] or identity not in endpoints:
        raise ValueError('pinned_capacity_inventory_required')
    def check():
        directory.anchor()
        state = directory.current['state']
        candidate = state.get('candidates', {}).get(identity)
        old = state.get('resources', {}).get(identity)
        version = old['record']['body']['version']+1 if old else 1
        previous = old['digest'] if old else '0'*64
        now = int(time.time())
        if candidate is None or candidate['digest'] != body['candidate_hash'] or not candidate['record']['body']['available'] or body['version'] != version or body['previous'] != previous or not now-30 <= body['issued_at'] <= now+5 or not now < body['expires_at'] <= min(now+60,candidate['record']['body']['license']['claims']['expires_at']):
            raise ValueError('capacity_proposal_changed_or_expired')
        return sum(identity in head['record']['body']['members'] for head in state.get('placements', {}).values())
    with directory.lock:
        memberships = check()
    measurement = measure_capacity(endpoints[identity], probe_key, verifier, identity, policy, memberships=memberships)
    if body['capacity_slots'] > measurement['capacity_slots']:
        raise ValueError('insufficient_measured_capacity')
    if body['capacity_slots'] == 0 and measurement['capacity_slots'] > 0:
        raise ValueError('healthy_measurement_cannot_revoke_capacity')
    with directory.lock:
        if check() != memberships:
            raise ValueError('capacity_memberships_changed')
        return {'public_key':public.hex(), 'signature':assessor_key.sign(canonical(body)).hex()}
