"""Opt-in DM delivery after fresh verification, with durable at-least-once fanout."""
from hashlib import sha256
import json

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from sfera_mesh.storage import canonical
from .encryption import decrypt_bytes


def enabled():
    if not getattr(settings, 'SFERA_MESH_MESSAGE_DELIVERY', False):
        return False
    from .mesh_publication import enabled as capture_enabled
    if not capture_enabled():
        raise ValueError('mesh_delivery_requires_capture')
    return True


def client_nonce(value):
    if value is None:
        return ''
    if not isinstance(value, str) or len(value) > 128:
        raise ValueError('invalid_message_nonce')
    return value


def enqueue(message, write, using, nonce=''):
    from .models import MessageMeshDelivery
    events = MessageMeshDelivery.objects.using(using).filter(message_id=message.pk, write__source=write.source)
    previous = events.filter(state='pending').order_by('-created_at').first()
    nonce = client_nonce(nonce) or (previous.nonce if previous else '')
    events.filter(state='pending').update(state='superseded')
    events.create(message_id=message.pk, write=write, nonce=nonce)


def pending_payload(message, nonce=''):
    return {'type': 'message_pending', 'id': str(message.pk), 'write_id': message.mesh_write_id,
            'nonce': client_nonce(nonce), 'publication_state': 'pending', 'consensus_committed': False}


def visible(qs, user=None):
    if not enabled():
        return qs
    from .models import MessageMeshWrite
    accepted = MessageMeshWrite.objects.using(qs.db).filter(state='confirmed').values('pk')
    condition = Q(mesh_write_id='') | Q(mesh_write_id__in=accepted)
    if user is not None:
        condition |= Q(author=user)
    return qs.filter(condition)


def dispatch_confirmed(writer, *, using='default', limit=32, emit=None, emit_delete=None, index_gate=None, index_scopes=None):
    """Only successful transport enqueue is acknowledged; a crash can repeat IDs."""
    from .models import Message, MessageMeshDelivery
    from .mesh_attachments import verify_chunks
    from .serializers import MessageSerializer
    from sfera_auth.models import BlockedUser, UserBan
    if not enabled():
        return 0
    if type(limit) is not int or not 1 <= limit <= 64:
        raise ValueError('invalid_mesh_delivery_batch')
    from .mesh_index_worker import enabled as index_enabled
    require_index = index_enabled()
    emit = emit or emit_delivery
    queued = MessageMeshDelivery.objects.using(using).filter(state='pending', write__state='confirmed')
    if require_index and index_scopes is not None:
        from .mesh_history import _uuid
        if len(index_scopes) > 128 or any(source not in ('dm', 'guild') or not _uuid(scope) for source, scope in index_scopes):
            raise ValueError('invalid_mesh_delivery_index_scopes')
        if not index_scopes:
            return 0
        allowed = Q(pk__in=[])
        for source, scope in index_scopes:
            allowed |= Q(write__source=source, write__conversation_id=scope)
        queued = queued.filter(allowed)
    candidates = list(queued.order_by('created_at').values_list('pk', flat=True)[:limit])
    sent = 0
    for identity in candidates:
        with transaction.atomic(using=using):
            event = MessageMeshDelivery.objects.using(using).select_for_update().select_related('write').filter(pk=identity, state='pending').first()
            if event is None:
                continue
            if require_index and (index_gate is None or not index_gate(event.write)):
                continue
            if event.write.format_version == 4:
                sent += dispatch_delete(writer, event, using, emit_delete or emit_deletion)
                continue
            if event.write.source == 'guild':
                from .mesh_guild import dispatch_event
                sent += dispatch_event(writer, event, using=using, emit=emit if emit is not emit_delivery else None)
                continue
            message = Message.objects.using(using).select_for_update().select_related('author', 'conversation', 'reply_to__author').filter(pk=event.message_id).first()
            if message is None or message.mesh_write_id != event.write_id:
                event.state = 'superseded'
                event.save(update_fields=['state'])
                continue
            write = event.write
            data = bytes(write.ciphertext)
            raw = decrypt_bytes(data)
            snapshot = json.loads(raw)
            expected = sha256(canonical({'domain': 'sfera-mesh-django-message-write-v1', 'message': str(message.pk), 'snapshot': write.snapshot_hash})).hexdigest()
            if (writer.publication.directory.pin != write.genesis or write.format_version != 2 or
                    not isinstance(snapshot, dict) or canonical(snapshot) != raw or sha256(raw).hexdigest() != write.snapshot_hash or expected != write.pk or
                    snapshot.get('domain') != 'sfera-mesh-django-message-v2' or snapshot.get('message_id') != str(message.pk) or
                    snapshot.get('conversation_id') != str(message.conversation_id) or snapshot.get('author_id') != str(message.author_id) or
                    snapshot.get('genesis') != write.genesis or snapshot.get('cluster') != write.cluster):
                raise ValueError('message_mesh_delivery_snapshot_corrupt')
            parts = verify_chunks(snapshot, write, using)
            sizes = {sha256(canonical([data.hex()])).hexdigest(): len(canonical([data.hex()]))}
            sizes.update({part.digest: len(canonical([bytes(part.ciphertext).hex()])) for part in parts.values()})
            finality = writer.confirm_sizes(write.cluster, sizes)
            participants = list(message.conversation.participants.values_list('pk', flat=True))
            others = [item for item in participants if item != message.author_id]
            if (message.author_id not in participants or UserBan.objects.using(using).filter(user_id=message.author_id).exists() or BlockedUser.objects.using(using).filter(
                    Q(blocker_id=message.author_id, blocked_id__in=others) | Q(blocked_id=message.author_id, blocker_id__in=others)).exists()):
                event.state = 'cancelled'
                event.save(update_fields=['state'])
                continue
            # Contents come from the verified immutable revision, not a mutable
            # local plaintext cache. Current account metadata remains current.
            for field in ('encrypted_content', 'encrypted_payload', 'message_type', 'edited'):
                setattr(message, field, snapshot[field])
            payload = dict(MessageSerializer(message).data)
            from .mesh_rich import snapshot_fields
            payload.update(snapshot_fields(snapshot))
            if message.reply_to_id and not visible(type(message).objects.using(using).filter(pk=message.reply_to_id)).exists():
                payload['reply_to'] = None
            payload['attachments'] = [{'id': item['id'], 'filename': item['filename'], 'content_type': item['content_type'],
                                       'file_size': item['file_size'], 'url': '/api/attachments/' + item['id'] + '/'} for item in snapshot['attachments']]
            payload.update(publication_state='confirmed', mesh_write_id=write.pk, mesh_event_id=str(event.pk),
                           mesh_revision=event.created_at.isoformat(), consensus_committed=True, nonce=event.nonce)
            edited = MessageMeshDelivery.objects.using(using).filter(message_id=message.pk, write__source='dm', state__in=['sent', 'legacy']).exists()
            writer.publication.directory.anchor()
            emit(message, payload, edited, others, finality)
            event.state, event.sent_at = 'sent', timezone.now()
            event.save(update_fields=['state', 'sent_at'])
            sent += 1
    return sent


def dispatch_delete(writer, event, using, emit):
    from .mesh_revisions import validate_tombstone
    from .mesh_sources import source_model
    write = event.write
    data = bytes(write.ciphertext)
    raw = decrypt_bytes(data)
    snapshot = json.loads(raw)
    validate_tombstone(snapshot, write.genesis, write.cluster)
    expected = sha256(canonical({'domain': 'sfera-mesh-django-message-write-v1',
        'message': str(event.message_id), 'snapshot': write.snapshot_hash})).hexdigest()
    if (writer.publication.directory.pin != write.genesis or canonical(snapshot) != raw or
            sha256(raw).hexdigest() != write.snapshot_hash or expected != write.pk or
            snapshot['source'] != write.source or snapshot['message_id'] != str(event.message_id) or
            snapshot['conversation_id'] != str(write.conversation_id) or
            source_model(write.source).objects.using(using).filter(pk=event.message_id).exists()):
        raise ValueError('message_mesh_delete_snapshot_corrupt')
    writer.confirm_sizes(write.cluster, {sha256(canonical([data.hex()])).hexdigest(): len(canonical([data.hex()]))})
    payload = {'type': 'message_deleted', 'id': str(event.message_id),
        'mesh_write_id': write.pk, 'mesh_event_id': str(event.pk),
        'publication_state': 'confirmed', 'consensus_committed': True}
    writer.publication.directory.anchor()
    emit(write.source, str(write.conversation_id), payload)
    event.state, event.sent_at = 'sent', timezone.now()
    event.save(update_fields=['state', 'sent_at'])
    return 1


def emit_deletion(source, scope, payload):
    from asgiref.sync import async_to_sync
    from channels.layers import get_channel_layer
    from .services import _gw_broadcast
    group = ('chat_' if source == 'dm' else 'guild_channel_') + scope
    event = {**payload, 'message_id': payload['id']}
    async_to_sync(get_channel_layer().group_send)(group, event)
    _gw_broadcast(group, payload, strict=True)


def emit_delivery(message, payload, edited, recipients, finality):
    from asgiref.sync import async_to_sync
    from channels.layers import get_channel_layer
    from .services import _gw_broadcast, notify_message_created, _fanout_user_notifs
    group = 'chat_' + str(message.conversation_id)
    event = {'type': 'message_edited' if edited else 'chat_message', 'message': payload}
    async_to_sync(get_channel_layer().group_send)(group, event)
    _gw_broadcast(group, {'type': 'message_edited', 'message': payload} if edited else payload, strict=True)
    if not edited:
        notify_message_created('dm', message, mesh_confirmed=True)
        notification_text = ('Зашифрованное сообщение' if message.message_type == 'cipher' else
            payload['content'] or ('📎 Attachment' if payload['attachments'] else ''))
        _fanout_user_notifs([str(item) for item in recipients], {
            'type': 'new_message_notification', 'sender_id': str(message.author_id),
            'sender_name': message.author.nickname or message.author.username,
            'content': notification_text,
        })
        try:
            from sfera_server.fcm import send_to_user
            for recipient in recipients:
                send_to_user(str(recipient), {'type': 'message',
                    'sender_name': message.author.nickname or message.author.username,
                    'content': notification_text})
        except Exception:
            pass  # Push remains best-effort, after the durable message gate.
