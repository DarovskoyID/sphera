"""Opt-in recovery ancestry and terminal deletion snapshots.

The content index alone is unordered. Never infer a current revision from its
timestamp, numeric revision or lexicographic digest in a forked graph.
"""
from hashlib import sha256
import json

from django.conf import settings
from django.utils import timezone
from cryptography.fernet import InvalidToken

from sfera_mesh.directory import digest64
from sfera_mesh.storage import canonical
from .encryption import decrypt_bytes, encrypt_bytes

TOMBSTONE = 'sfera-mesh-django-message-tombstone-v1'
PARENT_LIMIT = 128


def enabled():
    active = bool(getattr(settings, 'SFERA_MESH_MESSAGE_RECOVERY', False))
    if active:
        from .mesh_delivery import enabled as delivery_enabled
        if not delivery_enabled():
            raise ValueError('mesh_recovery_requires_delivery')
    return active


def history_fields(body):
    history = body.get('mesh_history')
    if history is None:
        return None
    if (not isinstance(history, dict) or set(history) != {'revision', 'parents'} or
            not isinstance(history['parents'], list) or len(history['parents']) > PARENT_LIMIT or
            any(not digest64(parent) for parent in history['parents']) or
            history['parents'] != sorted(set(history['parents'])) or
            type(history['revision']) is not int or history['revision'] != len(history['parents']) + 1):
        raise ValueError('message_mesh_revision_ancestry_corrupt')
    if sha256(canonical(body)).hexdigest() in history['parents']:
        raise ValueError('message_mesh_revision_self_reference')
    return history


def prepare_snapshot(message, body, writes):
    if writes.filter(message_id=message.pk, source=body_source(body), format_version=4).exists():
        raise ValueError('message_mesh_deleted_identity_is_terminal')
    rows = writes.filter(message_id=message.pk, source=body_source(body))
    current = rows.filter(pk=message.mesh_write_id).first() if message.mesh_write_id else None
    if current is not None:
        try:
            raw = decrypt_bytes(bytes(current.ciphertext))
            old = json.loads(raw)
            if not isinstance(old, dict) or canonical(old) != raw or sha256(raw).hexdigest() != current.snapshot_hash:
                raise ValueError('message_mesh_revision_cache_corrupt')
            if history_fields(old) is not None and {key: value for key, value in old.items() if key != 'mesh_history'} == body:
                return old
        except (TypeError, KeyError, InvalidToken) as exc:
            raise ValueError('message_mesh_revision_cache_corrupt') from exc
    parents = list(rows.order_by('snapshot_hash').values_list('snapshot_hash', flat=True)[:PARENT_LIMIT + 1])
    # Reserve one final slot so reaching the edit bound never prevents a
    # terminal deletion of a message created under this recovery contract.
    if len(parents) >= PARENT_LIMIT:
        raise ValueError('message_mesh_recovery_revision_limit')
    return {**body, 'mesh_history': {'revision': len(parents) + 1, 'parents': parents}}


def body_source(body):
    return 'guild' if body.get('domain') == 'sfera-mesh-django-guild-message-v1' else 'dm'


def capture_tombstone(message, using):
    if not enabled():
        return None
    from .models import MessageMeshWrite
    from .mesh_sources import source_name, scope_id
    from .mesh_publication import enabled as publication_enabled, require_durable_database
    if not publication_enabled():
        raise ValueError('mesh_recovery_requires_capture')
    require_durable_database(using)
    source = source_name(message)
    writes = MessageMeshWrite.objects.using(using)
    rows = writes.filter(message_id=message.pk, source=source)
    old = rows.filter(format_version=4).first()
    if old is not None:
        return old
    if rows.exclude(genesis=settings.SFERA_MESH_MESSAGE_GENESIS, cluster=settings.SFERA_MESH_MESSAGE_CLUSTER).exists():
        raise ValueError('message_mesh_recovery_trust_changed')
    parents = list(rows.order_by('snapshot_hash').values_list('snapshot_hash', flat=True)[:PARENT_LIMIT + 1])
    if len(parents) > PARENT_LIMIT or writes.filter(state='pending').count() >= 4096:
        raise ValueError('message_mesh_recovery_queue_limit')
    body = {'domain': TOMBSTONE, 'source': source, 'message_id': str(message.pk),
        'conversation_id': str(scope_id(message)), 'author_id': str(message.author_id),
        'genesis': settings.SFERA_MESH_MESSAGE_GENESIS, 'cluster': settings.SFERA_MESH_MESSAGE_CLUSTER,
        'deleted_at': timezone.now().isoformat(), 'attachments': [],
        'mesh_history': {'revision': len(parents) + 1, 'parents': parents}}
    raw = canonical(body)
    digest = sha256(raw).hexdigest()
    identity = sha256(canonical({'domain': 'sfera-mesh-django-message-write-v1',
        'message': str(message.pk), 'snapshot': digest})).hexdigest()
    write = writes.create(id=identity, source=source, message_id=message.pk, conversation_id=scope_id(message),
        cluster=body['cluster'], genesis=body['genesis'], snapshot_hash=digest,
        ciphertext=encrypt_bytes(raw), format_version=4)
    from .mesh_delivery import enqueue
    enqueue(message, write, using)
    return write


def validate_tombstone(body, genesis, cluster):
    from .mesh_history import _uuid
    from django.utils.dateparse import parse_datetime
    if (not isinstance(body, dict) or set(body) != {'domain', 'source', 'message_id', 'conversation_id',
            'author_id', 'genesis', 'cluster', 'deleted_at', 'attachments', 'mesh_history'} or
            body['domain'] != TOMBSTONE or body['source'] not in ('dm', 'guild') or
            (body['genesis'], body['cluster']) != (genesis, cluster) or body['attachments'] != [] or
            not all(_uuid(body[field]) for field in ('message_id', 'conversation_id', 'author_id')) or
            not isinstance(body['deleted_at'], str) or history_fields(body) is None):
        raise ValueError('message_mesh_tombstone_corrupt')
    deleted = parse_datetime(body['deleted_at'])
    if deleted is None or deleted.utcoffset() is None:
        raise ValueError('message_mesh_tombstone_time_corrupt')


def resolve_candidates(revisions, source, scope):
    """Resolve a complete *verified input set*; this helper does not prove completeness."""
    if source not in ('dm', 'guild') or not isinstance(revisions, list) or len(revisions) > 512:
        raise ValueError('invalid_mesh_revision_candidates')
    groups = {}
    for item in revisions:
        if item['source'] == source:
            groups.setdefault(item['message_id'], []).append(item)
    live, deleted, conflicts = [], [], []
    for identity, rows in groups.items():
        if not any(row['scope_id'] == scope for row in rows):
            continue
        hashes = {row['snapshot_hash'] for row in rows}
        if len(hashes) != len(rows) or {row['scope_id'] for row in rows} != {scope}:
            conflicts.append(identity); continue
        parents = {parent for row in rows for parent in (row.get('history') or {}).get('parents', [])}
        heads = [row for row in rows if row['snapshot_hash'] not in parents]
        if len(heads) != 1 or heads[0].get('history') is None:
            conflicts.append(identity); continue
        head = heads[0]
        if any(row.get('deleted') for row in rows) and not head.get('deleted'):
            conflicts.append(identity); continue
        if not (hashes - {head['snapshot_hash']}).issubset(head['history']['parents']):
            conflicts.append(identity); continue
        (deleted if head.get('deleted') else live).append(head)
    return {'live_candidates': live, 'deleted_candidates': deleted, 'conflicts': sorted(conflicts),
            'inventory_completeness_verified': False}
