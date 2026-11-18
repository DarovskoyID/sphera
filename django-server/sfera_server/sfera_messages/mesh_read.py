"""Read attachments from authenticated holders and one fresh BFT index."""
from hashlib import sha256
import json
from pathlib import Path
import time
import sqlite3
import subprocess

from django.conf import settings

from sfera_mesh.directory import digest64
from sfera_mesh.storage import canonical
from .encryption import decrypt_bytes
from .mesh_attachments import chunk_id, CHUNK_BYTES, MAX_CHUNKS


def read_config():
    path = getattr(settings, 'SFERA_MESH_MESSAGE_READ_CONFIG', '')
    if not isinstance(path, str) or not Path(path).is_absolute():
        raise ValueError('message_mesh_read_configuration_required')
    with Path(path).open('rb') as source:
        config = source.read(16385)
    if len(config) > 16384:
        raise ValueError('message_mesh_read_configuration_limit')
    return json.loads(config)


def fetch_ciphertext(writer, cluster, digest, size, deadline):
    """Only authenticated responses with the exact committed wire hash count."""
    journal = writer.publication.journal
    members = writer.publication.directory.placement(cluster)['record']['body']['members']
    for node in members:
        if time.monotonic() >= deadline:
            break
        try:
            response = journal._request(node, 'get', {'digest': digest})
            encoded = response.get('ciphertext')
            if not isinstance(encoded, str) or len(encoded) != 2 * size or response.get('digest') != digest:
                continue
            payload = bytes.fromhex(encoded)
            if len(payload) != size or sha256(payload).hexdigest() != digest:
                continue
            values = json.loads(payload)
            if (canonical(values) != payload or not isinstance(values, list) or len(values) != 1 or
                    not isinstance(values[0], str)):
                continue
            return bytes.fromhex(values[0])
        except (ValueError, OSError, KeyError, TypeError, AttributeError):
            continue
    raise ValueError('message_mesh_block_unavailable')


def read_attachment(writer, write, attachment):
    source = 'guild' if attachment._meta.label_lower == 'sfera_servers.guildattachment' else 'dm'
    scope = attachment.channel_id if source == 'guild' else attachment.conversation_id
    version, domain = (3, 'sfera-mesh-django-guild-message-v1') if source == 'guild' else (2, 'sfera-mesh-django-message-v2')
    if (writer.publication.directory.pin != write.genesis or write.source != source or write.format_version != version or
            write.message_id != attachment.message_id or write.conversation_id != scope):
        raise ValueError('message_mesh_read_context_changed')
    # The local encrypted snapshot gives the expected digest; the verified
    # manifest must confirm that digest before any holder's bytes are accepted.
    local = bytes(write.ciphertext)
    if not 1 <= len(local) <= 131000:
        raise ValueError('message_mesh_snapshot_corrupt')
    body_wire = canonical([local.hex()])
    body_digest = sha256(body_wire).hexdigest()
    writer.confirm_sizes(write.cluster, {body_digest: len(body_wire)})
    journal = writer.publication.journal
    journal.refresh_discovery()
    members = writer.publication.directory.placement(write.cluster)['record']['body']['members']
    deadline = time.monotonic() + 15

    def fetch(digest, size):
        for node in members:
            if time.monotonic() >= deadline:
                break
            try:
                response = journal._request(node, 'get', {'digest': digest})
                encoded = response.get('ciphertext')
                if not isinstance(encoded, str) or len(encoded) > 524288 or response.get('digest') != digest:
                    continue
                payload = bytes.fromhex(encoded)
                if len(payload) != size or sha256(payload).hexdigest() != digest:
                    continue
                values = json.loads(payload)
                if (canonical(values) != payload or not isinstance(values, list) or len(values) != 1 or
                        not isinstance(values[0], str)):
                    continue
                return bytes.fromhex(values[0])
            except (ValueError, OSError, KeyError, TypeError, AttributeError):
                continue
        raise ValueError('message_mesh_attachment_unavailable')

    remote = fetch(body_digest, len(body_wire))
    raw = decrypt_bytes(remote)
    snapshot = json.loads(raw)
    expected_id = sha256(canonical({'domain': 'sfera-mesh-django-message-write-v1',
                                    'message': str(write.message_id), 'snapshot': sha256(raw).hexdigest()})).hexdigest()
    if (not isinstance(snapshot, dict) or canonical(snapshot) != raw or sha256(raw).hexdigest() != write.snapshot_hash or
            expected_id != write.pk or snapshot.get('domain') != domain or
            snapshot.get('message_id') != str(write.message_id) or snapshot.get('conversation_id') != str(write.conversation_id) or
            snapshot.get('genesis') != write.genesis or snapshot.get('cluster') != write.cluster):
        raise ValueError('message_mesh_snapshot_corrupt')
    attachments = snapshot.get('attachments')
    if not isinstance(attachments, list) or len(attachments) > 15:
        raise ValueError('message_mesh_attachment_snapshot_corrupt')
    sizes, requested, count = {body_digest: len(body_wire)}, None, 0
    for item in attachments:
        if not isinstance(item, dict) or not isinstance(item.get('chunks'), list) or not item['chunks']:
            raise ValueError('message_mesh_attachment_snapshot_corrupt')
        if item.get('id') == str(attachment.pk):
            if requested is not None:
                raise ValueError('message_mesh_attachment_snapshot_corrupt')
            requested = item
        for part in item['chunks']:
            count += 1
            if (count > MAX_CHUNKS or not isinstance(part, dict) or not digest64(part.get('digest')) or
                    type(part.get('size')) is not int or not 1 <= part['size'] <= CHUNK_BYTES or
                    part.get('id') != chunk_id(write.genesis, write.cluster, part['digest'])):
                raise ValueError('message_mesh_attachment_snapshot_corrupt')
            size = 2 * part['size'] + 4
            if sizes.setdefault(part['digest'], size) != size:
                raise ValueError('message_mesh_attachment_snapshot_corrupt')
    if requested is None or (requested.get('filename'), requested.get('content_type'), requested.get('file_size')) != (
            attachment.original_filename, attachment.content_type, attachment.file_size):
        raise ValueError('message_mesh_attachment_context_changed')
    writer.confirm_sizes(write.cluster, sizes)
    result = b''.join(fetch(part['digest'], sizes[part['digest']]) for part in requested['chunks'])
    if (time.monotonic() >= deadline or len(result) != requested.get('encrypted_size') or
            sha256(result).hexdigest() != requested.get('encrypted_digest')):
        raise ValueError('message_mesh_attachment_corrupt')
    writer.publication.directory.anchor()
    plaintext = decrypt_bytes(result)
    if len(plaintext) != attachment.file_size:
        raise ValueError('message_mesh_attachment_size_changed')
    return plaintext


def recover_attachment(attachment):
    path = getattr(settings, 'SFERA_MESH_MESSAGE_READ_CONFIG', '')
    if not path:
        return None
    if not Path(path).is_absolute() or not attachment.message_id:
        raise ValueError('message_mesh_read_configuration_required')
    from .models import MessageMeshWrite
    from .mesh_sources import source_model
    from .mesh_reader import open_reader
    source = 'guild' if attachment._meta.label_lower == 'sfera_servers.guildattachment' else 'dm'
    message = source_model(source).objects.using(attachment._state.db).filter(pk=attachment.message_id).first()
    write = MessageMeshWrite.objects.using(attachment._state.db).filter(pk=message.mesh_write_id, message_id=message.pk).first() if message else None
    if write is None:
        raise ValueError('message_mesh_attachment_snapshot_required')
    try:
        with open_reader(read_config(), clusters={write.cluster}) as writer:
            return read_attachment(writer, write, attachment)
    except (sqlite3.Error, subprocess.SubprocessError) as exc:
        raise ValueError('message_mesh_read_unavailable') from exc
