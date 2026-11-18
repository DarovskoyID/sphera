"""Read-only recovery inventory. Never infer a live message from an old revision."""
from hashlib import sha256
import json
import time
from types import SimpleNamespace
import uuid

from cryptography.fernet import InvalidToken
from django.utils.dateparse import parse_datetime

from sfera_mesh.directory import digest64
from sfera_mesh.manifest_reads import verified_manifests
from sfera_mesh.storage import canonical
from .encryption import decrypt_bytes
from .mesh_history import _snapshot, _attachment_sizes, _uuid, BODY_BYTE_LIMIT
from .mesh_read import fetch_ciphertext
from .mesh_revisions import TOMBSTONE, history_fields, validate_tombstone


def inventory_page(reader, cluster, *, after='', manifest=None, limit=16, allow_unavailable=False):
    """Enumerate committed revisions without Message or MessageMeshWrite queries.

    The cursor is valid only for the exact pinned manifest. Unclassified blocks
    include file parts and ciphertext encrypted under unavailable application
    keys. This is an operator recovery primitive, not an ACL-authorized feed.
    """
    if (not digest64(cluster) or type(allow_unavailable) is not bool or type(limit) is not int or not 1 <= limit <= 32 or
            (after and (not digest64(after) or not digest64(manifest)))):
        raise ValueError('invalid_message_mesh_inventory_query')
    reader.refresh()
    directory = reader.publication.directory
    anchor, known = verified_manifests(directory)
    head = known.get(cluster)
    if not head or (manifest is not None and manifest != head['digest']):
        raise ValueError('message_mesh_inventory_manifest_changed')
    with directory.lock:
        body = directory.current['state']['manifests'][cluster]['record']['body']
        if len(head['sizes']) != len(body['digests']):
            raise ValueError('message_mesh_inventory_sized_manifest_required')
    entries = sorted(head['sizes'].items())
    if after and after not in head['sizes']:
        raise ValueError('message_mesh_inventory_cursor_unknown')
    remaining = [(digest, size) for digest, size in entries if digest > after]
    selected, transferred = [], 0
    for digest, size in remaining[:limit]:
        if transferred + size > BODY_BYTE_LIMIT:
            break
        selected.append((digest, size))
        transferred += size
    reader.publication.journal.refresh_discovery()
    deadline = time.monotonic() + 15
    revisions, unclassified, unavailable = [], 0, []
    domains = {'sfera-mesh-django-message-v2': ('dm', 2),
               'sfera-mesh-django-guild-message-v1': ('guild', 3)}
    for digest, size in selected:
        try:
            data = fetch_ciphertext(reader, cluster, digest, size, deadline)
        except ValueError as exc:
            if not allow_unavailable or str(exc) != 'message_mesh_block_unavailable':
                raise
            unavailable.append(digest)
            continue
        try:
            raw = decrypt_bytes(data)
        except InvalidToken:
            unclassified += 1
            continue
        try:
            body = json.loads(raw)
        except (ValueError, UnicodeError):
            unclassified += 1
            continue
        if not isinstance(body, dict) or body.get('domain') not in {*domains, TOMBSTONE}:
            unclassified += 1
            continue
        if (canonical(body) != raw or not 1 <= len(data) <= 131000 or not all(_uuid(body.get(key)) for key in
                ('message_id', 'conversation_id', 'author_id'))):
            raise ValueError('message_mesh_inventory_snapshot_corrupt')
        deleted = body['domain'] == TOMBSTONE
        if deleted:
            validate_tombstone(body, directory.pin, cluster)
            source, version = body['source'], 4
        else:
            source, version = domains[body['domain']]
        timestamp = body.get('deleted_at' if deleted else 'created_at')
        if not isinstance(timestamp, str):
            raise ValueError('message_mesh_inventory_timestamp_corrupt')
        created = parse_datetime(timestamp)
        if created is None or created.utcoffset() is None:
            raise ValueError('message_mesh_inventory_timestamp_corrupt')
        if source == 'guild' and not deleted and not _uuid(body.get('guild_id')):
            raise ValueError('message_mesh_inventory_guild_corrupt')
        snapshot_hash = sha256(raw).hexdigest()
        identity = sha256(canonical({'domain': 'sfera-mesh-django-message-write-v1',
            'message': body['message_id'], 'snapshot': snapshot_hash})).hexdigest()
        message = SimpleNamespace(pk=uuid.UUID(body['message_id']),
            author_id=uuid.UUID(body['author_id']), created_at=created,
            conversation_id=uuid.UUID(body['conversation_id']),
            channel_id=uuid.UUID(body['conversation_id']),
            channel=SimpleNamespace(guild_id=body.get('guild_id')),
            _meta=SimpleNamespace(label_lower='sfera_messages.message' if source == 'dm' else 'sfera_servers.guildmessage'))
        write = SimpleNamespace(pk=identity, source=source, format_version=version,
            message_id=message.pk, conversation_id=message.conversation_id,
            genesis=directory.pin, cluster=cluster, snapshot_hash=snapshot_hash)
        validated = body if deleted else _snapshot(write, data, message)
        parts = _attachment_sizes(write, validated)
        if any(head['sizes'].get(part) != length for part, length in parts.items()):
            raise ValueError('message_mesh_inventory_files_unconfirmed')
        revisions.append({'source': source, 'message_id': body['message_id'],
            'scope_id': body['conversation_id'], 'author_id': body['author_id'],
            'created_at': body.get('created_at'), 'deleted_at': body.get('deleted_at'), 'write_id': identity,
            'snapshot_hash': snapshot_hash, 'digest': digest, 'size': size,
            'attachment_count': len(body['attachments']), 'attachment_digests': sorted(parts),
            'history': history_fields(body), 'deleted': deleted})
    # A network refresh during holder I/O must not splice two manifest pages.
    _, current = verified_manifests(directory)
    if current.get(cluster) != head or time.monotonic() >= deadline:
        raise ValueError('message_mesh_inventory_changed_during_read')
    return {'domain': 'sfera-mesh-message-inventory-v1', 'genesis': directory.pin,
        'cluster': cluster, 'manifest': head['digest'], 'finality': anchor,
        'scanned': len(selected), 'unclassified': unclassified,
        'unavailable': unavailable, 'all_blocks_available': not unavailable,
        'revisions': revisions, 'next_after': selected[-1][0] if len(remaining) > len(selected) else None,
        'live_history_recovered': False}
