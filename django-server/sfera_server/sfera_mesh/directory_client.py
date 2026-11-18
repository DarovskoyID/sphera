"""Bounded replication/lookup against an explicit roster of laboratory peers.

Peers are storage locations, never a new user entry point. No login session is
issued. Global discovery, freshness and BFT finalisation are separate layers.
"""
from .directory import validate_record
from .transport import exchange


def _peers(peers):
    peers = list(peers)
    if not peers or len(peers) > 16 or len({node for node, _ in peers}) != len(peers):
        raise ValueError('invalid_directory_peer_set')
    return peers


def publish_account(record, peers, key, verifier):
    validate_record(record, verifier.network)
    stored = []
    for node, endpoint in _peers(peers):
        try:
            exchange(endpoint, key, verifier, node, 'account-put', {'record': record})
            stored.append(node)
        except (OSError, ValueError):
            continue
    return stored  # Local delivery receipts, not a quorum/finality certificate.


def resolve_account(identity, peers, key, verifier, cache, *, batch_limit=64):
    peers = _peers(peers)
    if type(batch_limit) is not int or not 1 <= batch_limit <= 64 or cache.network != verifier.network:
        raise ValueError('invalid_directory_sync')
    found = []
    hashes = {}
    for node, endpoint in peers:
        try:
            result = exchange(endpoint, key, verifier, node, 'account-get', {'user_id': identity, 'version': None, 'confirmed': False}, committee=cache.committee)
        except (OSError, ValueError):
            continue
        if result == {'error': 'not_found'}:
            continue
        version = result['record']['body']['version']
        if version in hashes and hashes[version] != result['record_hash']:
            raise ValueError('account_fork')
        hashes[version] = result['record_hash']
        found.append((version, node, endpoint, result))
    if not found:
        raise ValueError('account_directory_unavailable')
    target, _, _, best = max(found, key=lambda item: item[0])
    local = cache.get(identity)
    current = 0 if local == {'error': 'not_found'} else local['record']['body']['version']
    if current > target:
        raise ValueError('directory_peer_rollback')
    for version, digest in hashes.items():
        old = cache.get(identity, version)
        if old != {'error': 'not_found'} and old['record_hash'] != digest:
            raise ValueError('account_fork')
    stop = min(target, current + batch_limit)
    sources = [(node, endpoint) for version, node, endpoint, _ in found if version >= stop]
    for version in range(current + 1, stop + 1):
        record = None
        for node, endpoint in sources:
            try:
                result = exchange(endpoint, key, verifier, node, 'account-get', {'user_id': identity, 'version': version, 'confirmed': False}, committee=cache.committee)
            except (OSError, ValueError):
                continue
            if result != {'error': 'not_found'}:
                record = result['record']
                break
        if record is None:
            raise ValueError('account_chain_unavailable')
        cache.save(record)  # Validates every previous hash; never jumps versions.
    local = cache.get(identity)
    if stop == target and local['record_hash'] != best['record_hash']:
        raise ValueError('account_fork')
    return {'account': local, 'synced': stop == target, 'target_version': target}
