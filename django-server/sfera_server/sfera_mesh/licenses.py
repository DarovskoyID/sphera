"""Verify issuer-signed placement profiles. Never authorises paid operations."""
from dataclasses import dataclass
from hashlib import sha256
import time
import uuid
import re
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .storage import canonical

MODULES = frozenset('amocrm bitrix onec office whiteboard planner conference servers channels bots diary family legal multiserver totp'.split())


@dataclass(frozen=True)
class VerifiedLicense:
    node_id: str
    instance_id: str
    network: str
    expires_at: int
    modules: frozenset[str]


def verify_attestation(document, trusted_issuers, expected_node, network, *, instance_id=None, now=None):
    if not isinstance(document, dict) or set(document) != {'claims', 'signature'} or len(canonical(document)) > 16384:
        raise ValueError('invalid_license_document')
    claims = document['claims']
    fields = {'schema', 'issuer', 'instance_id', 'node_id', 'network', 'issued_at', 'expires_at', 'modules'}
    if not isinstance(claims, dict) or set(claims) != fields or claims['schema'] != 'sfera-mesh-license-v1':
        raise ValueError('invalid_license_claims')
    if not isinstance(claims['issuer'], str) or claims['issuer'] not in trusted_issuers:
        raise ValueError('unknown_license_issuer')
    key = trusted_issuers[claims['issuer']]
    if sha256(key).hexdigest() != claims['issuer']:
        raise ValueError('issuer_identity_mismatch')
    try:
        Ed25519PublicKey.from_public_bytes(key).verify(bytes.fromhex(document['signature']), canonical(claims))
    except (ValueError, TypeError, InvalidSignature) as exc:
        raise ValueError('invalid_license_signature') from exc
    if claims['node_id'] != expected_node or claims['network'] != network or (instance_id is not None and claims['instance_id'] != instance_id):
        raise ValueError('license_identity_mismatch')
    try:
        if str(uuid.UUID(claims['instance_id'])) != claims['instance_id']:
            raise ValueError('invalid_instance_id')
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError('invalid_instance_id') from exc
    if not isinstance(expected_node, str) or not re.fullmatch('[0-9a-f]{64}', expected_node) or not isinstance(network, str) or not re.fullmatch('[a-zA-Z0-9._-]{1,128}', network):
        raise ValueError('invalid_mesh_identity')
    current = int(time.time() if now is None else now)
    issued, expires = claims['issued_at'], claims['expires_at']
    if type(issued) is not int or type(expires) is not int or issued > current + 30 or expires <= current or not issued < expires <= issued + 300:
        raise ValueError('license_expired_or_invalid_time')
    modules = claims['modules']
    if not isinstance(modules, list) or len(modules) > len(MODULES):
        raise ValueError('invalid_license_modules')
    seen = set()
    for module in modules:
        if not isinstance(module, dict) or set(module) != {'id', 'expires_at'} or not isinstance(module['id'], str) or module['id'] not in MODULES or module['id'] in seen or type(module['expires_at']) is not int or module['expires_at'] < expires:
            raise ValueError('invalid_license_module')
        seen.add(module['id'])
    return VerifiedLicense(expected_node, claims['instance_id'], network, expires, frozenset(seen))


def placement_candidate(document, trusted_issuers, expected_node, network, failure_domain, memberships=frozenset(), capacity_ok=True, *, now=None):
    from .topology import Candidate
    verified = verify_attestation(document, trusted_issuers, expected_node, network, now=now)
    return Candidate(expected_node, failure_domain, verified.modules, frozenset(memberships), capacity_ok, True, verified.expires_at)
