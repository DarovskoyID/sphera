"""Sparse UUID registry for paged recovery indexes; terminal tombstones.

Only a 32-byte root and counters need to live in consensus. A transition proves
both the old leaf and its replacement, so dropping an old ID is not an operation.
The tree contains status, never message plaintext or application membership.
"""
from hashlib import sha256
import re
import uuid

from .storage import canonical
from .directory import digest64
from .identity import node_id
from .recovery_roots import namespace
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature

DOMAIN = b'sfera-mesh-recovery-tree-v2\0'
DEPTH = 128
BATCH = 4


def identity(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('invalid_recovery_tree_uuid')
    return uuid.UUID(value).int


def leaf(message, status):
    if type(status) is not int or status not in (0, 1, 2):
        raise ValueError('invalid_recovery_tree_status')
    key = identity(message)
    return sha256(b'\0' + DOMAIN + (b'\0' if status == 0 else key.to_bytes(16, 'big') + bytes([status]))).digest()


def parent(left, right):
    return sha256(b'\1' + DOMAIN + left + right).digest()


EMPTY = [sha256(b'\0' + DOMAIN + b'\0').digest()]
for _ in range(DEPTH):
    EMPTY.append(parent(EMPTY[-1], EMPTY[-1]))


def path_root(message, status, path):
    key = identity(message)
    if not isinstance(path, list) or len(path) != DEPTH or any(not digest64(item) for item in path):
        raise ValueError('invalid_recovery_tree_path')
    value = leaf(message, status)
    for sibling in path:
        other = bytes.fromhex(sibling)
        value = parent(other, value) if key & 1 else parent(value, other)
        key >>= 1
    return value.hex()


def transition(root, count, deleted_count, updates):
    if (not digest64(root) or type(count) is not int or type(deleted_count) is not int or
            not 0 <= deleted_count <= count <= 2**63 - 1 or (count == 0) != (root == EMPTY[DEPTH].hex()) or
            not isinstance(updates, list) or len(updates) > BATCH):
        raise ValueError('invalid_recovery_tree_transition')
    seen = set()
    for update in updates:
        if not isinstance(update, dict) or set(update) != {'message', 'old', 'new', 'path'}:
            raise ValueError('invalid_recovery_tree_update')
        message, old, new, path = (update[key] for key in ('message', 'old', 'new', 'path'))
        identity(message)
        if (message in seen or type(old) is not int or old not in (0, 1, 2) or
                type(new) is not int or new not in (1, 2) or (old == 2 and new != 2)):
            raise ValueError('recovery_tree_omission_or_resurrection')
        seen.add(message)
        if path_root(message, old, path) != root:
            raise ValueError('recovery_tree_old_root_mismatch')
        root = path_root(message, new, path)
        count += int(old == 0)
        deleted_count += int(new == 2 and old != 2)
        if count > 2**63 - 1 or deleted_count > count:
            raise ValueError('recovery_tree_counter_overflow')
    return root, count, deleted_count


class RecoveryTree:
    """Publisher-side proof builder. The on-chain transition verifies its output."""
    def __init__(self, messages=(), deleted=()):
        self.nodes, self.status, self.deleted_count = {}, {}, 0
        deleted = set(deleted)
        messages = list(messages)
        if len(set(messages)) != len(messages) or not deleted.issubset(messages):
            raise ValueError('invalid_recovery_tree_messages')
        for message in messages:
            self.update(message, 2 if message in deleted else 1)

    @property
    def root(self):
        return self.nodes.get((DEPTH, 0), EMPTY[DEPTH]).hex()

    def proof(self, message):
        key = identity(message)
        result = []
        for level in range(DEPTH):
            result.append(self.nodes.get((level, key ^ 1), EMPTY[level]).hex())
            key >>= 1
        return result

    def update(self, message, status):
        old = self.status.get(message, 0)
        proof = self.proof(message)
        # Validate before mutating local state, too.
        transition(self.root, len(self.status), self.deleted_count,
            [{'message': message, 'old': old, 'new': status, 'path': proof}])
        key = identity(message)
        value = leaf(message, status)
        self.nodes[(0, key)] = value
        for level in range(DEPTH):
            sibling = self.nodes.get((level, key ^ 1), EMPTY[level])
            value = parent(sibling, value) if key & 1 else parent(value, sibling)
            key >>= 1
            self.nodes[(level + 1, key)] = value
        self.status[message] = status
        self.deleted_count += int(status == 2 and old != 2)
        return {'message': message, 'old': old, 'new': status, 'path': proof}


def updates_digest(updates):
    return sha256(canonical(updates)).hexdigest()


HEAD_DOMAIN = 'sfera-mesh-recovery-tree-head-v2'
HEAD_FIELDS = {'domain', 'network', 'genesis', 'publisher', 'public_key', 'source', 'scope',
    'version', 'previous', 'cluster', 'digest', 'size', 'root', 'count', 'deleted_count', 'updates_hash'}


def validate_head(record, network, genesis):
    if not isinstance(record, dict) or set(record) != {'body', 'signature'} or len(canonical(record)) > 4096:
        raise ValueError('invalid_recovery_tree_record')
    body = record['body']
    if (not isinstance(body, dict) or set(body) != HEAD_FIELDS or body['domain'] != HEAD_DOMAIN or
            body['network'] != network or body['genesis'] != genesis or
            not isinstance(network, str) or not re.fullmatch('[A-Za-z0-9._-]{1,64}', network) or
            any(not digest64(body[key]) for key in ('genesis', 'publisher', 'public_key', 'previous', 'cluster', 'digest', 'root', 'updates_hash')) or
            type(body['version']) is not int or not 1 <= body['version'] <= 2**63 - 1 or
            (body['version'] == 1 and body['previous'] != '0' * 64) or
            type(body['size']) is not int or not 1 <= body['size'] <= 262144 or
            type(body['count']) is not int or type(body['deleted_count']) is not int or
            not 0 <= body['deleted_count'] <= body['count'] <= 2**63 - 1 or
            (body['count'] == 0) != (body['root'] == EMPTY[DEPTH].hex())):
        raise ValueError('invalid_recovery_tree_head')
    namespace(body['publisher'], body['source'], body['scope'])
    public = bytes.fromhex(body['public_key'])
    signature = record['signature']
    if node_id(public) != body['publisher'] or not isinstance(signature, str) or len(signature) != 128 or signature != bytes.fromhex(signature).hex():
        raise ValueError('invalid_recovery_tree_signature')
    try:
        Ed25519PublicKey.from_public_bytes(public).verify(bytes.fromhex(signature), canonical(body))
    except InvalidSignature as exc:
        raise ValueError('invalid_recovery_tree_signature') from exc
    return body, sha256(canonical(record)).hexdigest()


def head_record(key, network, genesis, source, scope, cluster, block_digest, size, tree_root, count, deleted_count,
        *, version=1, previous='0' * 64, updates=()):
    public = key.public_key().public_bytes_raw()
    updates = list(updates)
    body = {'domain': HEAD_DOMAIN, 'network': network, 'genesis': genesis, 'publisher': node_id(public),
        'public_key': public.hex(), 'source': source, 'scope': scope, 'cluster': cluster, 'digest': block_digest,
        'size': size, 'version': version, 'previous': previous, 'root': tree_root, 'count': count,
        'deleted_count': deleted_count, 'updates_hash': updates_digest(updates)}
    record = {'body': body, 'signature': key.sign(canonical(body)).hex()}
    validate_head(record, network, genesis)
    return record


def validate_state(state, network, genesis):
    heads = state.get('recovery_trees', {})
    legacy = state.get('recovery_roots', {})
    if not isinstance(heads, dict) or len(set(heads) | set(legacy)) > 128:
        raise ValueError('recovery_tree_namespace_capacity')
    for identity_key, head in heads.items():
        if not isinstance(head, dict) or set(head) != {'record', 'digest'}:
            raise ValueError('invalid_recovery_tree_head')
        body, digest = validate_head(head['record'], network, genesis)
        candidate = state.get('candidates', {}).get(body['publisher'])
        manifest = state.get('manifests', {}).get(body['cluster'], {}).get('record', {}).get('body', {})
        values, sizes = manifest.get('digests'), manifest.get('sizes')
        if (identity_key != namespace(body['publisher'], body['source'], body['scope']) or head['digest'] != digest or
                candidate is None or candidate['record']['body']['public_key'] != body['public_key'] or
                not isinstance(values, list) or not isinstance(sizes, list) or len(values) != len(sizes) or
                body['digest'] not in values or type(sizes[values.index(body['digest'])]) is not int or
                sizes[values.index(body['digest'])] != body['size']):
            raise ValueError('uncommitted_or_unowned_recovery_tree')


def check_progress(previous, current):
    for key, old in previous.get('recovery_trees', {}).items():
        new = current.get('recovery_trees', {}).get(key)
        a, b = old['record']['body'], new['record']['body'] if new else {}
        if (not new or b['version'] < a['version'] or
                (b['version'] == a['version'] and old['digest'] != new['digest']) or
                (b['version'] == a['version'] + 1 and b['previous'] != old['digest']) or
                b['count'] < a['count'] or b['deleted_count'] < a['deleted_count']):
            raise ValueError('recovery_tree_rollback_or_fork')
