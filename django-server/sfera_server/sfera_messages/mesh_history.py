"""Bounded, opt-in DM history read from authenticated mesh holders."""
from hashlib import sha256
import json
import sqlite3
import subprocess
import time
import uuid

from cryptography.fernet import InvalidToken
from django.conf import settings

from sfera_mesh.storage import canonical
from sfera_mesh.directory import digest64
from .encryption import decrypt_bytes, decrypt_text
from .mesh_attachments import chunk_id, CHUNK_BYTES, MAX_CHUNKS
from .mesh_read import fetch_ciphertext, read_config
from .mesh_rich import snapshot_fields
from .mesh_sources import source_name, scope_id, scope_field, source_model

PAGE_LIMIT = 32
BODY_BYTE_LIMIT = 4 * 1024 * 1024


def enabled():
    if not getattr(settings, 'SFERA_MESH_MESSAGE_HISTORY', False):
        return False
    from .mesh_delivery import enabled as delivery_enabled
    if not delivery_enabled() or not getattr(settings, 'SFERA_MESH_MESSAGE_READ_CONFIG', ''):
        raise ValueError('mesh_history_requires_delivery_and_reader')
    return True


def _uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except ValueError:
        return False


def _snapshot(write, data, message):
    raw = decrypt_bytes(data)
    body = json.loads(raw)
    identity = sha256(canonical({'domain': 'sfera-mesh-django-message-write-v1',
                                'message': str(message.pk), 'snapshot': sha256(raw).hexdigest()})).hexdigest()
    source = source_name(message)
    version, domain = (2, 'sfera-mesh-django-message-v2') if source == 'dm' else (3, 'sfera-mesh-django-guild-message-v1')
    extra = {'rich_state', 'mesh_history'} if source == 'dm' else {'rich_state', 'guild_id', 'tags', 'mesh_history'}
    if (write.source != source or write.format_version != version or not isinstance(body, dict) or canonical(body) != raw or
            set(body) - extra != {'domain', 'message_id', 'attachments', 'genesis', 'cluster', 'conversation_id', 'author_id',
                          'encrypted_content', 'encrypted_payload', 'message_type', 'edited', 'reply_to_id', 'created_at', 'live_until'} or
            write.message_id != message.pk or write.conversation_id != scope_id(message) or
            identity != write.pk or sha256(raw).hexdigest() != write.snapshot_hash or
            body.get('domain') != domain or body.get('message_id') != str(message.pk) or
            body.get('conversation_id') != str(scope_id(message)) or body.get('author_id') != str(message.author_id) or
            body.get('cluster') != write.cluster or body.get('genesis') != write.genesis or
            body.get('created_at') != message.created_at.isoformat() or type(body.get('edited')) is not bool or
            not isinstance(body.get('encrypted_content'), str) or not isinstance(body.get('encrypted_payload'), str) or
            (body.get('reply_to_id') is not None and not _uuid(body['reply_to_id']))):
        raise ValueError('message_mesh_history_snapshot_corrupt')
    if source == 'guild' and (body.get('guild_id') != str(message.channel.guild_id) or not isinstance(body.get('tags'), list) or len(body['tags']) > 32 or not all(isinstance(tag, str) and len(tag) <= 100 for tag in body['tags'])):
        raise ValueError('message_mesh_guild_context_corrupt')
    snapshot_fields(body)
    from .mesh_revisions import history_fields
    history_fields(body)
    return body


def _attachment_sizes(write, body):
    items = body.get('attachments')
    if not isinstance(items, list) or len(items) > 15:
        raise ValueError('message_mesh_history_files_corrupt')
    sizes, identities, count = {}, set(), 0
    for item in items:
        if (not isinstance(item, dict) or not _uuid(item.get('id')) or item['id'] in identities or
                not isinstance(item.get('filename'), str) or not isinstance(item.get('content_type'), str) or
                len(item['filename']) > 1024 or len(item['content_type']) > 1024 or
                type(item.get('file_size')) is not int or not 0 <= item['file_size'] <= MAX_CHUNKS * CHUNK_BYTES or
                not digest64(item.get('encrypted_digest')) or not isinstance(item.get('chunks'), list) or not item['chunks']):
            raise ValueError('message_mesh_history_files_corrupt')
        identities.add(item['id'])
        length = 0
        for part in item['chunks']:
            count += 1
            if (count > MAX_CHUNKS or not isinstance(part, dict) or set(part) != {'id', 'digest', 'size'} or
                    not digest64(part.get('digest')) or type(part.get('size')) is not int or not 1 <= part['size'] <= CHUNK_BYTES or
                    part.get('id') != chunk_id(write.genesis, write.cluster, part['digest'])):
                raise ValueError('message_mesh_history_files_corrupt')
            length += part['size']
            size = 2 * part['size'] + 4
            if sizes.setdefault(part['digest'], size) != size:
                raise ValueError('message_mesh_history_files_corrupt')
        if item.get('encrypted_size') != length:
            raise ValueError('message_mesh_history_files_corrupt')
    return sizes


def read_messages(writer, messages, user_id, *, pinned_ids=(), context=None, snapshots=None):
    """The application DB supplies IDs/ACL; encrypted message bodies come from holders."""
    from .models import Message, MessageMeshWrite
    from sfera_auth.serializers import UserSerializer
    if not isinstance(messages, (list, tuple)) or len(messages) > PAGE_LIMIT:
        raise ValueError('message_mesh_history_page_limit')
    if not messages:
        return []
    using = messages[0]._state.db
    source = source_name(messages[0])
    model, scope = source_model(source), scope_field(source)
    if any(message._state.db != using or source_name(message) != source for message in messages):
        raise ValueError('message_mesh_history_database_changed')
    deadline = time.monotonic() + 15
    records, bodies, pending, sizes, transferred = {}, {}, set(), {}, 0

    def load(values):
        nonlocal transferred
        writes = {row.pk: row for row in MessageMeshWrite.objects.using(using).filter(pk__in=[message.mesh_write_id for message in values])}
        expected = {}
        for message in values:
            write = writes.get(message.mesh_write_id)
            if write is None or write.genesis != writer.publication.directory.pin:
                raise ValueError('message_mesh_history_snapshot_required')
            data = bytes(write.ciphertext)
            if not 1 <= len(data) <= 131000:
                raise ValueError('message_mesh_history_snapshot_corrupt')
            size, digest = len(canonical([data.hex()])), sha256(canonical([data.hex()])).hexdigest()
            transferred += size
            if transferred > BODY_BYTE_LIMIT:
                raise ValueError('message_mesh_history_byte_limit')
            local_pending = write.state == 'pending' and str(message.author_id) == str(user_id)
            if write.state != 'confirmed' and not local_pending:
                raise ValueError('message_mesh_history_unconfirmed')
            records[message.pk] = (message, write, digest, size)
            if local_pending:
                pending.add(message.pk)
                bodies[message.pk] = _snapshot(write, data, message)
            else:
                expected.setdefault(write.cluster, {})[digest] = size
        if expected:
            writer.confirm_clusters(expected)
        writer.publication.journal.refresh_discovery()
        for message in values:
            _, write, digest, size = records[message.pk]
            if message.pk not in pending:
                bodies[message.pk] = _snapshot(write, fetch_ciphertext(writer, write.cluster, digest, size, deadline), message)
            parts = _attachment_sizes(write, bodies[message.pk])
            if message.pk not in pending:
                entries = sizes.setdefault(write.cluster, {})
                for identity, length in {digest: size, **parts}.items():
                    if entries.setdefault(identity, length) != length or len(entries) > 512:
                        raise ValueError('message_mesh_history_index_limit')

    load(messages)
    # Only one level of previews. A preview must have its own complete proof;
    # no unverified local reply text is substituted for an unavailable target.
    reply_ids = {body['reply_to_id'] for body in bodies.values() if body['reply_to_id']}
    reply_ids -= {str(identity) for identity in records}
    # Unconfirmed targets remain hidden even from the author in a shared preview.
    confirmed_ids = MessageMeshWrite.objects.using(using).filter(state='confirmed').values('pk')
    replies = list(model.objects.using(using).filter(pk__in=reply_ids, mesh_write_id__in=confirmed_ids,
        **{scope + '__in': {scope_id(message) for message in messages}}).select_related('author', *(['channel'] if source == 'guild' else [])))
    load(replies)
    if sizes:
        writer.confirm_clusters(sizes)
    if time.monotonic() >= deadline:
        raise ValueError('message_mesh_history_deadline')
    writer.publication.directory.anchor()
    current = {row[0]: row[1:] for row in model.objects.using(using).filter(pk__in=records).values_list(
        'pk', 'mesh_write_id', scope, 'author_id', 'created_at')}
    if current != {identity: (record[1].pk, scope_id(record[0]), record[0].author_id, record[0].created_at)
                   for identity, record in records.items()}:
        raise ValueError('message_mesh_history_changed_during_read')
    by_id = {str(identity): identity for identity in records}
    if snapshots is not None:
        snapshots.update({str(message.pk): bodies[message.pk] for message in messages})

    def present(message):
        body = bodies[message.pk]
        reply = None
        target_id = by_id.get(body['reply_to_id'])
        if target_id is not None and target_id not in pending:
            target = records[target_id][0]
            if scope_id(target) != scope_id(message):
                raise ValueError('message_mesh_history_reply_context_changed')
            reply = {'id': str(target.pk), 'author': UserSerializer(target.author, context=context or {}).data,
                     'content': decrypt_text(bodies[target_id]['encrypted_content'])[:200]}
        return {'id': str(message.pk), 'conversation_id': str(scope_id(message)),
                **({'guild_id': body['guild_id'], 'channel_id': body['conversation_id'], 'tags': body['tags']} if source == 'guild' else {}),
                'author': UserSerializer(message.author, context=context or {}).data,
                'content': decrypt_text(body['encrypted_content']), 'created_at': body['created_at'],
                'edited': body['edited'], 'reply_to': reply, 'is_pinned': message.is_pinned if source == 'guild' else message.pk in pinned_ids,
                'attachments': [{'id': item['id'], 'filename': item['filename'], 'content_type': item['content_type'],
                                 'file_size': item['file_size'], 'url': ('/api/guild-attachments/' if source == 'guild' else '/api/attachments/') + item['id'] + '/'} for item in body['attachments']],
                **snapshot_fields(body, user_id),
                'delivered_at': message.delivered_at.isoformat() if message.pk not in pending and getattr(message, 'delivered_at', None) else None,
                'read_at': message.read_at.isoformat() if message.pk not in pending and getattr(message, 'read_at', None) else None,
                'publication_state': 'pending' if message.pk in pending else 'confirmed',
                'consensus_committed': message.pk not in pending, 'mesh_write_id': records[message.pk][1].pk}
    return [present(message) for message in messages]


def recover_messages(messages, user_id, *, pinned_ids=(), context=None, snapshots=None):
    from .mesh_reader import open_reader
    from .models import MessageMeshWrite
    if not messages:
        return []
    clusters = set(MessageMeshWrite.objects.using(messages[0]._state.db).filter(
        pk__in=[message.mesh_write_id for message in messages]).values_list('cluster', flat=True))
    try:
        with open_reader(read_config(), clusters=clusters) as writer:
            return read_messages(writer, messages, user_id, pinned_ids=pinned_ids, context=context, snapshots=snapshots)
    except (sqlite3.Error, subprocess.SubprocessError, InvalidToken, UnicodeError) as exc:
        raise ValueError('message_mesh_history_unavailable') from exc
