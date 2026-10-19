"""Verify short-lived read leases from a pinned validator committee.

This verifies evidence only. Issuing leases requires the future live BFT service;
laboratory tests use explicit validator keys and do not implement consensus.
"""
import time
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .directory import digest64
from .storage import canonical


def validate_read_lease(committee, lease, anchor, *, now=None):
    if committee is None or not isinstance(lease, dict) or set(lease) != {'body', 'votes'} or len(canonical(lease)) > 32768:
        raise ValueError('invalid_directory_read_lease')
    body = lease['body']
    fields = {'domain', 'network', 'committee', 'height', 'checkpoint_hash', 'issued_at', 'expires_at'}
    if not isinstance(body, dict) or set(body) != fields or body['domain'] != 'sfera-mesh-directory-read-v1' or body['network'] != committee.network or body['committee'] != committee.identifier:
        raise ValueError('invalid_read_lease_context')
    current = int(time.time() if now is None else now)
    if type(body['height']) is not int or body['height'] < 1 or not digest64(body['checkpoint_hash']) or type(body['issued_at']) is not int or type(body['expires_at']) is not int or body['issued_at'] > current + 5 or body['expires_at'] <= current or not body['issued_at'] < body['expires_at'] <= body['issued_at'] + 60:
        raise ValueError('expired_or_invalid_read_lease')
    if anchor != {'committee': committee.identifier, 'height': body['height'], 'checkpoint_hash': body['checkpoint_hash']}:
        raise ValueError('directory_checkpoint_changed')
    votes = lease['votes']
    if not isinstance(votes, list) or len(votes) > len(committee.members):
        raise ValueError('invalid_read_lease_votes')
    members, seen = dict(committee.members), set()
    try:
        for identity, signature in votes:
            if identity in seen or identity not in members:
                raise ValueError('duplicate_or_unknown_read_validator')
            Ed25519PublicKey.from_public_bytes(members[identity]).verify(bytes.fromhex(signature), canonical(body))
            seen.add(identity)
    except (ValueError, TypeError, InvalidSignature) as exc:
        raise ValueError('invalid_read_lease_signature') from exc
    if len(seen) < committee.quorum:
        raise ValueError('insufficient_read_lease_quorum')
    return body
