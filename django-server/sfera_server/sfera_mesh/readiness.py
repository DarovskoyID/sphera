"""Short-lived target signature over a manifest-bound placement proposal."""
from hashlib import sha256
import time
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .directory import digest64, ZERO
from .identity import node_id
from .storage import canonical


def base_proposal(proposal):
    body=dict(proposal['body'])
    if body['domain']=='sfera-mesh-placement-v3': body['readiness_hash']=ZERO
    return {'body':body,'licenses':proposal['licenses']}


def proposal_hash(body):
    value=dict(body); value.pop('readiness_hash',None)
    return sha256(canonical(value)).hexdigest()


def readiness_proof(body,key,*,now=None):
    current=int(time.time() if now is None else now)
    claims={'domain':'sfera-mesh-readiness-v1','network':body['network'],'cluster':body['cluster'],'proposal_hash':proposal_hash(body),'manifest_hash':body['manifest_hash'],'target':node_id(key.public_key().public_bytes_raw()),'checked_at':current,'expires_at':current+30}
    return {'body':claims,'public_key':key.public_key().public_bytes_raw().hex(),'signature':key.sign(canonical(claims)).hex()}


def validate_readiness(proof,body,*,now=None):
    if not isinstance(proof,dict) or set(proof)!={'body','public_key','signature'} or not digest64(proof['public_key']) or sha256(canonical(proof)).hexdigest()!=body.get('readiness_hash'):
        raise ValueError('invalid_readiness_commitment')
    claims=proof['body']
    fields={'domain','network','cluster','proposal_hash','manifest_hash','target','checked_at','expires_at'}
    if not isinstance(claims,dict) or set(claims)!=fields or claims['domain']!='sfera-mesh-readiness-v1' or claims['network']!=body['network'] or claims['cluster']!=body['cluster'] or claims['proposal_hash']!=proposal_hash(body) or claims['manifest_hash']!=body.get('manifest_hash') or claims['target'] not in body['members'] or type(claims['checked_at']) is not int or type(claims['expires_at']) is not int or not 1<=claims['checked_at']<=2**63-31 or not claims['checked_at']<claims['expires_at']<=claims['checked_at']+30:
        raise ValueError('invalid_readiness_context')
    try:
        public=bytes.fromhex(proof['public_key']); signature=bytes.fromhex(proof['signature'])
        if node_id(public)!=claims['target'] or len(signature)!=64 or signature.hex()!=proof['signature']: raise ValueError('readiness_identity')
        Ed25519PublicKey.from_public_bytes(public).verify(signature,canonical(claims))
    except (ValueError,TypeError,InvalidSignature) as exc: raise ValueError('invalid_readiness_signature') from exc
    if now is not None and (claims['checked_at']>now+5 or claims['expires_at']<=now): raise ValueError('readiness_expired_or_future')
    return claims

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
