"""Fixed-genesis laboratory capacity assessments. Not proof of storage."""
import base64
from hashlib import sha256
import re
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .directory import ZERO, digest64
from .storage import canonical


def pinned_assessors(genesis):
    if not (genesis.get('app_state') or {}).get('placement_policy'):
        return {}
    keys = {}
    for validator in genesis['validators']:
        public = base64.b64decode(validator['pub_key']['value'], validate=True)
        if validator['pub_key']['type'] != 'tendermint/PubKeyEd25519' or len(public) != 32 or int(validator['power']) != 1:
            raise ValueError('unsupported_resource_assessor')
        keys[sha256(public).hexdigest()] = public.hex()
    if len(keys) != 4:
        raise ValueError('four_resource_assessors_required')
    return keys


def resource_record(body, keys):
    consents = [{'public_key': key.public_key().public_bytes_raw().hex(), 'signature': key.sign(canonical(body)).hex()} for key in keys]
    return {'body': body, 'consents': sorted(consents, key=lambda item: item['public_key'])}


def validate_resource(record, network, assessors):
    if not isinstance(record, dict) or set(record) != {'body', 'consents'} or len(canonical(record)) > 16384 or len(assessors) != 4:
        raise ValueError('invalid_resource_record')
    body = validate_resource_body(record['body'], network)
    consents = record['consents']
    if not isinstance(consents, list) or len(consents) != 3:
        raise ValueError('three_resource_assessors_required')
    prior = ''
    for consent in consents:
        if not isinstance(consent, dict) or set(consent) != {'public_key', 'signature'} or not digest64(consent['public_key']) or consent['public_key'] <= prior:
            raise ValueError('distinct_sorted_resource_assessors_required')
        try:
            public = bytes.fromhex(consent['public_key'])
            signature = bytes.fromhex(consent['signature'])
            if assessors.get(sha256(public).hexdigest()) != consent['public_key'] or len(signature) != 64 or signature.hex() != consent['signature']:
                raise ValueError('resource_assessor_identity')
            Ed25519PublicKey.from_public_bytes(public).verify(signature, canonical(body))
        except (ValueError, TypeError, InvalidSignature) as exc:
            raise ValueError('invalid_resource_signature') from exc
        prior = consent['public_key']
    return body, sha256(canonical(record)).hexdigest()


def validate_resource_body(body, network):
    fields = {'domain', 'network', 'node_id', 'candidate_hash', 'version', 'previous', 'failure_domain', 'capacity_slots', 'issued_at', 'expires_at'}
    if not isinstance(body, dict) or set(body) != fields or body['domain'] != 'sfera-mesh-resource-v1' or body['network'] != network or any(not digest64(body[field]) for field in ('node_id', 'candidate_hash', 'previous')):
        raise ValueError('invalid_resource_context')
    if type(body['version']) is not int or not 1 <= body['version'] <= 2**63-1 or (body['version'] == 1 and body['previous'] != ZERO) or type(body['capacity_slots']) is not int or not 0 <= body['capacity_slots'] <= 2 or not isinstance(body['failure_domain'], str) or not re.fullmatch('[a-zA-Z0-9._-]{1,64}', body['failure_domain']):
        raise ValueError('invalid_resource_capacity')
    issued, expires = body['issued_at'], body['expires_at']
    if type(issued) is not int or type(expires) is not int or not 0 <= issued <= 2**63-1-300 or not issued < expires <= issued+300:
        raise ValueError('invalid_resource_interval')
    return body


def validate_resources(state, network, assessors):
    if state.get('placement_assessors', {}) != assessors:
        raise ValueError('resource_trust_changed')
    resources = state.get('resources', {})
    if not isinstance(resources, dict) or len(resources) > 128:
        raise ValueError('resource_laboratory_limit')
    for identity, head in resources.items():
        if not isinstance(head, dict) or set(head) != {'record', 'digest', 'accepted_at'}:
            raise ValueError('invalid_resource_head')
        body, digest = validate_resource(head['record'], network, assessors)
        at = head['accepted_at']
        if identity != body['node_id'] or digest != head['digest'] or type(at) is not int or not 0 < at <= state.get('block_time', 0) or body['issued_at'] > at+30 or body['expires_at'] <= at:
            raise ValueError('invalid_resource_acceptance')


def assessed_checks(state, *, now, cluster=None):
    """Read assessments only from a previously verified consensus snapshot."""
    checks = {}
    for identity, head in state.get('resources', {}).items():
        body = head['record']['body']
        candidate = state.get('candidates', {}).get(identity)
        if candidate is None or candidate['digest'] != body['candidate_hash'] or body['expires_at'] <= now:
            continue
        memberships = {key for key, placement in state.get('placements', {}).items() if identity in placement['record']['body']['members']}
        required = len(memberships) + (0 if cluster in memberships else 1)
        checks[identity] = (body['failure_domain'], body['capacity_slots'] >= required)
    return checks
