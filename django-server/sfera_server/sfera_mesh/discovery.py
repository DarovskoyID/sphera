"""Resolve loopback laboratory peers from owner-signed BFT endpoint records."""
import time
import re
from hashlib import sha256
from urllib.parse import urlsplit
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .directory import digest64, ZERO
from .identity import node_id
from .storage import canonical


def validate_endpoint(record, network, now, *, endpoint_policy=''):
    if endpoint_policy not in ('','https-v1'):raise ValueError('unsupported_endpoint_policy')
    domain='sfera-mesh-endpoint-https-v1' if endpoint_policy=='https-v1' else 'sfera-mesh-endpoint-lab-v1'
    if not isinstance(record, dict) or set(record) != {'body', 'signature'} or len(canonical(record)) > 2048:
        raise ValueError('invalid_endpoint_record')
    b = record['body']
    fields = {'domain', 'network', 'node_id', 'public_key', 'version', 'previous', 'endpoint', 'issued_at', 'expires_at'}
    if not isinstance(b, dict) or set(b) != fields or b['domain'] != domain or b['network'] != network:
        raise ValueError('invalid_endpoint_context')
    if (type(b['version']) is not int or not 1 <= b['version'] <= 2**63-1 or
            (b['version'] == 1 and b['previous'] != ZERO) or
            any(not digest64(b[name]) for name in ('node_id', 'public_key', 'previous')) or
            any(type(b[name]) is not int for name in ('issued_at', 'expires_at')) or
            not 0 < b['issued_at'] <= now + 5 or b['issued_at'] < now - 30 or
            b['expires_at'] <= now or not 0 < b['expires_at'] - b['issued_at'] <= 3600):
        raise ValueError('invalid_endpoint_fields')
    if not isinstance(b['endpoint'], str):
        raise ValueError('invalid_endpoint_address')
    url = urlsplit(b['endpoint'])
    if endpoint_policy=='https-v1':
        host=url.hostname
        if (not host or len(host)>253 or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?',label) for label in host.split('.'))
            or not url.port or not 1<=url.port<=65535 or b['endpoint']!=f'https://{host}:{url.port}'):
            raise ValueError('canonical_https_endpoint_required')
    elif not url.port or not 1 <= url.port <= 65535 or b['endpoint'] != f'http://127.0.0.1:{url.port}':
        raise ValueError('endpoint_loopback_lab_only')
    public = bytes.fromhex(b['public_key'])
    if node_id(public) != b['node_id']:
        raise ValueError('endpoint_key_mismatch')
    try:
        signature = bytes.fromhex(record['signature'])
        if len(signature) != 64 or signature.hex() != record['signature']:
            raise ValueError('invalid_endpoint_signature')
        Ed25519PublicKey.from_public_bytes(public).verify(signature, canonical(b))
    except (InvalidSignature, ValueError, TypeError) as error:
        raise ValueError('invalid_endpoint_signature') from error
    return b, sha256(canonical(record)).hexdigest()


def endpoint_record(key, network, endpoint, *, version=1, previous=ZERO, now=None, lifetime=3600,endpoint_policy=''):
    now = int(time.time()) if now is None else now
    public = key.public_key().public_bytes_raw()
    body = {'domain': 'sfera-mesh-endpoint-https-v1' if endpoint_policy=='https-v1' else 'sfera-mesh-endpoint-lab-v1', 'network': network, 'node_id': node_id(public),
            'public_key': public.hex(), 'version': version, 'previous': previous,
            'endpoint': endpoint, 'issued_at': now, 'expires_at': now + lifetime}
    record = {'body': body, 'signature': key.sign(canonical(body)).hex()}
    validate_endpoint(record, network, now,endpoint_policy=endpoint_policy)
    return record


def validate_endpoints(state, network):
    policy=state.get('endpoint_policy','')
    if policy not in ('','https-v1'):raise ValueError('unsupported_endpoint_policy')
    entries = state.get('endpoints', {})
    if not isinstance(entries, dict) or len(entries) > 128:
        raise ValueError('endpoint_registry_limit')
    for identity, head in entries.items():
        if not isinstance(head, dict) or set(head) != {'record', 'digest', 'accepted_at'} or type(head['accepted_at']) is not int or not 0 < head['accepted_at'] <= state['block_time']:
            raise ValueError('invalid_endpoint_head')
        body, digest = validate_endpoint(head['record'], network, head['accepted_at'],endpoint_policy=policy)
        candidate = state.get('candidates', {}).get(identity)
        if body['node_id'] != identity or digest != head['digest'] or candidate is None or candidate['record']['body']['public_key'] != body['public_key']:
            raise ValueError('unregistered_endpoint_owner')


def discovered_peers(directory, *, now=None,https_only=False):
    with directory.lock:
        anchor = directory.anchor()
        state = directory.current['state']
        if https_only and state.get('endpoint_policy','')!='https-v1':raise ValueError('genesis_https_discovery_policy_required')
        validate_endpoints(state, directory.network)
        now = time.time() if now is None else now
        peers = {}
        for identity, head in state.get('endpoints', {}).items():
            body = head['record']['body']
            if body['expires_at'] > now:
                peers[identity] = {'endpoint': body['endpoint'], 'public_key': body['public_key'], 'expires_at': body['expires_at']}
        return {'peers': peers, 'finality': dict(anchor)}
