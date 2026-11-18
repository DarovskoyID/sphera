"""Immutable bounded pages for v2 recovery trees.

This is the data format/reader, not an application HTTP endpoint. `fetch` must
verify block inclusion and the exact committed size before returning ciphertext.
UUID ordering here is for keyed enumeration/lookup, not a chronological feed.
"""
from datetime import datetime
from hashlib import sha256
import json
import math
import time

from .directory import digest64
from .recovery_tree import identity, parent, RecoveryTree, EMPTY
from .storage import canonical

LEAF_SIZE, FANOUT, MAX_DEPTH = 8, 32, 128
MAX_BLOCK = 262144
ENTRY_FIELDS = {'message_id', 'author_id', 'created_at', 'snapshot_hash', 'cluster', 'digest', 'size', 'deleted'}
REF_FIELDS = {'cluster', 'digest', 'size', 'first', 'last', 'count', 'deleted_count', 'level', 'prefix', 'registry_root'}


def bits(message): return format(identity(message), '0128b')


def page_context(value):
    return {key: value[key] for key in ('genesis', 'publisher', 'source', 'scope')}


def subtree_root(tree, prefix):
    return tree.nodes.get((128 - len(prefix), int(prefix or '0', 2)), EMPTY[128 - len(prefix)]).hex()


def combine(children, prefix=''):
    """Lift disjoint compressed UUID subtrees, filling gaps with empty hashes."""
    nodes = {}
    for child in children:
        key = child['prefix']
        if not key.startswith(prefix) or any(key.startswith(old) or old.startswith(key) for old in nodes):
            raise ValueError('recovery_page_prefix_overlap')
        nodes[key] = bytes.fromhex(child['registry_root'])
    if not nodes: return EMPTY[128 - len(prefix)].hex()
    for depth in range(max(map(len, nodes)), len(prefix), -1):
        for key in [key for key in nodes if len(key) == depth]:
            base = key[:-1]
            left = nodes.get(base + '0', EMPTY[128 - depth])
            right = nodes.get(base + '1', EMPTY[128 - depth])
            nodes[base] = parent(left, right)
    return nodes[prefix].hex()


def context(body):
    result = {key: body[key] for key in ('genesis', 'publisher', 'source', 'scope', 'version')}
    result['registry_root'] = body['root']
    if (not all(digest64(result[key]) for key in ('genesis', 'publisher', 'registry_root')) or
            result['source'] not in ('dm', 'guild') or type(result['version']) is not int or not 1 <= result['version'] <= 2**63 - 1):
        raise ValueError('invalid_recovery_page_context')
    identity(result['scope'])
    return result


def reference(value):
    if (not isinstance(value, dict) or set(value) != REF_FIELDS or
            not digest64(value['cluster']) or not digest64(value['digest']) or
            type(value['size']) is not int or not 1 <= value['size'] <= MAX_BLOCK or
            type(value['level']) is not int or not 0 <= value['level'] <= MAX_DEPTH or
            type(value['count']) is not int or type(value['deleted_count']) is not int or
            not 0 <= value['deleted_count'] <= value['count'] <= 2**63 - 1 or value['count'] < 1 or
            not isinstance(value['prefix'], str) or len(value['prefix']) > 128 or set(value['prefix']) - {'0', '1'} or
            not digest64(value['registry_root'])):
        raise ValueError('invalid_recovery_page_reference')
    identity(value['first']); identity(value['last'])
    if (value['first'] > value['last'] or (value['level'] == 0 and value['count'] > LEAF_SIZE) or
            not bits(value['first']).startswith(value['prefix']) or not bits(value['last']).startswith(value['prefix']) or
            value['count'] > 2**(128 - len(value['prefix'])) or value['registry_root'] == EMPTY[128 - len(value['prefix'])].hex()):
        raise ValueError('invalid_recovery_page_range')
    return value


def entry(value):
    if (not isinstance(value, dict) or set(value) != ENTRY_FIELDS or
            any(not digest64(value[key]) for key in ('snapshot_hash', 'cluster', 'digest')) or
            type(value['size']) is not int or not 1 <= value['size'] <= MAX_BLOCK or type(value['deleted']) is not bool):
        raise ValueError('invalid_recovery_page_entry')
    identity(value['message_id']); identity(value['author_id'])
    if value['created_at'] is None:
        if not value['deleted']: raise ValueError('invalid_recovery_page_time')
    else:
        timestamp = datetime.fromisoformat(value['created_at']) if isinstance(value['created_at'], str) else None
        if timestamp is None or timestamp.utcoffset() is None: raise ValueError('invalid_recovery_page_time')
    return value


def acl(document):
    members = document['members']
    if (not isinstance(members, list) or len(members) > 64 or any(not isinstance(member, str) for member in members) or members != sorted(set(members)) or
            type(document['public']) is not bool or type(document['closed']) is not bool or
            (document['closed'] and (document['public'] or members)) or
            (not document['closed'] and not document['public'] and not members)):
        raise ValueError('invalid_recovery_page_acl')
    for user in members: identity(user)
    if document['context']['source'] == 'dm':
        if document['public'] or document['guild_id'] is not None: raise ValueError('invalid_recovery_page_acl')
    else:
        identity(document['guild_id'])


def validate_index(document, body):
    if type(body.get('count')) is not int or type(body.get('deleted_count')) is not int or not 0 <= body['deleted_count'] <= body['count'] <= 2**63 - 1:
        raise ValueError('invalid_recovery_page_counters')
    if (body['count'] == 0) != (body.get('root') == EMPTY[128].hex()): raise ValueError('invalid_recovery_page_empty_root')
    fields = {'domain', 'context', 'members', 'public', 'closed', 'guild_id', 'page'}
    if (not isinstance(document, dict) or set(document) not in (fields, fields | {'timeline'}) or
            document['domain'] != 'sfera-mesh-message-index-v2' or canonical(document['context']) != canonical(context(body))):
        raise ValueError('invalid_recovery_paged_index')
    acl(document)
    page = document['page']
    if body['count'] == 0:
        if page is not None or body['deleted_count'] != 0: raise ValueError('invalid_recovery_empty_index')
    elif (page is None or (reference(page)['count'], page['deleted_count']) != (body['count'], body['deleted_count']) or
            combine([page]) != body['root']):
        raise ValueError('recovery_page_counter_mismatch')
    if 'timeline' in document:
        from .recovery_timeline import reference as time_reference
        live = body['count'] - body['deleted_count']
        if (document['timeline'] is None) != (live == 0): raise ValueError('recovery_timeline_counter_mismatch')
        if live and time_reference(document['timeline'])['count'] != live: raise ValueError('recovery_timeline_counter_mismatch')
    return document


def validate_page(document, ref, expected_context):
    reference(ref)
    if (not isinstance(document, dict) or set(document) != {'domain', 'context', 'level', 'entries', 'children'} or
            document['domain'] != 'sfera-mesh-recovery-page-v2' or canonical(document['context']) != canonical(page_context(expected_context)) or
            type(document['level']) is not int or document['level'] != ref['level'] or
            not isinstance(document['entries'], list) or not isinstance(document['children'], list)):
        raise ValueError('invalid_recovery_page')
    if ref['level'] == 0:
        values = document['entries']
        if document['children'] or not 1 <= len(values) <= LEAF_SIZE: raise ValueError('invalid_recovery_page_leaf')
        for value in values: entry(value)
        ids = [value['message_id'] for value in values]
        if ids != sorted(set(ids)): raise ValueError('recovery_page_order_or_duplicate')
        first, last, count, deleted = ids[0], ids[-1], len(ids), sum(value['deleted'] for value in values)
        tree = RecoveryTree(ids, [value['message_id'] for value in values if value['deleted']])
        registry_root = subtree_root(tree, ref['prefix'])
    else:
        values = document['children']
        if document['entries'] or not 1 <= len(values) <= FANOUT: raise ValueError('invalid_recovery_page_branch')
        previous = None
        for value in values:
            reference(value)
            if (value['level'] >= ref['level'] or not value['prefix'].startswith(ref['prefix']) or
                    len(value['prefix']) <= len(ref['prefix']) or (previous is not None and previous >= value['first'])):
                raise ValueError('recovery_page_overlap_or_level')
            previous = value['last']
        first, last = values[0]['first'], values[-1]['last']
        count, deleted = sum(value['count'] for value in values), sum(value['deleted_count'] for value in values)
        if ref['level'] != 1 + max(value['level'] for value in values): raise ValueError('recovery_page_level_mismatch')
        registry_root = combine(values, ref['prefix'])
    if (first, last, count, deleted) != (ref['first'], ref['last'], ref['count'], ref['deleted_count']):
        raise ValueError('recovery_page_range_or_counter_mismatch')
    if registry_root != ref['registry_root']: raise ValueError('recovery_page_registry_root_mismatch')
    return document


def build_index(body, entries, members, seal, *, guild_id=None, public=False, closed=False, include_timeline=True):
    """Produce ciphertext pages before publishing the small signed v2 head.

    seal(canonical plaintext) returns (cluster digest, opaque ciphertext).
    Exact wire bytes/digests/sizes are retained for restartable publication.
    The caller must commit every block before broadcasting the head pointer.
    """
    ctx = context(body)
    entries = json.loads(canonical(list(entries)))
    if any(not isinstance(item, dict) or set(item) != ENTRY_FIELDS or type(item['deleted']) is not bool for item in entries):
        raise ValueError('invalid_recovery_page_entry')
    entries.sort(key=lambda item: item['message_id'])
    ids = [item['message_id'] for item in entries]
    if ids != sorted(set(ids)): raise ValueError('recovery_page_order_or_duplicate')
    if (len(entries), sum(item['deleted'] for item in entries)) != (body['count'], body['deleted_count']):
        raise ValueError('recovery_page_counter_mismatch')
    tree = RecoveryTree(ids, [item['message_id'] for item in entries if item['deleted']])
    if tree.root != body['root']: raise ValueError('recovery_page_registry_omission')
    blocks = {}
    def store(document):
        raw = canonical(document)
        if len(raw) > 97000: raise ValueError('recovery_page_plaintext_limit')
        cluster, ciphertext = seal(raw)
        if not digest64(cluster) or not isinstance(ciphertext, bytes): raise ValueError('invalid_recovery_page_seal')
        wire = canonical([ciphertext.hex()])
        if len(wire) > MAX_BLOCK: raise ValueError('recovery_page_block_limit')
        digest = sha256(wire).hexdigest()
        blocks[(cluster, digest)] = wire
        return {'cluster': cluster, 'digest': digest, 'size': len(wire)}
    def node(values):
        first, last = values[0]['message_id'], values[-1]['message_id']
        length = 128 - (identity(first) ^ identity(last)).bit_length()
        prefix = bits(first)[:length]
        children, leaf_entries = [], []
        if len(values) <= LEAF_SIZE:
            leaf_entries = values
            for value in values: entry(value)
            level = 0
        else:
            width = min(5, 128 - length, max(1, math.ceil(math.log2(len(values) / LEAF_SIZE))))
            groups = {}
            for value in values: groups.setdefault(bits(value['message_id'])[:length + width], []).append(value)
            if len(groups) < 2: raise ValueError('recovery_page_prefix_split')
            children = [node(group) for _, group in sorted(groups.items())]
            level = 1 + max(child['level'] for child in children)
        if level > MAX_DEPTH: raise ValueError('recovery_page_depth_limit')
        doc = {'domain': 'sfera-mesh-recovery-page-v2', 'context': page_context(ctx), 'level': level,
            'entries': leaf_entries, 'children': children}
        return {**store(doc), 'first': first, 'last': last, 'count': len(values),
            'deleted_count': sum(item['deleted'] for item in values), 'level': level,
            'prefix': prefix, 'registry_root': subtree_root(tree, prefix)}
    page = node(entries) if entries else None
    doc = {'domain': 'sfera-mesh-message-index-v2', 'context': ctx, 'members': sorted(members),
        'public': public, 'closed': closed, 'guild_id': guild_id, 'page': page}
    if type(include_timeline) is not bool: raise ValueError('invalid_recovery_timeline_option')
    if include_timeline:
        from .recovery_timeline import build as build_timeline
        doc['timeline'] = build_timeline(entries, ctx, store)
    validate_index(doc, body)
    return {'index': doc, 'reference': store(doc), 'blocks': blocks}


class PagedIndexReader:
    def __init__(self, document, body, user, fetch, unseal, *, byte_limit=4 * 1048576, deadline=None):
        identity(user)
        self.document = json.loads(canonical(validate_index(document, body)))
        if document['closed'] or (not document['public'] and user not in document['members']):
            raise PermissionError('recovery_page_access_denied')
        if type(byte_limit) is not int or not 1 <= byte_limit <= 4 * 1048576:
            raise ValueError('invalid_recovery_page_byte_limit')
        self.fetch, self.unseal, self.limit, self.used = fetch, unseal, byte_limit, 0
        self.deadline = self.bound_deadline(deadline)
        self.cache = {}
        self.validated_pages = {}

    @staticmethod
    def bound_deadline(deadline):
        if deadline is None: return time.monotonic() + 15
        if type(deadline) not in (int, float) or not math.isfinite(deadline): raise ValueError('invalid_recovery_page_deadline')
        return min(deadline, time.monotonic() + 15)

    @staticmethod
    def unpack(raw, ref, unseal):
        if not isinstance(raw, bytes) or len(raw) != ref['size'] or sha256(raw).hexdigest() != ref['digest']:
            raise ValueError('recovery_page_block_mismatch')
        wire = json.loads(raw)
        if not isinstance(wire, list) or len(wire) != 1 or not isinstance(wire[0], str) or canonical(wire) != raw:
            raise ValueError('recovery_page_wire_encoding')
        ciphertext = bytes.fromhex(wire[0])
        if ciphertext.hex() != wire[0]: raise ValueError('recovery_page_wire_encoding')
        plaintext = unseal(ciphertext)
        if len(plaintext) > 97000: raise ValueError('recovery_page_plaintext_limit')
        doc = json.loads(plaintext)
        if canonical(doc) != plaintext: raise ValueError('recovery_page_plaintext_encoding')
        return doc

    @classmethod
    def from_block(cls, body, user, fetch, unseal, **kwargs):
        if (not digest64(body.get('cluster')) or not digest64(body.get('digest')) or
                type(body.get('size')) is not int or not 1 <= body['size'] <= MAX_BLOCK or
                body['size'] > kwargs.get('byte_limit', 4 * 1048576)):
            raise ValueError('invalid_recovery_index_block')
        deadline = cls.bound_deadline(kwargs.get('deadline')); kwargs['deadline'] = deadline
        if time.monotonic() >= deadline: raise ValueError('recovery_page_deadline')
        raw = fetch(body['cluster'], body['digest'], body['size'])
        doc = cls.unpack(raw, body, unseal)
        reader = cls(doc, body, user, fetch, unseal, **kwargs)
        reader.used = len(raw)
        if time.monotonic() >= reader.deadline: raise ValueError('recovery_page_deadline')
        return reader

    def page(self, ref):
        reference(ref)
        doc = self.block(ref)  # Keep per-access deadline and exact-size checks.
        key = canonical({'reference': ref, 'context': self.document['context']})
        if key not in self.validated_pages:
            self.validated_pages[key] = validate_page(doc, ref, self.document['context'])
        return self.validated_pages[key]

    def block(self, ref):
        if (not isinstance(ref, dict) or not digest64(ref.get('cluster')) or not digest64(ref.get('digest')) or
                type(ref.get('size')) is not int or not 1 <= ref['size'] <= MAX_BLOCK):
            raise ValueError('invalid_recovery_page_block')
        key = (ref['cluster'], ref['digest'])
        if time.monotonic() >= self.deadline: raise ValueError('recovery_page_deadline')
        if key not in self.cache:
            if self.used + ref['size'] > self.limit: raise ValueError('recovery_page_read_limit')
            raw = self.fetch(ref['cluster'], ref['digest'], ref['size'])
            self.used += len(raw)
            self.cache[key] = (ref['size'], self.unpack(raw, ref, self.unseal))
        if self.cache[key][0] != ref['size']: raise ValueError('recovery_page_cached_size_mismatch')
        if time.monotonic() >= self.deadline: raise ValueError('recovery_page_deadline')
        return self.cache[key][1]

    def chronological(self, *, before=None, limit=32):
        from .recovery_timeline import read
        return read(self, before=before, limit=limit)

    def lookup(self, message):
        identity(message)
        ref = self.document['page']
        while ref is not None and ref['first'] <= message <= ref['last']:
            doc = self.page(ref)
            if ref['level'] == 0:
                return next((item for item in doc['entries'] if item['message_id'] == message), None)
            ref = next((child for child in doc['children'] if child['first'] <= message <= child['last']), None)
        return None

    def enumerate(self, *, before=None, limit=32):
        if before is not None: identity(before)
        if type(limit) is not int or not 1 <= limit <= 32: raise ValueError('invalid_recovery_page_limit')
        result = []
        def visit(ref):
            if len(result) >= limit or (before is not None and ref['first'] >= before): return
            doc = self.page(ref)
            if ref['level'] == 0:
                result.extend(item for item in reversed(doc['entries']) if before is None or item['message_id'] < before)
                del result[limit:]
            else:
                for child in reversed(doc['children']): visit(child)
        if self.document['page'] is not None: visit(self.document['page'])
        return result

    def deletions(self, *, before=None, limit=257):
        """Descending terminal UUIDs; authenticated counters skip live subtrees."""
        if before is not None: identity(before)
        if type(limit) is not int or not 1 <= limit <= 257: raise ValueError('invalid_recovery_deletion_limit')
        result = []
        def visit(ref):
            if not ref['deleted_count'] or len(result) >= limit or (before is not None and ref['first'] >= before): return
            doc = self.page(ref)
            if ref['level'] == 0:
                result.extend(item['message_id'] for item in reversed(doc['entries']) if item['deleted'] and
                    (before is None or item['message_id'] < before))
                del result[limit:]
            else:
                for child in reversed(doc['children']): visit(child)
        if self.document['page'] is not None: visit(self.document['page'])
        return result
