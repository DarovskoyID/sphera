"""Authenticated current pointers for encrypted application recovery indexes.

A pointer certifies one committed block in a publisher-owned namespace. It does
not make that block an authorized feed or prove the application's index complete.
"""
from hashlib import sha256
import json
import re
import uuid

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .directory import digest64, ZERO
from .identity import node_id
from .storage import canonical

DOMAIN = 'sfera-mesh-recovery-root-v1'


def namespace(publisher, source, scope):
    if not digest64(publisher) or source not in ('dm', 'guild') or not isinstance(scope, str) or str(uuid.UUID(scope)) != scope:
        raise ValueError('invalid_recovery_namespace')
    return sha256(canonical({'domain': 'sfera-mesh-recovery-namespace-v1',
        'publisher': publisher, 'source': source, 'scope': scope})).hexdigest()


def validate_root(record, network, genesis):
    if not isinstance(record, dict) or set(record) != {'body', 'signature'} or len(canonical(record)) > 32768:
        raise ValueError('invalid_recovery_root_record')
    body = record['body']
    fields = {'domain', 'network', 'genesis', 'publisher', 'public_key', 'source', 'scope',
        'version', 'previous', 'cluster', 'digest', 'size', 'messages', 'deleted'}
    if (not isinstance(body, dict) or set(body) != fields or body['domain'] != DOMAIN or
            body['network'] != network or body['genesis'] != genesis or not isinstance(network, str) or
            not re.fullmatch('[A-Za-z0-9._-]{1,64}', network) or
            any(not digest64(body[field]) for field in ('genesis', 'publisher', 'public_key', 'previous', 'cluster', 'digest')) or
            type(body['version']) is not int or not 1 <= body['version'] <= 2**63-1 or
            (body['version'] == 1 and body['previous'] != ZERO) or type(body['size']) is not int or not 1 <= body['size'] <= 262144):
        raise ValueError('invalid_recovery_root_context')
    namespace(body['publisher'], body['source'], body['scope'])
    messages, deleted = body['messages'], body['deleted']
    if (not isinstance(messages, list) or len(messages) > 256 or any(not isinstance(item, str) or str(uuid.UUID(item)) != item for item in messages) or
            messages != sorted(set(messages)) or not isinstance(deleted, list) or
            any(not isinstance(item, str) for item in deleted) or deleted != sorted(set(deleted)) or not set(deleted).issubset(messages)):
        raise ValueError('invalid_recovery_root_message_set')
    public = bytes.fromhex(body['public_key'])
    if node_id(public) != body['publisher']:
        raise ValueError('recovery_publisher_key_mismatch')
    try:
        signature = record['signature']
        if not isinstance(signature, str) or not re.fullmatch('[0-9a-f]{128}', signature):
            raise ValueError('invalid_recovery_root_signature')
        Ed25519PublicKey.from_public_bytes(public).verify(bytes.fromhex(signature), canonical(body))
    except InvalidSignature as exc:
        raise ValueError('invalid_recovery_root_signature') from exc
    return body, sha256(canonical(record)).hexdigest()


def root_record(key, network, genesis, source, scope, cluster, block_digest, size, *, version=1, previous=ZERO, messages=(), deleted=()):
    public = key.public_key().public_bytes_raw()
    body = {'domain': DOMAIN, 'network': network, 'genesis': genesis, 'publisher': node_id(public),
        'public_key': public.hex(), 'source': source, 'scope': scope, 'cluster': cluster,
        'digest': block_digest, 'size': size, 'version': version, 'previous': previous,
        'messages': list(messages), 'deleted': list(deleted)}
    record = {'body': body, 'signature': key.sign(canonical(body)).hex()}
    validate_root(record, network, genesis)
    return record


def validate_recovery_roots(state, network, genesis):
    heads = state.get('recovery_roots', {})
    if not isinstance(heads, dict) or len(heads) > 128:
        raise ValueError('recovery_root_registry_limit')
    count = 0
    for identity, head in heads.items():
        if not isinstance(head, dict) or set(head) != {'record', 'digest'}:
            raise ValueError('invalid_recovery_root_head')
        body, digest = validate_root(head['record'], network, genesis)
        count += len(body['messages'])
        if count > 512:
            raise ValueError('recovery_root_message_registry_limit')
        candidate = state.get('candidates', {}).get(body['publisher'])
        manifest = state.get('manifests', {}).get(body['cluster'], {}).get('record', {}).get('body', {})
        values, sizes = manifest.get('digests'), manifest.get('sizes')
        if (identity != namespace(body['publisher'], body['source'], body['scope']) or digest != head['digest'] or
                candidate is None or candidate['record']['body']['public_key'] != body['public_key'] or
                not isinstance(values, list) or not isinstance(sizes, list) or len(values) != len(sizes) or
                body['digest'] not in values or type(sizes[values.index(body['digest'])]) is not int or
                sizes[values.index(body['digest'])] != body['size']):
            raise ValueError('uncommitted_or_unowned_recovery_root')


def check_progress(previous, current):
    for identity, head in previous.get('recovery_roots', {}).items():
        new = current.get('recovery_roots', {}).get(identity)
        version = head['record']['body']['version']
        if (not new or new['record']['body']['version'] < version or
                (new['record']['body']['version'] == version and new['digest'] != head['digest']) or
                (new['record']['body']['version'] == version + 1 and new['record']['body']['previous'] != head['digest'])):
            raise ValueError('recovery_root_rollback_or_fork')
        if (not set(head['record']['body']['messages']).issubset(new['record']['body']['messages']) or
                not set(head['record']['body']['deleted']).issubset(new['record']['body']['deleted'])):
            raise ValueError('recovery_root_omission_or_resurrection')


def current_root(directory, publisher, source, scope):
    identity = namespace(publisher, source, scope)
    with directory.lock:
        anchor = directory.anchor()
        if identity in directory.current['state'].get('recovery_trees', {}):
            # Never expose the frozen legacy root after a v2 deletion. A reader
            # must explicitly understand the paged v2 format before migrating.
            raise ValueError('recovery_tree_v2_reader_required')
        head = directory.current['state'].get('recovery_roots', {}).get(identity)
        if head is None:
            raise ValueError('recovery_root_not_published')
        return {**json.loads(canonical(head)), 'finality': dict(anchor)}
