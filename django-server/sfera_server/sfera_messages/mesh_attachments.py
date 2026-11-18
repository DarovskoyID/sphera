"""Bounded snapshots of existing encrypted attachment files, never plaintext."""
from hashlib import sha256
from cryptography.fernet import InvalidToken

from sfera_mesh.storage import canonical
from .encryption import decrypt_bytes

CHUNK_BYTES = 120000
MAX_CHUNKS = 64
MAX_STORED_CHUNKS = 1024


def chunk_id(genesis, cluster, digest):
    return sha256(canonical({'domain': 'sfera-mesh-django-attachment-chunk-v1',
                             'genesis': genesis, 'cluster': cluster, 'digest': digest})).hexdigest()


def capture_attachments(message, using, genesis, cluster):
    from .mesh_sources import scope_id, scope_field, source_name
    snapshots, chunks = [], {}
    slots = 0
    for attachment in message.attachments.using(using).order_by('id')[:16]:
        if len(snapshots) >= 15 or getattr(attachment, scope_field(source_name(message))) != scope_id(message) or attachment.uploader_id != message.author_id:
            raise ValueError('invalid_message_mesh_attachment_binding')
        parts, checksum, length, encrypted_pieces = [], sha256(), 0, []
        try:
            with attachment.file.open('rb') as source:
                while True:
                    data = source.read(CHUNK_BYTES)
                    if not data:
                        break
                    slots += 1
                    if slots > MAX_CHUNKS or not isinstance(data, bytes) or len(data) > CHUNK_BYTES:
                        raise ValueError('message_mesh_attachment_chunk_limit')
                    checksum.update(data)
                    encrypted_pieces.append(data)
                    length += len(data)
                    digest = sha256(canonical([data.hex()])).hexdigest()
                    identity = chunk_id(genesis, cluster, digest)
                    chunks[identity] = (digest, data)
                    parts.append({'id': identity, 'digest': digest, 'size': len(data)})
        except OSError as exc:
            raise ValueError('message_mesh_attachment_unavailable') from exc
        if not parts:
            raise ValueError('message_mesh_attachment_empty')
        try:
            if len(decrypt_bytes(b''.join(encrypted_pieces))) != attachment.file_size:
                raise ValueError('message_mesh_attachment_plaintext_size_changed')
        except InvalidToken as exc:
            raise ValueError('message_mesh_attachment_ciphertext_corrupt') from exc
        snapshots.append({'id': str(attachment.pk), 'filename': attachment.original_filename,
                          'content_type': attachment.content_type, 'file_size': attachment.file_size,
                          'encrypted_size': length, 'encrypted_digest': checksum.hexdigest(), 'chunks': parts})
    return snapshots, chunks


def persist_chunks(chunks, using, genesis, cluster):
    from .models import MessageMeshChunk
    objects = MessageMeshChunk.objects.using(using)
    existing = {row.pk: row for row in objects.filter(pk__in=chunks)}
    if objects.count() + len(chunks.keys() - existing.keys()) > MAX_STORED_CHUNKS:
        raise ValueError('message_mesh_chunk_storage_limit')
    for identity, (digest, data) in chunks.items():
        old = existing.get(identity)
        if old is not None:
            if (old.genesis, old.cluster, old.digest, bytes(old.ciphertext)) != (genesis, cluster, digest, data):
                raise ValueError('message_mesh_chunk_conflict')
        else:
            objects.create(id=identity, genesis=genesis, cluster=cluster, digest=digest, ciphertext=data)


def verify_chunks(snapshot, write, using):
    """Check the immutable snapshot against the entire stored chunk relation."""
    rows = {row.pk: row for row in write.chunks.using(using).all()}
    expected, slots = set(), 0
    attachments = snapshot.get('attachments', [])
    if not isinstance(attachments, list) or len(attachments) > 15:
        raise ValueError('message_mesh_attachment_snapshot_corrupt')
    for attachment in attachments:
        checksum, length = sha256(), 0
        if not isinstance(attachment, dict) or not isinstance(attachment.get('chunks'), list) or not attachment['chunks']:
            raise ValueError('message_mesh_attachment_snapshot_corrupt')
        for part in attachment['chunks']:
            slots += 1
            if slots > MAX_CHUNKS or not isinstance(part, dict) or set(part) != {'id', 'digest', 'size'}:
                raise ValueError('message_mesh_attachment_snapshot_corrupt')
            identity = part['id']
            row = rows.get(identity)
            if row is None:
                raise ValueError('message_mesh_attachment_chunk_missing')
            data = bytes(row.ciphertext)
            digest = sha256(canonical([data.hex()])).hexdigest()
            if (not 1 <= len(data) <= CHUNK_BYTES or part['size'] != len(data) or
                    row.digest != digest or part['digest'] != digest or
                    identity != chunk_id(write.genesis, write.cluster, digest) or
                    (row.genesis, row.cluster) != (write.genesis, write.cluster)):
                raise ValueError('message_mesh_attachment_chunk_corrupt')
            expected.add(identity)
            checksum.update(data)
            length += len(data)
        if attachment.get('encrypted_size') != length or attachment.get('encrypted_digest') != checksum.hexdigest():
            raise ValueError('message_mesh_attachment_snapshot_corrupt')
    if expected != set(rows):
        raise ValueError('message_mesh_attachment_relation_corrupt')
    return rows
