"""Signed placement offers; not validator admission or resource attestations."""
from hashlib import sha256
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .directory import ZERO, digest64
from .identity import node_id
from .licenses import verify_attestation
from .storage import canonical


def validate_candidate(record, network):
    if not isinstance(record, dict) or set(record) != {'body', 'signature'} or len(canonical(record)) > 16384:
        raise ValueError('invalid_candidate_record')
    body = record['body']
    fields = {'domain', 'network', 'node_id', 'public_key', 'version', 'previous', 'available', 'license'}
    if not isinstance(body, dict) or set(body) != fields or body['domain'] != 'sfera-mesh-candidate-v1' or body['network'] != network or type(body['version']) is not int or not 1 <= body['version'] <= 2**63-1 or type(body['available']) is not bool or any(not digest64(body[field]) for field in ('node_id', 'public_key', 'previous')):
        raise ValueError('invalid_candidate_body')
    if body['version'] == 1 and body['previous'] != ZERO:
        raise ValueError('invalid_initial_candidate')
    try:
        public = bytes.fromhex(body['public_key'])
        signature = bytes.fromhex(record['signature'])
        if node_id(public) != body['node_id'] or len(signature) != 64 or signature.hex() != record['signature']:
            raise ValueError('candidate_identity_mismatch')
        Ed25519PublicKey.from_public_bytes(public).verify(signature, canonical(body))
    except (InvalidSignature, ValueError, TypeError) as exc:
        raise ValueError('invalid_candidate_signature') from exc
    return body, sha256(canonical(record)).hexdigest()


def candidate_record(key, network, document, *, version=1, previous=ZERO, available=True):
    public = key.public_key().public_bytes_raw()
    body = {'domain': 'sfera-mesh-candidate-v1', 'network': network, 'node_id': node_id(public), 'public_key': public.hex(), 'version': version, 'previous': previous, 'available': available, 'license': document}
    record = {'body': body, 'signature': key.sign(canonical(body)).hex()}
    validate_candidate(record, network)
    return record


def validate_registry(state, network, trusted_issuers):
    entries = state.get('candidates', {})
    if not isinstance(entries, dict) or len(entries) > 128:
        raise ValueError('candidate_laboratory_limit')
    instances = set()
    for identity, head in entries.items():
        if not isinstance(head, dict) or set(head) != {'record', 'digest', 'accepted_at'}:
            raise ValueError('invalid_candidate_head')
        body, digest = validate_candidate(head['record'], network)
        at = head['accepted_at']
        if identity != body['node_id'] or digest != head['digest'] or type(at) is not int or not 0 < at <= state.get('block_time', 0):
            raise ValueError('invalid_candidate_head')
        profile = verify_attestation(body['license'], trusted_issuers, identity, network, now=at)
        if body['available'] and profile.expires_at > state['block_time']:
            if profile.instance_id in instances:
                raise ValueError('duplicate_candidate_license_instance')
            instances.add(profile.instance_id)


def registered_candidates(state, network, trusted_issuers, resource_checks, *, now):
    """Use local resource assessments, but consensus profiles and memberships.

    resource_checks maps node IDs to (failure_domain, capacity_ok). These
    assessments remain local policy, not proof accepted by validators.
    """
    from .licenses import placement_candidate
    validate_registry(state, network, trusted_issuers)
    result = []
    for identity, head in state.get('candidates', {}).items():
        body = head['record']['body']
        if not body['available'] or identity not in resource_checks or body['license']['claims']['expires_at'] <= now:
            continue
        domain, capacity = resource_checks[identity]
        memberships = {cluster for cluster, placement in state.get('placements', {}).items() if identity in placement['record']['body']['members']}
        result.append(placement_candidate(body['license'], trusted_issuers, identity, network, domain, memberships, capacity, now=now))
    return sorted(result, key=lambda candidate: candidate.node_id)
