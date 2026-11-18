"""Bounded v2 reads by explicit UUIDs, without source SQL rows.

This is deliberately not a chronological feed: UUID tree order has no time
meaning. HTTP callers must retain their current session and live ACL guards.
"""
from hashlib import sha256
import json
import time

from sfera_mesh.directory import digest64
from sfera_mesh.manifest_reads import verified_manifests
from sfera_mesh.recovery_pages import PagedIndexReader
from sfera_mesh.recovery_roots import namespace
from sfera_mesh.recovery_tree import validate_head
from sfera_mesh.storage import canonical
from .encryption import decrypt_bytes, decrypt_text
from .mesh_history import _uuid, BODY_BYTE_LIMIT
from .mesh_read import fetch_ciphertext
from .mesh_recovery_index import _decode_entry
from .mesh_rich import snapshot_fields


def current_head(directory, publisher, source, scope):
    identity = namespace(publisher, source, scope)
    with directory.lock:
        anchor = directory.anchor()
        head = directory.current['state'].get('recovery_trees', {}).get(identity)
        if head is None:
            raise ValueError('recovery_tree_not_published')
        head = json.loads(canonical(head))
        body, digest = validate_head(head['record'], directory.network, directory.pin)
        if (head['digest'] != digest or
                (body['publisher'], body['source'], body['scope']) != (publisher, source, scope)):
            raise ValueError('recovery_tree_read_context_changed')
        return {**head, 'finality': dict(anchor)}


class PagedRecoveryRead:
    def __init__(self, writer, publisher, source, scope, user, *, expected_root=None, authorize=None, authorize_paged=None, deadline=None):
        if not _uuid(str(user)) or (expected_root is not None and not digest64(expected_root)):
            raise ValueError('invalid_paged_recovery_query')
        self.writer, self.directory = writer, writer.publication.directory
        self.publisher, self.source, self.scope = publisher, source, scope
        self.authorize, self.deadline = authorize, PagedIndexReader.bound_deadline(deadline)
        self.authorize_paged = authorize_paged
        self.refresh()
        self.head = current_head(self.directory, publisher, source, scope)
        if expected_root is not None and expected_root != self.head['digest']:
            raise ValueError('message_mesh_recovery_root_changed')
        self.root = self.head['record']['body']
        _, self.known = verified_manifests(self.directory)
        writer.publication.journal.refresh_discovery()
        self.used = 0
        self.reader = PagedIndexReader.from_block(self.root, str(user), self.wire, decrypt_bytes, deadline=self.deadline)
        if authorize is not None:
            authorize(self.reader.document)
        if authorize_paged is not None:
            authorize_paged(self.reader)

    def refresh(self):
        if hasattr(self.writer, 'refresh'):
            self.writer.refresh()
        else:
            self.directory.refresh(self.writer.publication.address)

    def sizes(self, cluster):
        return self.known.get(cluster, {}).get('sizes', {})

    def wire(self, cluster, digest, size):
        if time.monotonic() >= self.deadline:
            raise ValueError('recovery_page_deadline')
        if self.sizes(cluster).get(digest) != size:
            raise ValueError('paged_recovery_block_uncommitted')
        if self.used + size > BODY_BYTE_LIMIT:
            raise ValueError('message_mesh_recovery_byte_limit')
        self.used += size
        data = fetch_ciphertext(self.writer, cluster, digest, size, self.deadline)
        raw = canonical([data.hex()])
        if len(raw) != size or sha256(raw).hexdigest() != digest:
            raise ValueError('paged_recovery_block_corrupt')
        return raw

    def body(self, entry):
        data = bytes.fromhex(json.loads(self.wire(entry['cluster'], entry['digest'], entry['size']))[0])
        # Each message may live in a different confirmed storage cluster.
        root = {**self.root, 'cluster': entry['cluster']}
        return _decode_entry(root, self.reader.document, entry, data, self.sizes(entry['cluster']))

    def finish(self):
        if self.authorize is not None:
            self.authorize(self.reader.document)
        if self.authorize_paged is not None:
            self.authorize_paged(self.reader)
        self.refresh()
        latest = current_head(self.directory, self.publisher, self.source, self.scope)
        if latest['digest'] != self.head['digest'] or time.monotonic() >= self.deadline:
            raise ValueError('message_mesh_recovery_root_changed_during_read')
        if time.monotonic() >= self.deadline:
            raise ValueError('recovery_page_deadline')
        return latest['finality']


def read_paged_bodies(writer, publisher, source, scope, user, identities, **kwargs):
    """Return typed snapshots in requested order; terminal entries expose no body."""
    if (not isinstance(identities, list) or not 1 <= len(identities) <= 32 or
            any(not _uuid(identity) for identity in identities) or len(set(identities)) != len(identities)):
        raise ValueError('invalid_paged_recovery_message_ids')
    read = PagedRecoveryRead(writer, publisher, source, scope, user, **kwargs)
    result = []
    for identity in identities:
        entry = read.reader.lookup(identity)
        body = read.body(entry) if entry is not None and not entry['deleted'] else None
        display = None if body is None else {'id': identity, 'content': decrypt_text(body['encrypted_content']),
            'created_at': body['created_at'], 'author': {'id': body['author_id'], 'username': body['author_id']},
            'attachments': [{field: item[field] for field in ('id', 'filename', 'content_type', 'file_size')}
                for item in body['attachments']], **snapshot_fields(body, user)}
        result.append({'message_id': identity, 'status': 'missing' if entry is None else 'deleted' if entry['deleted'] else 'live',
            'snapshot': body, 'display': display})
    finality = read.finish()
    return {'domain': 'sfera-mesh-recovered-bodies-v2', 'root_hash': read.head['digest'],
        'generation': read.root['version'], 'source': source, 'scope': scope,
        'messages': result, 'finality': finality, 'source_rows_required': False}


def read_paged_attachment(writer, publisher, source, scope, user, message, attachment, **kwargs):
    if not _uuid(message) or not _uuid(attachment):
        raise ValueError('invalid_message_mesh_recovery_attachment')
    read = PagedRecoveryRead(writer, publisher, source, scope, user, **kwargs)
    entry = read.reader.lookup(message)
    if entry is None or entry['deleted']:
        raise PermissionError('message_mesh_recovery_attachment_deleted_or_missing')
    body = read.body(entry)
    item = next((item for item in body['attachments'] if item['id'] == attachment), None)
    if item is None:
        raise PermissionError('message_mesh_recovery_attachment_wrong_message')
    encrypted = b''.join(bytes.fromhex(json.loads(read.wire(entry['cluster'], part['digest'],
        read.sizes(entry['cluster'])[part['digest']]))[0]) for part in item['chunks'])
    if len(encrypted) != item['encrypted_size'] or sha256(encrypted).hexdigest() != item['encrypted_digest']:
        raise ValueError('message_mesh_recovery_attachment_corrupt')
    plaintext = decrypt_bytes(encrypted)
    if len(plaintext) != item['file_size']:
        raise ValueError('message_mesh_recovery_attachment_size_changed')
    finality = read.finish()
    return {'content': plaintext, 'filename': item['filename'], 'content_type': item['content_type'],
        'file_size': len(plaintext), 'root_hash': read.head['digest'], 'generation': read.root['version'], 'finality': finality}
