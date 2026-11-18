"""Explicit laboratory outbox for message snapshots and encrypted file parts.

Capture itself is not a consensus receipt; the delivery worker verifies the
body and every attachment part before issuing a confirmed event.
"""
from hashlib import sha256
import json

from django.conf import settings
from django.db import connections
from django.utils import timezone

from sfera_mesh.directory import digest64
from sfera_mesh.storage import canonical
from .encryption import encrypt_bytes, decrypt_bytes

CONTENT_FIELDS = frozenset({'encrypted_content', 'encrypted_payload', 'message_type', 'live_until',
                            'reply_to', 'reply_to_id', 'author', 'author_id', 'conversation', 'conversation_id', 'created_at', 'edited'})


def enabled():
    cluster = getattr(settings, 'SFERA_MESH_MESSAGE_CLUSTER', '')
    if cluster and (not digest64(cluster) or not digest64(getattr(settings, 'SFERA_MESH_MESSAGE_GENESIS', ''))):
        raise ValueError('invalid_message_mesh_cluster')
    return bool(cluster)


def require_durable_database(using):
    db = connections[using]
    if db.vendor == 'sqlite':
        with db.cursor() as cursor:
            cursor.execute('PRAGMA synchronous')
            if cursor.fetchone()[0] != 2:
                raise ValueError('mesh_message_database_requires_synchronous_full')


def capture(message, using):
    from .models import MessageMeshWrite
    from .mesh_attachments import capture_attachments, persist_chunks
    attachments, chunks = capture_attachments(message, using, settings.SFERA_MESH_MESSAGE_GENESIS, settings.SFERA_MESH_MESSAGE_CLUSTER)
    from .mesh_sources import source_name, scope_id
    source = source_name(message)
    version = 2 if source == 'dm' else 3
    snapshot = {'domain': 'sfera-mesh-django-message-v2' if source == 'dm' else 'sfera-mesh-django-guild-message-v1', 'message_id': str(message.pk), 'attachments': attachments,
                'genesis': settings.SFERA_MESH_MESSAGE_GENESIS, 'cluster': settings.SFERA_MESH_MESSAGE_CLUSTER,
                'conversation_id': str(scope_id(message)), 'author_id': str(message.author_id),
                'encrypted_content': message.encrypted_content, 'encrypted_payload': message.encrypted_payload,
                'message_type': message.message_type, 'edited': message.edited,
                'reply_to_id': str(message.reply_to_id) if message.reply_to_id else None,
                'created_at': message.created_at.isoformat(),
                'live_until': message.live_until.isoformat() if message.live_until else None}
    if source == 'guild':
        snapshot.update(guild_id=str(message.channel.guild_id), tags=message.tags)
    from .mesh_rich import capture_state
    rich_state = capture_state(message)
    if rich_state is not None:
        snapshot['rich_state'] = rich_state
    writes = MessageMeshWrite.objects.using(using)
    if writes.filter(message_id=message.pk, source=source, format_version=4).exists():
        raise ValueError('message_mesh_deleted_identity_is_terminal')
    if writes.filter(message_id=message.pk, source=source).exclude(cluster=settings.SFERA_MESH_MESSAGE_CLUSTER,
                                                   genesis=settings.SFERA_MESH_MESSAGE_GENESIS).exists():
        raise ValueError('message_mesh_trust_changed')
    from .mesh_revisions import enabled as recovery_enabled, prepare_snapshot
    if recovery_enabled():
        snapshot = prepare_snapshot(message, snapshot, writes)
    raw = canonical(snapshot)
    digest = sha256(raw).hexdigest()
    old = writes.filter(message_id=message.pk, source=source, snapshot_hash=digest).first()
    if old is not None:
        if old.cluster != settings.SFERA_MESH_MESSAGE_CLUSTER:
            raise ValueError('message_mesh_cluster_changed')
        if old.state == 'cancelled':
            raise ValueError('message_mesh_cancelled_identity')
        if old.state == 'superseded':
            if writes.filter(state='pending').count() >= 4096:
                raise ValueError('message_mesh_pending_limit')
            writes.filter(pk=old.pk, state='superseded').update(state='pending')
            old.state = 'pending'
        return old
    if writes.filter(state='pending').count() >= 4096:
        raise ValueError('message_mesh_pending_limit')
    encrypted = encrypt_bytes(raw)
    if len(encrypted) > 131000:
        raise ValueError('message_mesh_body_too_large')
    identity = sha256(canonical({'domain': 'sfera-mesh-django-message-write-v1', 'message': str(message.pk), 'snapshot': digest})).hexdigest()
    persist_chunks(chunks, using, settings.SFERA_MESH_MESSAGE_GENESIS, settings.SFERA_MESH_MESSAGE_CLUSTER)
    write = writes.create(id=identity, source=source, message_id=message.pk, conversation_id=scope_id(message),
                          cluster=settings.SFERA_MESH_MESSAGE_CLUSTER, genesis=settings.SFERA_MESH_MESSAGE_GENESIS,
                          snapshot_hash=digest, ciphertext=encrypted, format_version=version)
    write.chunks.add(*chunks.keys())
    return write


def publish_batch(writer, *, using='default', limit=32):
    """A real StoragePublication instance supplies replication and BFT checks.

    Idempotent IDs bridge two databases: a crash before/after append or after
    consensus confirmation can repeat safely. No pending row is marked confirmed
    from a submit response or an old local publication flag.
    """
    from .models import MessageMeshWrite, Message, MessageMeshChunk
    from .mesh_attachments import verify_chunks
    if type(limit) is not int or not 1 <= limit <= 64:
        raise ValueError('invalid_message_mesh_batch')
    rows = list(MessageMeshWrite.objects.using(using).filter(state='pending').order_by('created_at', 'id')[:limit])
    staged, jobs, chunk_rows = [], {}, {}
    for row in rows:
        from .mesh_sources import source_current
        current = source_current(row).values_list('mesh_write_id', flat=True).first()
        if row.format_version == 4:
            if current is not None:
                raise ValueError('mesh_tombstone_source_still_exists')
        elif current is None:
            MessageMeshWrite.objects.using(using).filter(pk=row.pk, state='pending').update(state='cancelled')
            continue
        if row.format_version != 4 and current != row.pk:
            MessageMeshWrite.objects.using(using).filter(pk=row.pk, state='pending').update(state='superseded')
            continue
        data = bytes(row.ciphertext)
        raw = decrypt_bytes(data)
        snapshot = json.loads(raw)
        identity = sha256(canonical({'domain': 'sfera-mesh-django-message-write-v1', 'message': str(row.message_id), 'snapshot': row.snapshot_hash})).hexdigest()
        if (sha256(raw).hexdigest() != row.snapshot_hash or canonical(snapshot) != raw or
                snapshot.get('domain') != {1: 'sfera-mesh-django-message-body-v1', 2: 'sfera-mesh-django-message-v2', 3: 'sfera-mesh-django-guild-message-v1', 4: 'sfera-mesh-django-message-tombstone-v1'}.get(row.format_version) or
                snapshot.get('message_id') != str(row.message_id) or
                snapshot.get('conversation_id') != str(row.conversation_id) or row.pk != identity or
                snapshot.get('genesis') != row.genesis or snapshot.get('cluster') != row.cluster):
            raise ValueError('message_mesh_snapshot_corrupt')
        from .mesh_revisions import history_fields
        history_fields(snapshot)
        if row.format_version == 4 and (snapshot.get('source') != row.source or snapshot.get('attachments') != [] or snapshot.get('mesh_history') is None):
            raise ValueError('message_mesh_tombstone_corrupt')
        if row.format_version == 4:
            from .mesh_revisions import validate_tombstone
            validate_tombstone(snapshot, row.genesis, row.cluster)
        if writer.publication.directory.pin != row.genesis:
            raise ValueError('message_mesh_publication_genesis_changed')
        parts = verify_chunks(snapshot, row, using)
        if len(set(jobs) | set(parts) | {row.pk}) > 512:
            break
        for identity, part in parts.items():
            jobs[identity] = ('mesh-attachments:' + row.genesis + ':' + row.cluster, row.cluster, bytes(part.ciphertext))
            chunk_rows[identity] = part
        jobs[row.pk] = (str(row.conversation_id), row.cluster, data)
        staged.append(row)
    rows = staged
    if not jobs:
        return {'pending_observed': 0, 'confirmed': 0}

    def checked(identity, receipt):
        if not receipt or receipt.get('consensus_committed') is not True:
            return False
        _, cluster, data = jobs[identity]
        if (receipt.get('block_id') != identity or receipt.get('cluster') != cluster or
                receipt.get('digest') != sha256(canonical([data.hex()])).hexdigest() or
                not digest64(receipt.get('manifest_hash')) or type(receipt.get('manifest_version')) is not int or
                receipt['manifest_version'] < 1 or not isinstance(receipt.get('finality'), dict)):
            raise ValueError('message_mesh_receipt_mismatch')
        return True

    known = writer.status_many(list(jobs))
    # Parts first, then bodies. A bounded call makes progress even when a file
    # spans more blocks than the per-call replication limit.
    pending = [identity for identity in sorted(jobs, key=lambda item: (item not in chunk_rows, item))
               if not checked(identity, known.get(identity))]
    for identity in pending[:limit]:
        dialog, cluster, data = jobs[identity]
        writer.append(dialog, identity, cluster, [data])
    for cluster in sorted({job[1] for job in jobs.values()}):
        writer.step(cluster, limit=limit)
    observed = writer.status_many(list(jobs))
    confirmed = {identity for identity in jobs if checked(identity, observed.get(identity))}
    for identity in confirmed.intersection(chunk_rows):
        MessageMeshChunk.objects.using(using).filter(pk=identity).update(state='confirmed', receipt=observed[identity])
    count = 0
    for row in rows:
        if row.pk not in confirmed or any(part.pk not in confirmed for part in row.chunks.using(using).all()):
            continue
        receipt = {**observed[row.pk], 'scope': 'message_tombstone' if row.format_version == 4 else ('message' if row.format_version in (2, 3) else 'message_body'),
                   'chunks': {part.pk: observed[part.pk] for part in row.chunks.using(using).all()}}
        count += MessageMeshWrite.objects.using(using).filter(pk=row.pk, state='pending').update(
            state='confirmed', receipt=receipt, confirmed_at=timezone.now())
    return {'pending_observed': len(rows), 'confirmed': count}
