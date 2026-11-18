"""Immutable time/UUID radix pages referenced by the authenticated v2 index.

UUID membership/status remains authoritative in the existing sparse tree.
Selected time entries must resolve to matching live metadata in that tree.
"""
from datetime import datetime, timezone
import math
import re

from .directory import digest64
from .recovery_tree import identity
from .recovery_pages import page_context, MAX_BLOCK, FANOUT
from .storage import canonical

LEAF_SIZE, DEPTH = 32, 192
FIELDS = {'cluster', 'digest', 'size', 'first', 'last', 'count', 'level', 'prefix'}


def time_key(created_at, message):
    identity(message)
    try:
        stamp = datetime.fromisoformat(created_at) if isinstance(created_at, str) else None
        if stamp is None or stamp.utcoffset() is None: raise ValueError()
        delta = stamp.astimezone(timezone.utc) - datetime(1, 1, 1, tzinfo=timezone.utc)
        micros = (delta.days * 86400 + delta.seconds) * 1000000 + delta.microseconds
        if not 0 <= micros < 2**64: raise ValueError()
        return f'{micros:016x}' + message.replace('-', '')
    except (ValueError, OverflowError, TypeError) as exc:
        raise ValueError('invalid_recovery_timeline_time') from exc


def key(value):
    if not isinstance(value, str) or re.fullmatch('[0-9a-f]{48}', value) is None:
        raise ValueError('invalid_recovery_timeline_key')
    return value


def bits(value): return format(int(key(value), 16), '0192b')


def reference(value):
    if (not isinstance(value, dict) or set(value) != FIELDS or not digest64(value['cluster']) or not digest64(value['digest']) or
            type(value['size']) is not int or not 1 <= value['size'] <= MAX_BLOCK or type(value['count']) is not int or
            not 1 <= value['count'] <= 2**63 - 1 or type(value['level']) is not int or not 0 <= value['level'] <= DEPTH or
            not isinstance(value['prefix'], str) or len(value['prefix']) > DEPTH or set(value['prefix']) - {'0', '1'}):
        raise ValueError('invalid_recovery_timeline_reference')
    first, last = key(value['first']), key(value['last'])
    if (first > last or (value['level'] == 0 and value['count'] > LEAF_SIZE) or
            not bits(first).startswith(value['prefix']) or not bits(last).startswith(value['prefix']) or
            value['count'] > 2**(DEPTH - len(value['prefix']))):
        raise ValueError('invalid_recovery_timeline_range')
    return value


def validate_page(document, ref, expected_context):
    reference(ref)
    if (not isinstance(document, dict) or set(document) != {'domain', 'context', 'level', 'entries', 'children'} or
            document['domain'] != 'sfera-mesh-recovery-time-page-v2' or canonical(document['context']) != canonical(page_context(expected_context)) or
            type(document['level']) is not int or document['level'] != ref['level'] or
            not isinstance(document['entries'], list) or not isinstance(document['children'], list)):
        raise ValueError('invalid_recovery_timeline_page')
    if ref['level'] == 0:
        values = document['entries']
        if document['children'] or not 1 <= len(values) <= LEAF_SIZE: raise ValueError('invalid_recovery_timeline_leaf')
        for value in values:
            if (not isinstance(value, dict) or set(value) != {'message_id', 'created_at', 'key'} or
                    value['key'] != time_key(value['created_at'], value['message_id'])):
                raise ValueError('invalid_recovery_timeline_entry')
        keys = [value['key'] for value in values]
        if keys != sorted(set(keys)): raise ValueError('recovery_timeline_order_or_duplicate')
        first, last, count = keys[0], keys[-1], len(keys)
    else:
        values = document['children']
        if document['entries'] or not 2 <= len(values) <= FANOUT: raise ValueError('invalid_recovery_timeline_branch')
        previous = None
        for value in values:
            reference(value)
            if (value['level'] >= ref['level'] or not value['prefix'].startswith(ref['prefix']) or
                    len(value['prefix']) <= len(ref['prefix']) or (previous is not None and previous >= value['first'])):
                raise ValueError('recovery_timeline_overlap_or_level')
            previous = value['last']
        if ref['level'] != 1 + max(value['level'] for value in values): raise ValueError('recovery_timeline_level_mismatch')
        first, last, count = values[0]['first'], values[-1]['last'], sum(value['count'] for value in values)
    if (first, last, count) != (ref['first'], ref['last'], ref['count']): raise ValueError('recovery_timeline_counter_mismatch')
    return document


def build(entries, ctx, store):
    values = sorted(({'message_id': entry['message_id'], 'created_at': entry['created_at'],
        'key': time_key(entry['created_at'], entry['message_id'])} for entry in entries if not entry['deleted']), key=lambda value: value['key'])
    def node(items):
        first, last = items[0]['key'], items[-1]['key']
        length = DEPTH - (int(first, 16) ^ int(last, 16)).bit_length()
        prefix = bits(first)[:length]
        children, leaf = [], []
        if len(items) <= LEAF_SIZE:
            leaf, level = items, 0
        else:
            width = min(5, DEPTH - length, max(1, math.ceil(math.log2(len(items) / LEAF_SIZE))))
            groups = {}
            for item in items: groups.setdefault(bits(item['key'])[:length + width], []).append(item)
            if len(groups) < 2: raise ValueError('recovery_timeline_prefix_split')
            children = [node(group) for _, group in sorted(groups.items())]
            level = 1 + max(child['level'] for child in children)
        doc = {'domain': 'sfera-mesh-recovery-time-page-v2', 'context': page_context(ctx),
            'level': level, 'entries': leaf, 'children': children}
        return {**store(doc), 'first': first, 'last': last, 'count': len(items), 'prefix': prefix, 'level': level}
    return node(values) if values else None


def validate_complete(document, entries, load):
    """Publication/recovery must compare every time entry with the UUID index."""
    if 'timeline' not in document: return
    found = []
    def visit(ref):
        page = validate_page(load(ref), ref, document['context']); found.extend(page['entries'])
        for child in page['children']: visit(child)
    if document['timeline'] is not None: visit(document['timeline'])
    expected = sorted(({'message_id': entry['message_id'], 'created_at': entry['created_at'],
        'key': time_key(entry['created_at'], entry['message_id'])} for entry in entries if not entry['deleted']), key=lambda value: value['key'])
    if canonical(found) != canonical(expected): raise ValueError('recovery_timeline_omission_or_mismatch')


def read(reader, *, before=None, limit=32):
    if type(limit) is not int or not 1 <= limit <= 32: raise ValueError('invalid_recovery_timeline_limit')
    boundary = None
    if before is not None:
        value = reader.lookup(before)
        if value is None or value['deleted']: raise ValueError('recovery_timeline_cursor_unknown')
        boundary = time_key(value['created_at'], value['message_id'])
    result = []
    def visit(ref):
        if len(result) > limit or (boundary is not None and ref['first'] >= boundary): return
        page = validate_page(reader.block(ref), ref, reader.document['context'])
        if ref['level'] == 0:
            result.extend(item for item in reversed(page['entries']) if boundary is None or item['key'] < boundary)
            del result[limit + 1:]
        else:
            for child in reversed(page['children']): visit(child)
    if 'timeline' in reader.document:
        if reader.document['timeline'] is not None: visit(reader.document['timeline'])
    else:
        # Compatibility for already-prepared UUID-only generations. The entire
        # metadata tree must fit the usual deadline/budget; never sort a subset.
        def scan(ref):
            page = reader.page(ref)
            result.extend({'message_id': item['message_id'], 'created_at': item['created_at'],
                'key': time_key(item['created_at'], item['message_id'])} for item in page['entries'] if not item['deleted'])
            for child in page['children']: scan(child)
        if reader.document['page'] is not None: scan(reader.document['page'])
        result.sort(key=lambda item: item['key'], reverse=True)
        result = [item for item in result if boundary is None or item['key'] < boundary][:limit + 1]
    output = []
    for item in result:
        current = reader.lookup(item['message_id'])
        if (current is None or current['deleted'] or current['created_at'] != item['created_at'] or
                time_key(current['created_at'], current['message_id']) != item['key']):
            raise ValueError('recovery_timeline_uuid_mismatch')
        output.append({**current, 'order_key': item['key']})
    return output[:limit], output[limit - 1]['message_id'] if len(output) > limit else None
