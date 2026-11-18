"""Typed recovery reads without source Message, Conversation or outbox rows.

The publisher and its namespace must be independently pinned. Current ACLs in
this encrypted index authorize this path; it does not restore account logins.
"""
from hashlib import sha256
import json
import time
from types import SimpleNamespace
import uuid

from django.utils.dateparse import parse_datetime

from sfera_mesh.directory import digest64
from sfera_mesh.manifest_reads import verified_manifests
from sfera_mesh.recovery_roots import current_root, namespace
from sfera_mesh.storage import canonical
from .encryption import decrypt_bytes, decrypt_text
from .mesh_history import _uuid, _snapshot, _attachment_sizes, BODY_BYTE_LIMIT, PAGE_LIMIT
from .mesh_read import fetch_ciphertext
from .mesh_rich import snapshot_fields
from .mesh_revisions import validate_tombstone

DOMAIN = 'sfera-mesh-message-index-v1'
ENTRY_FIELDS = {'message_id', 'author_id', 'created_at', 'snapshot_hash', 'digest', 'size', 'deleted'}


def validate_document(document, root):
    fields = {'domain', 'genesis', 'publisher', 'source', 'scope', 'cluster', 'generation',
        'previous', 'members', 'closed', 'public', 'guild_id', 'entries'}
    if (not isinstance(document, dict) or set(document) != fields or document['domain'] != DOMAIN or
            any(document[field] != root[field] for field in ('genesis', 'publisher', 'source', 'scope', 'cluster', 'previous')) or
            type(document['generation']) is not int or document['generation'] != root['version'] or
            type(document['closed']) is not bool or type(document['public']) is not bool or
            (document['closed'] and (document['public'] or document['members'])) or
            (document['source'] == 'dm' and (document['public'] or document['guild_id'] is not None)) or
            (document['source'] == 'guild' and not _uuid(document['guild_id'])) or
            not isinstance(document['members'], list) or len(document['members']) > 64 or
            any(not _uuid(member) for member in document['members']) or document['members'] != sorted(set(document['members'])) or
            (not document['closed'] and not document['public'] and not document['members']) or
            not isinstance(document['entries'], list) or len(document['entries']) > 256):
        raise ValueError('message_mesh_recovery_index_corrupt')
    identities, deleted, sizes = [], [], {}
    for entry in document['entries']:
        if (not isinstance(entry, dict) or set(entry) != ENTRY_FIELDS or
                not all(_uuid(entry[field]) for field in ('message_id', 'author_id')) or
                not all(digest64(entry[field]) for field in ('snapshot_hash', 'digest')) or
                type(entry['size']) is not int or not 1 <= entry['size'] <= 262144 or type(entry['deleted']) is not bool):
            raise ValueError('message_mesh_recovery_entry_corrupt')
        if entry['created_at'] is None:
            if not entry['deleted']:
                raise ValueError('message_mesh_recovery_entry_time')
        else:
            timestamp = parse_datetime(entry['created_at']) if isinstance(entry['created_at'], str) else None
            if timestamp is None or timestamp.utcoffset() is None:
                raise ValueError('message_mesh_recovery_entry_time')
        identities.append(entry['message_id'])
        if entry['digest'] in sizes and sizes[entry['digest']] != entry['size']:
            raise ValueError('message_mesh_recovery_entry_size_conflict')
        sizes[entry['digest']] = entry['size']
        if entry['deleted']:
            deleted.append(entry['message_id'])
    if identities != root['messages'] or identities != sorted(set(identities)) or deleted != root['deleted']:
        raise ValueError('message_mesh_recovery_index_omission_or_resurrection')
    return document


def index_document(root, members, entries, *, guild_id=None, closed=False, public=False):
    document = {'domain': DOMAIN, **{field: root[field] for field in ('genesis', 'publisher', 'source', 'scope', 'cluster', 'previous')},
        'generation': root['version'], 'members': sorted(members), 'closed': closed, 'public': public,
        'guild_id': guild_id, 'entries': sorted(json.loads(canonical(entries)), key=lambda entry: entry['message_id'])}
    return validate_document(document, root)


def _index(writer, publisher, source, scope, user_id, expected_root, deadline, authorize=None):
    namespace(publisher, source, scope)
    if not _uuid(str(user_id)) or (expected_root is not None and not digest64(expected_root)):
        raise ValueError('invalid_message_mesh_recovery_query')
    directory = writer.publication.directory
    if hasattr(writer, 'refresh'):
        writer.refresh()
    else:
        directory.refresh(writer.publication.address)
    head = current_root(directory, publisher, source, scope)
    if expected_root is not None and head['digest'] != expected_root:
        raise ValueError('message_mesh_recovery_root_changed')
    root = head['record']['body']
    if (root['publisher'], root['source'], root['scope'], root['genesis']) != (publisher, source, scope, directory.pin):
        raise ValueError('message_mesh_recovery_namespace_changed')
    _, known = verified_manifests(directory)
    sizes = known.get(root['cluster'], {}).get('sizes', {})
    if sizes.get(root['digest']) != root['size']:
        raise ValueError('message_mesh_recovery_root_uncommitted')
    writer.publication.journal.refresh_discovery()
    data = fetch_ciphertext(writer, root['cluster'], root['digest'], root['size'], deadline)
    raw = decrypt_bytes(data)
    document = json.loads(raw)
    if canonical(document) != raw:
        raise ValueError('message_mesh_recovery_index_encoding')
    validate_document(document, root)
    if document['closed'] or (not document['public'] and str(user_id) not in document['members']):
        raise PermissionError('message_mesh_recovery_read_forbidden')
    if authorize is not None:
        authorize(document)
    if any(sizes.get(entry['digest']) != entry['size'] for entry in document['entries']):
        raise ValueError('message_mesh_recovery_entries_uncommitted')
    return head, document, sizes


def _decode_entry(root, document, entry, data, sizes):
    raw = decrypt_bytes(data); body = json.loads(raw)
    identity, source, scope = entry['message_id'], root['source'], root['scope']
    if not isinstance(body, dict) or canonical(body) != raw or sha256(raw).hexdigest() != entry['snapshot_hash']:
        raise ValueError('message_mesh_recovery_snapshot_corrupt')
    if entry['deleted']:
        validate_tombstone(body, root['genesis'], root['cluster'])
        if (body['source'], body['conversation_id'], body['message_id'], body['author_id']) != (source, scope, identity, entry['author_id']):
            raise ValueError('message_mesh_recovery_tombstone_context')
    else:
        message = SimpleNamespace(pk=uuid.UUID(identity), author_id=uuid.UUID(entry['author_id']),
            created_at=parse_datetime(entry['created_at']), conversation_id=uuid.UUID(scope), channel_id=uuid.UUID(scope),
            channel=SimpleNamespace(guild_id=document['guild_id']),
            _meta=SimpleNamespace(label_lower='sfera_messages.message' if source == 'dm' else 'sfera_servers.guildmessage'))
        write = SimpleNamespace(pk=sha256(canonical({'domain': 'sfera-mesh-django-message-write-v1',
            'message': identity, 'snapshot': entry['snapshot_hash']})).hexdigest(), source=source, format_version=2 if source == 'dm' else 3,
            message_id=message.pk, conversation_id=uuid.UUID(scope), genesis=root['genesis'], cluster=root['cluster'], snapshot_hash=entry['snapshot_hash'])
        body = _snapshot(write, data, message)
        if any(sizes.get(digest) != size for digest, size in _attachment_sizes(write, body).items()):
            raise ValueError('message_mesh_recovery_files_uncommitted')
    return body


def read_index_attachment(writer, publisher, source, scope, user_id, message_id, attachment_id, *, expected_root=None, authorize=None):
    """Recover a file with the same typed index ACL, without Attachment rows."""
    if not _uuid(message_id) or not _uuid(attachment_id):
        raise ValueError('invalid_message_mesh_recovery_attachment')
    deadline = time.monotonic() + 15
    head, document, sizes = _index(writer, publisher, source, scope, user_id, expected_root, deadline, authorize)
    root = head['record']['body']
    entry = next((row for row in document['entries'] if row['message_id'] == message_id), None)
    if entry is None or entry['deleted']:
        raise PermissionError('message_mesh_recovery_attachment_deleted_or_missing')
    data = fetch_ciphertext(writer, root['cluster'], entry['digest'], entry['size'], deadline)
    body = _decode_entry(root, document, entry, data, sizes)
    item = next((row for row in body['attachments'] if row['id'] == attachment_id), None)
    if item is None:
        raise PermissionError('message_mesh_recovery_attachment_wrong_message')
    chunks = [fetch_ciphertext(writer, root['cluster'], part['digest'], sizes[part['digest']], deadline) for part in item['chunks']]
    encrypted = b''.join(chunks)
    if len(encrypted) != item['encrypted_size'] or sha256(encrypted).hexdigest() != item['encrypted_digest']:
        raise ValueError('message_mesh_recovery_attachment_corrupt')
    plaintext = decrypt_bytes(encrypted)
    if len(plaintext) != item['file_size']:
        raise ValueError('message_mesh_recovery_attachment_size_changed')
    latest = current_root(writer.publication.directory, publisher, source, scope)
    if latest['digest'] != head['digest'] or time.monotonic() >= deadline:
        raise ValueError('message_mesh_recovery_root_changed_during_read')
    if authorize is not None:
        authorize(document)
    return {'content': plaintext, 'filename': item['filename'], 'content_type': item['content_type'],
        'file_size': len(plaintext), 'root_hash': head['digest'], 'generation': root['version'], 'finality': latest['finality']}


def read_index_messages(writer, publisher, source, scope, user_id, *, limit=PAGE_LIMIT, before=None, expected_root=None, authorize=None):
    if type(limit) is not int or not 1 <= limit <= PAGE_LIMIT or (before is not None and not _uuid(before)):
        raise ValueError('invalid_message_mesh_recovery_page')
    deadline = time.monotonic() + 15
    head, document, sizes = _index(writer, publisher, source, scope, user_id, expected_root, deadline, authorize)
    root, directory = head['record']['body'], writer.publication.directory
    entries = {entry['message_id']: entry for entry in document['entries']}
    live = sorted((entry for entry in document['entries'] if not entry['deleted']),
        key=lambda entry: (parse_datetime(entry['created_at']), entry['message_id']))
    if before is not None:
        positions = {entry['message_id']: index for index, entry in enumerate(live)}
        if before not in positions:
            raise ValueError('message_mesh_recovery_cursor_unknown')
        live = live[:positions[before]]
    selected = live[-limit:]
    bodies, transferred = {}, root['size']

    def load(identity):
        nonlocal transferred
        if identity in bodies:
            return bodies[identity]
        entry = entries[identity]
        transferred += entry['size']
        if transferred > BODY_BYTE_LIMIT:
            raise ValueError('message_mesh_recovery_byte_limit')
        data = fetch_ciphertext(writer, root['cluster'], entry['digest'], entry['size'], deadline)
        body = _decode_entry(root, document, entry, data, sizes)
        bodies[identity] = body
        return body

    for entry in selected:
        load(entry['message_id'])
    reply_ids = {body['reply_to_id'] for body in bodies.values() if body['reply_to_id']}
    for identity in sorted(reply_ids):
        if identity in entries and not entries[identity]['deleted']:
            load(identity)
    messages = []
    def author(identity):
        # Account profiles and login rights are not invented during recovery.
        return {'id': identity, 'username': identity, 'nickname': '', 'avatar': ''}
    for entry in selected:
        body = bodies[entry['message_id']]
        target = bodies.get(body['reply_to_id'])
        messages.append({'id': entry['message_id'], 'conversation_id': scope,
            **({'guild_id': document['guild_id'], 'channel_id': scope, 'tags': body['tags']} if source == 'guild' else {}),
            'author': author(body['author_id']), 'content': decrypt_text(body['encrypted_content']), 'created_at': body['created_at'],
            'edited': body['edited'], 'reply_to': {'id': target['message_id'], 'author': author(target['author_id']),
                'content': decrypt_text(target['encrypted_content'])[:200]} if target else None,
            'is_pinned': False, 'delivered_at': None, 'read_at': None,
            'attachments': [{'id': item['id'], 'filename': item['filename'], 'content_type': item['content_type'],
                'file_size': item['file_size'], 'url': ('/api/guild-attachments/' if source == 'guild' else '/api/attachments/') + item['id'] + '/'} for item in body['attachments']],
            **snapshot_fields(body, user_id), 'publication_state': 'confirmed', 'consensus_committed': True,
            'mesh_write_id': sha256(canonical({'domain': 'sfera-mesh-django-message-write-v1',
                'message': entry['message_id'], 'snapshot': entry['snapshot_hash']})).hexdigest()})
    latest = current_root(directory, publisher, source, scope)
    if latest['digest'] != head['digest'] or time.monotonic() >= deadline:
        raise ValueError('message_mesh_recovery_root_changed_during_read')
    if authorize is not None:
        authorize(document)
    return {'domain': 'sfera-mesh-recovered-message-page-v1', 'source': source, 'scope': scope,
        'root_hash': head['digest'], 'generation': root['version'], 'finality': latest['finality'],
        'messages': messages, 'deleted_ids': list(root['deleted']),
        'next_before': selected[0]['message_id'] if len(live) > len(selected) and selected else None,
        'source_rows_required': False, 'account_profiles_restored': False}
