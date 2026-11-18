import uuid
import os
import json
import shlex
import subprocess
import tempfile
import threading
from datetime import timedelta
from django.conf import settings
from django.core.files.base import ContentFile
from django.db import transaction
from django.db.models import Q, Count
from django.http import HttpResponse
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework import status
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync
from .models import Conversation, Message, Attachment, MessageReport, MessagePin, ScheduledMessage, TodoCheck
from .cipher_mode import plaintext_view
from .models import MESSAGE_TYPE_POLL, MESSAGE_TYPE_TODO, MESSAGE_TYPE_CONTACT, MESSAGE_TYPE_LOCATION
from .serializers import ConversationSerializer, MessageSerializer, AttachmentSerializer
from .encryption import encrypt_bytes, decrypt_bytes, encrypt_text
from cryptography.fernet import InvalidToken
from . import code_guard
from . import rich as rich_msg
from .rich import RichError, rich_fields, poll_view, todo_view, location_view
from sfera_auth.models import BlockedUser

from .services import (
    DM_RICH_TYPES, GUILD_RICH_TYPES, _clean_tags, _build_rich, _author_brief,
    _apply_message_edit, _toggle_todo_item, _apply_location_update,
    MAX_UPLOAD_SIZE, MAX_ATTACHMENTS_PER_MESSAGE, _gw_broadcast, _fanout, _FANOUT_POOL,
    notify_message_created, _fanout_user_notifs, _id_list, _safe_upload, _scan_upload,
)
# Per-account caps.
MAX_PERSONAL_CHANNELS = 3   # personal channels a user may CREATE (own)
MAX_OWNED_SERVERS = 5       # (non-personal) servers a user may CREATE (own)
MAX_JOINED_SERVERS = 75     # (non-personal) servers a user may belong to
MAX_JOINED_CHANNELS = 75    # personal channels a user may subscribe to


import re as _re
from .services import _CURSOR_UNRESOLVED, _broadcast, _broadcast_message, _is_bot_message, _pagination_cutoff, _wipe_files_async




def _dm_reply_or_error(convo, reply_to_id):
    if not reply_to_id:
        return None, None
    try:
        from .mesh_delivery import visible
        return visible(Message.objects.filter(conversation=convo)).get(id=reply_to_id), None
    except (ValueError, Message.DoesNotExist):
        return None, Response({'error': 'invalid reply target'}, status=status.HTTP_400_BAD_REQUEST)


def _claim_dm_attachments(convo, user, attachment_ids, msg=None):
    ids = _id_list(attachment_ids)
    if not ids:
        return []
    qs = Attachment.objects.filter(
        id__in=ids,
        conversation=convo,
        uploader=user,
        message__isnull=True,
    )
    if qs.count() != len(set(ids)):
        raise ValueError('invalid attachment')
    if msg is not None:
        qs.update(message=msg)
    return ids


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def conversation_list(request):
    convos = request.user.conversations.all().order_by('-created_at')
    from .mesh_history import enabled as history_enabled, recover_messages, PAGE_LIMIT
    context = {'request': request}
    if history_enabled():
        convos = list(convos[:PAGE_LIMIT + 1])
        if len(convos) > PAGE_LIMIT:
            return Response({'error': 'conversation history page limit exceeded'}, status=503)
        from .mesh_delivery import visible
        last = [message for convo in convos if (message := visible(convo.messages.select_related('author'), request.user).order_by('-created_at').first()) is not None]
        try:
            payloads = recover_messages(last, request.user.pk, context=context)
            context['mesh_history_messages'] = {item['id']: item for item in payloads}
            allowed = set(request.user.conversations.filter(pk__in=[item.pk for item in convos]).values_list('pk', flat=True))
            if allowed != {item.pk for item in convos}:
                return Response({'error': 'not found'}, status=404)
            if request.auth is not None:
                from sfera_auth.mesh_sessions import require_token
                require_token(request.auth, request.user.pk)
            return Response(ConversationSerializer(convos, many=True, context=context).data)
        except (ValueError, OSError):
            return Response({'error': 'messages temporarily unavailable'}, status=503)
    return Response(ConversationSerializer(convos, many=True, context=context).data)


def _link_bot_contact(user, peer_id):
    """A DM list is built from friendships; a bot can't accept a request, so
    starting a chat with one adds the contact directly."""
    from sfera_modules import hooks
    hooks.conversation_opened.send_robust(sender=None, user=user, peer_id=peer_id)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def conversation_create(request):
    user_id = request.data.get('user_id')
    if not user_id:
        return Response(
            {'error': 'user_id required'},
            status=status.HTTP_400_BAD_REQUEST,
        )

    # Check if the other person blocked the requester
    blocked_by_other = BlockedUser.objects.filter(
        blocker_id=user_id, blocked=request.user
    ).exists()

    existing = Conversation.objects.filter(
        participants=request.user
    ).filter(participants=user_id).first()

    if existing:
        # Always return existing conversation so message history is visible,
        # even if blocked — the frontend will disable sending based on the flag.
        data = ConversationSerializer(existing, context={'request': request}).data
        data['blocked_by_other'] = blocked_by_other
        from .mesh_history import enabled as history_enabled
        data['mesh_history'] = history_enabled()
        return Response(data)

    if blocked_by_other:
        # No existing conversation and blocked — nothing to show
        return Response({'error': 'blocked'}, status=status.HTTP_403_FORBIDDEN)

    convo = Conversation.objects.create()
    convo.participants.add(request.user.id, user_id)
    _link_bot_contact(request.user, user_id)
    data = ConversationSerializer(convo, context={'request': request}).data
    data['blocked_by_other'] = False
    from .mesh_history import enabled as history_enabled
    data['mesh_history'] = history_enabled()
    return Response(data, status=status.HTTP_201_CREATED)


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def conversation_delete(request, conversation_id):
    """
    Delete a conversation entirely from both sides:
    - all messages and their attachment files
    - all attachment records
    - the conversation itself
    Broadcast a 'conversation_deleted' event so both clients disconnect.
    """
    try:
        convo = Conversation.objects.get(
            id=conversation_id, participants=request.user
        )
    except Conversation.DoesNotExist:
        return Response(
            {'error': 'not found'},
            status=status.HTTP_404_NOT_FOUND,
        )

    # Delete attachment files from disk
    for att in Attachment.objects.filter(conversation=convo):
        try:
            att.file.delete(save=False)
        except Exception:
            pass

    # Notify both participants before deleting
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'chat_{conversation_id}',
        {'type': 'conversation_deleted', 'conversation_id': str(conversation_id)},
    )

    convo.delete()  # cascades messages, attachments, scheduled messages
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def message_list(request, conversation_id):
    try:
        convo = Conversation.objects.get(id=conversation_id, participants=request.user)
    except Conversation.DoesNotExist:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    from .mesh_history import enabled as history_enabled, PAGE_LIMIT
    mesh_history = history_enabled()
    try:
        limit = min(int(request.GET.get('limit', 50)), PAGE_LIMIT if mesh_history else 200)
        if limit < 1:
            raise ValueError()
    except (ValueError, TypeError):
        return Response({'error': 'invalid page limit'}, status=400)
    before_id = request.GET.get('before')
    before_ts = request.GET.get('before_ts')

    qs = convo.messages.select_related('author', 'reply_to', 'reply_to__author').prefetch_related('attachments', 'todo_checks__user').order_by('-created_at')
    from .mesh_delivery import visible
    qs = visible(qs, request.user)
    try:
        if before_id:
            uuid.UUID(str(before_id))
        cutoff = _pagination_cutoff(convo.messages, before_id, before_ts)
    except (ValueError, TypeError):
        return Response({'error': 'invalid pagination cursor'}, status=400)
    if cutoff is _CURSOR_UNRESOLVED:
        # The client asked for a page older than a cursor we can't resolve (the
        # anchor message was deleted). Falling through without the filter would
        # return the NEWEST page, which the client prepends to the top of its
        # history — scrambling the order. Report "no older messages" instead.
        return Response([])
    if cutoff is not None:
        qs = qs.filter(created_at__lt=cutoff)
    messages = list(qs[:limit])
    messages.reverse()

    pinned_ids = set(
        MessagePin.objects.filter(user=request.user, message__in=messages).values_list('message_id', flat=True)
    )

    if mesh_history:
        from .mesh_history import recover_messages
        try:
            payload = recover_messages(messages, request.user.pk, pinned_ids=pinned_ids, context={'request': request})
        except (ValueError, OSError):
            return Response({'error': 'messages temporarily unavailable'}, status=503)
        if not Conversation.objects.filter(pk=convo.pk, participants=request.user).exists():
            return Response({'error': 'not found'}, status=404)
        if request.auth is not None:
            from sfera_auth.mesh_sessions import require_token
            require_token(request.auth, request.user.pk)
        return Response(payload)
    return Response(MessageSerializer(messages, many=True, context={'request': request, 'pinned_ids': pinned_ids}).data)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def mesh_message_content(request, message_id):
    from .mesh_delivery import visible
    from .mesh_history import enabled as history_enabled, recover_messages
    message = visible(Message.objects.filter(pk=message_id, conversation__participants=request.user), request.user).select_related('author').first()
    if message is None:
        return Response({'error': 'not found'}, status=404)
    if not history_enabled():
        return Response({'error': 'mesh history is not enabled'}, status=409)
    try:
        payload = recover_messages([message], request.user.pk, context={'request': request})[0]
    except (ValueError, OSError):
        return Response({'error': 'message temporarily unavailable'}, status=503)
    if not Conversation.objects.filter(pk=message.conversation_id, participants=request.user).exists():
        return Response({'error': 'not found'}, status=404)
    if request.auth is not None:
        from sfera_auth.mesh_sessions import require_token
        require_token(request.auth, request.user.pk)
    return Response(payload)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def mesh_message_receipt(request, message_id):
    from .models import MessageMeshWrite
    # A publication identifier or digest is never an authorization capability.
    message = Message.objects.filter(pk=message_id, conversation__participants=request.user).first()
    if message is None:
        return Response({'error': 'not found'}, status=404)
    row = MessageMeshWrite.objects.filter(pk=message.mesh_write_id, message_id=message_id).first()
    if row is None:
        return Response({'scope': 'message_body', 'state': 'not_mirrored', 'consensus_committed': False})
    return Response({'scope': 'message' if row.format_version == 2 else 'message_body', 'write_id': row.pk, 'genesis': row.genesis,
                     'state': row.state, 'consensus_committed': row.state == 'confirmed',
                     'receipt': row.receipt if row.state == 'confirmed' else None,
                     'observed_at': row.confirmed_at.isoformat() if row.confirmed_at else None})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@plaintext_view
def send_message(request, conversation_id):
    from .mesh_delivery import enabled as delivery_enabled, pending_payload, client_nonce
    delivery_mode = delivery_enabled()
    try:
        nonce = client_nonce(request.data.get('nonce'))
    except ValueError:
        return Response({'error': 'invalid nonce'}, status=400)
    try:
        convo = Conversation.objects.get(id=conversation_id, participants=request.user)
    except Conversation.DoesNotExist:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    if BlockedUser.objects.filter(
        Q(blocker=request.user, blocked__in=convo.participants.exclude(id=request.user.id)) |
        Q(blocked=request.user, blocker__in=convo.participants.exclude(id=request.user.id))
    ).exists():
        return Response({'error': 'blocked'}, status=status.HTTP_403_FORBIDDEN)

    content = request.data.get('content', '').strip()
    attachment_ids = request.data.get('attachment_ids', [])
    reply_to_id = request.data.get('reply_to_id')
    try:
        attachment_ids = _claim_dm_attachments(convo, request.user, attachment_ids)
    except ValueError:
        return Response({'error': 'invalid attachment'}, status=status.HTTP_400_BAD_REQUEST)
    reply_to, reply_error = _dm_reply_or_error(convo, reply_to_id)
    if reply_error:
        return reply_error

    if not content and not attachment_ids:
        return Response({'error': 'empty message'}, status=status.HTTP_400_BAD_REQUEST)

    if code_guard.should_block(convo, request.user, content):
        return Response({'error': code_guard.BLOCKED_ERROR}, status=status.HTTP_403_FORBIDDEN)

    try:
        with transaction.atomic():
            msg = Message(
                conversation=convo,
                author=request.user,
                encrypted_content=encrypt_text(content),
                reply_to=reply_to,
            )
            msg._mesh_nonce = nonce
            msg.save()
            if attachment_ids:
                _claim_dm_attachments(convo, request.user, attachment_ids, msg)
                msg.refresh_from_db(fields=['mesh_write_id'])
    except ValueError as exc:
        from .mesh_publication import enabled
        if str(exc) == 'invalid attachment':
            return Response({'error': 'invalid attachment'}, status=400)
        if not enabled():
            raise
        oversized = str(exc) in ('message_mesh_attachment_chunk_limit', 'message_mesh_body_too_large')
        return Response({'error': 'message too large' if oversized else 'message temporarily unavailable'}, status=413 if oversized else 503)

    if delivery_mode:
        return Response(pending_payload(msg, nonce), status=202)

    attachments_data = []
    if attachment_ids:
        # Must match the shape the client renderer expects (see AuthMedia):
        # `filename` + `url`, same as the WS broadcast and REST serializer.
        # Otherwise the recipient can't load the media until a full reload.
        attachments_data = [
            {
                'id': str(att.id),
                'filename': att.original_filename,
                'content_type': att.content_type,
                'file_size': att.file_size,
                'url': f'/api/attachments/{att.id}/',
            }
            for att in Attachment.objects.filter(message=msg)
        ]

    reply_to_data = None
    if reply_to:
        rt = reply_to
        reply_to_data = {
            'id': str(rt.id),
            'author': {
                'id': str(rt.author.id),
                'username': rt.author.username,
                'nickname': getattr(rt.author, 'nickname', '') or '',
                'avatar': rt.author.avatar.url if getattr(rt.author, 'avatar', None) else '',
            },
            'content': rt.content[:200],
        }

    user_data = {
        'id': str(request.user.id),
        'username': request.user.username,
        'nickname': getattr(request.user, 'nickname', '') or '',
        'avatar': getattr(getattr(request.user, 'avatar', None), 'url', '') if getattr(request.user, 'avatar', None) else '',
        'status': getattr(request.user, 'status', 'online'),
        'account_type': getattr(request.user, 'account_type', 'user'),
        'is_superuser': bool(getattr(request.user, 'is_superuser', False)),
    }

    msg_payload = {
        'id': str(msg.id),
        'author': user_data,
        'content': content,
        'created_at': msg.created_at.isoformat(),
        'attachments': attachments_data,
        'reply_to': reply_to_data,
        'is_pinned': False,
        'edited': False,
    }
    if nonce:
        msg_payload['nonce'] = nonce

    _fanout(f'chat_{conversation_id}', {'type': 'chat_message', 'message': msg_payload}, msg_payload)

    sender_name = user_data.get('nickname') or user_data.get('username', '')
    notif_content = content if content else ('\U0001f4ce Attachment' if attachment_ids else '')
    notification = {
        'type': 'new_message_notification',
        'sender_id': user_data['id'],
        'sender_name': sender_name,
        'content': notif_content,
    }
    other_ids = list(
        convo.participants.exclude(id=request.user.id).values_list('id', flat=True)
    )
    _fanout_user_notifs(other_ids, notification)

    notify_message_created('dm', msg)

    return Response(msg_payload, status=status.HTTP_201_CREATED)


@api_view(['PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
def delete_message(request, message_id):
    if request.method == 'PATCH':
        try:
            msg = Message.objects.get(id=message_id, author=request.user)
        except Message.DoesNotExist:
            return Response({'error': 'not found or not your message'}, status=status.HTTP_404_NOT_FOUND)
        if _is_bot_message(msg):
            return Response({'error': 'bot messages are edited through the bot API'},
                            status=status.HTTP_403_FORBIDDEN)
        try:
            payload = _apply_message_edit(msg, request.data)
        except RichError as exc:
            return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        from .mesh_delivery import enabled as delivery_enabled, pending_payload
        if delivery_enabled():
            return Response(pending_payload(msg), status=202)
        _broadcast(f'chat_{msg.conversation_id}', {'type': 'message_edited', 'message': payload})
        return Response(payload)

    try:
        msg = Message.objects.prefetch_related('attachments').get(id=message_id, author=request.user)
    except Message.DoesNotExist:
        return Response({'error': 'not found or not your message'}, status=status.HTTP_404_NOT_FOUND)

    conversation_id = msg.conversation_id

    # Recovery queues a confirmed deletion; legacy mode broadcasts below.
    # Disk cleanup happens in the background (see _wipe_files_async).
    attachment_files = [att.file for att in msg.attachments.all() if att.file]

    msg.delete()
    from sfera_messages.mesh_revisions import enabled as recovery_enabled
    if recovery_enabled():
        from sfera_messages.models import MessageMeshWrite
        tombstone = MessageMeshWrite.objects.get(message_id=message_id, source='dm', format_version=4)
        _wipe_files_async(attachment_files)
        return Response({'type': 'message_delete_pending', 'id': str(message_id),
            'write_id': tombstone.pk, 'publication_state': 'pending', 'consensus_committed': False}, status=202)

    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'chat_{conversation_id}',
        {'type': 'message_deleted', 'message_id': str(message_id)}
    )
    _gw_broadcast(f'chat_{conversation_id}', {'type': 'message_deleted', 'id': str(message_id)})

    _wipe_files_async(attachment_files)

    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def pin_message(request, message_id):
    try:
        msg = Message.objects.get(id=message_id, conversation__participants=request.user)
    except Message.DoesNotExist:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    _, created = MessagePin.objects.get_or_create(user=request.user, message=msg)
    if not created:
        MessagePin.objects.filter(user=request.user, message=msg).delete()

    is_pinned = created

    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'user_{request.user.id}',
        {'type': 'dm.pin.toggled', 'message_id': str(message_id), 'is_pinned': is_pinned}
    )

    return Response({'is_pinned': is_pinned})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def report_message(request, message_id):
    try:
        msg = Message.objects.get(id=message_id, conversation__participants=request.user)
    except Message.DoesNotExist:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    _, created = MessageReport.objects.get_or_create(reporter=request.user, message=msg)
    return Response({'status': 'reported', 'created': created})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@plaintext_view
def upload_attachment(request, conversation_id):
    try:
        convo = Conversation.objects.get(id=conversation_id, participants=request.user)
    except Conversation.DoesNotExist:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    uploaded = request.FILES.get('file')
    if not uploaded:
        return Response({'error': 'no file provided'}, status=status.HTTP_400_BAD_REQUEST)

    from .mesh_publication import enabled
    upload_limit = min(MAX_UPLOAD_SIZE, 5 * 1024 * 1024) if enabled() else MAX_UPLOAD_SIZE
    if uploaded.size > upload_limit:
        return Response({'error': f'file too large (max {upload_limit // (1024 * 1024)} MB)'}, status=status.HTTP_400_BAD_REQUEST)
    ok, content_type = _safe_upload(uploaded)
    if not ok:
        return Response({'error': 'file type not allowed'}, status=status.HTTP_400_BAD_REQUEST)

    raw = uploaded.read()
    if not _scan_upload(raw):
        return Response({'error': 'file rejected by scanner'}, status=status.HTTP_400_BAD_REQUEST)
    encrypted = encrypt_bytes(raw)

    att = Attachment(
        conversation=convo,
        uploader=request.user,
        original_filename=uploaded.name,
        content_type=content_type,
        file_size=len(raw),
    )
    att.file.save(f'{uuid.uuid4().hex}.enc', ContentFile(encrypted), save=True)

    return Response(AttachmentSerializer(att, context={'request': request}).data, status=status.HTTP_201_CREATED)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def download_attachment(request, attachment_id):
    try:
        att = Attachment.objects.get(id=attachment_id, conversation__participants=request.user)
    except Attachment.DoesNotExist:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    from .mesh_delivery import enabled as delivery_enabled, visible
    if delivery_enabled():
        if not att.message_id and att.uploader_id != request.user.pk:
            return Response({'error': 'not found'}, status=404)
        if att.message_id and att.uploader_id != request.user.pk and not visible(Message.objects.filter(pk=att.message_id)).exists():
            return Response({'error': 'attachment awaiting confirmation'}, status=503)

    mesh_read = bool(getattr(settings, 'SFERA_MESH_MESSAGE_READ_CONFIG', ''))
    if mesh_read and not att.message_id and att.uploader_id != request.user.pk:
        return Response({'error': 'not found'}, status=404)
    mesh_read = mesh_read and att.message_id is not None
    try:
        if mesh_read:
            from .mesh_read import recover_attachment
            decrypted = recover_attachment(att)
            if decrypted is None:
                raise ValueError('message_mesh_read_configuration_required')
        else:
            with att.file.open('rb') as f:
                encrypted = f.read()
            decrypted = decrypt_bytes(encrypted)
    except (ValueError, OSError, InvalidToken, Message.DoesNotExist):
        if mesh_read:
            return Response({'error': 'attachment temporarily unavailable'}, status=503)
        return Response({'error': 'not found'}, status=404)
    if mesh_read:
        # A slow remote read must not retain access after membership was revoked.
        if not Conversation.objects.filter(pk=att.conversation_id, participants=request.user).exists():
            return Response({'error': 'not found'}, status=404)
        if request.auth is not None:
            from sfera_auth.mesh_sessions import require_token
            require_token(request.auth, request.user.pk)

    response = HttpResponse(decrypted, content_type=att.content_type)
    filename = att.original_filename.replace('"', '\\"')
    response['Content-Disposition'] = f'attachment; filename="{filename}"'
    response['Content-Length'] = att.file_size
    response['X-Content-Type-Options'] = 'nosniff'
    return response


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def list_scheduled(request, conversation_id):
    qs = ScheduledMessage.objects.filter(
        conversation_id=conversation_id,
        author=request.user,
        is_sent=False,
    ).order_by('send_at')
    data = [
        {'id': str(m.id), 'send_at': m.send_at.isoformat(), 'content': m.content}
        for m in qs
    ]
    return Response(data)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@plaintext_view
def schedule_message(request, conversation_id):
    try:
        convo = Conversation.objects.get(
            id=conversation_id, participants=request.user
        )
    except Conversation.DoesNotExist:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    content = request.data.get('content', '')
    attachment_ids = request.data.get('attachment_ids', [])
    reply_to_id = request.data.get('reply_to_id')
    delay_seconds = int(request.data.get('delay_seconds', 0))
    try:
        attachment_ids = _claim_dm_attachments(convo, request.user, attachment_ids)
    except ValueError:
        return Response({'error': 'invalid attachment'}, status=status.HTTP_400_BAD_REQUEST)
    reply_to, reply_error = _dm_reply_or_error(convo, reply_to_id)
    if reply_error:
        return reply_error

    if not content and not attachment_ids:
        return Response(
            {'error': 'empty message'}, status=status.HTTP_400_BAD_REQUEST
        )

    send_at = timezone.now() + timedelta(seconds=delay_seconds)

    msg = ScheduledMessage.objects.create(
        conversation=convo,
        author=request.user,
        encrypted_content=encrypt_text(content),
        send_at=send_at,
        reply_to=reply_to,
        attachment_ids=[str(item) for item in attachment_ids],
    )

    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'chat_{conversation_id}',
        {
            'type': 'scheduled_message_queued',
            'scheduled_id': str(msg.id),
            'send_at': send_at.isoformat(),
        },
    )

    return Response(
        {'id': str(msg.id), 'send_at': send_at.isoformat()},
        status=status.HTTP_201_CREATED,
    )


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def cancel_scheduled_message(request, scheduled_id):
    try:
        msg = ScheduledMessage.objects.get(
            id=scheduled_id, author=request.user, is_sent=False
        )
    except ScheduledMessage.DoesNotExist:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    msg.delete()
    return Response(status=status.HTTP_204_NO_CONTENT)


# ─────────────────────────── Guild (server) views ───────────────────────────

@api_view(['POST'])
@permission_classes([IsAuthenticated])
def ws_authorize(request):
    ws_type = request.data.get('type')
    if ws_type == 'mesh_session':
        # Reauthorization of a socket already admitted to its room. The JWT
        # authenticator and BanGuard still enforce device/access revocation.
        return Response({'ok': True})
    if ws_type == 'chat':
        conversation_id = request.data.get('conversation_id')
        try:
            conversation = Conversation.objects.get(id=conversation_id, participants=request.user)
        except (ValueError, Conversation.DoesNotExist):
            return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
        from .mesh_delivery import enabled as delivery_enabled
        from .mesh_history import enabled as history_enabled
        return Response({'ok': True, 'mesh_delivery': delivery_enabled(), 'mesh_history': history_enabled(),
            'cipher_only': conversation.cipher_only,
            'cipher_messages': bool(getattr(settings, 'SFERA_MESH_CIPHER_MESSAGES', False))})

    if ws_type == 'chat_send_check':
        # Gateway asks before relaying a code-like chat message (see code_guard).
        try:
            convo = Conversation.objects.get(id=request.data.get('conversation_id'), participants=request.user)
        except (ValueError, Conversation.DoesNotExist):
            return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
        if convo.cipher_only:
            return Response({'error': 'cipher_conversation_requires_envelope'}, status=409)
        if code_guard.should_block(convo, request.user, str(request.data.get('content') or '')):
            return Response({'error': code_guard.BLOCKED_ERROR}, status=status.HTTP_403_FORBIDDEN)
        return Response({'ok': True})

    # Module sockets proxied by the gateway (e.g. servers: 'guild_channel').
    from sfera_modules import hooks
    for decide in hooks.providers(hooks.WS_AUTHORIZE).values():
        verdict = decide(request.user, ws_type, request.data)
        if verdict is True or isinstance(verdict, dict):
            from .mesh_delivery import enabled as mesh_delivery_enabled
            from .mesh_history import enabled as mesh_history_enabled
            return Response({'ok': True, 'mesh_delivery': mesh_delivery_enabled(), 'mesh_history': mesh_history_enabled(),
                **({key: value for key, value in verdict.items() if key in ('cipher_only', 'cipher_messages') and type(value) is bool} if isinstance(verdict, dict) else {})})
        if verdict is False:
            return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    return Response({'error': 'invalid ws type'}, status=status.HTTP_400_BAD_REQUEST)


@api_view(['GET', 'PUT'])
@permission_classes([IsAuthenticated])
def chat_safety(request):
    """Instance chat safety settings: anyone may read, only the superuser changes them."""
    from .models import ChatSafetySettings

    conf = ChatSafetySettings.get()
    if request.method == 'PUT':
        if not request.user.is_superuser:
            return Response({'error': 'superuser_only'}, status=status.HTTP_403_FORBIDDEN)
        if 'block_all_codes' in request.data:
            conf.block_all_codes = bool(request.data.get('block_all_codes'))
            conf.save()
    return Response({'block_all_codes': conf.block_all_codes, 'can_manage': bool(request.user.is_superuser)})


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def turn_credentials(request):
    """ICE-серверы для звонка. Балансировка: TURN-нода выбирается round-robin из
    пула settings.SFERA_TURN_NODES. Если задан общий секрет — креды временные
    (coturn use-auth-secret), иначе статические. Клиент кэширует ответ на звонок."""
    import base64
    import hashlib
    import hmac
    import random
    import time

    realm = getattr(settings, 'SFERA_TURN_REALM', '') or 'localhost'
    default_port = int(getattr(settings, 'SFERA_TURN_PORT', 3478))
    nodes = [n.strip() for n in getattr(settings, 'SFERA_TURN_NODES', '').split(',') if n.strip()]
    if not nodes:
        nodes = ['%s:%d' % (realm, default_port)]

    host, _, port_s = random.choice(nodes).partition(':')
    port = int(port_s) if port_s else default_port

    secret = getattr(settings, 'SFERA_TURN_SECRET', '')
    if secret:
        ttl = int(getattr(settings, 'SFERA_TURN_TTL', 3600))
        username = '%d:sfera' % (int(time.time()) + ttl)
        credential = base64.b64encode(
            hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()
        ).decode()
    else:
        username = getattr(settings, 'SFERA_TURN_USER', 'sferauser')
        credential = getattr(settings, 'SFERA_TURN_PASS', 'sferaturn123')

    ice_servers = [
        {'urls': 'stun:%s:%d' % (host, port)},
        {
            'urls': [
                'turn:%s:%d?transport=udp' % (host, port),
                'turn:%s:%d?transport=tcp' % (host, port),
            ],
            'username': username,
            'credential': credential,
        },
    ]
    return Response({'iceServers': ice_servers, 'node': host})


# ══════════════════════════════════════════════════════════════════════════════
# Rich messages: polls (guild only), todo checklists, contacts, locations
# ══════════════════════════════════════════════════════════════════════════════

# Polls are deliberately guild-only; DMs get everything else.

_RICH_PREVIEW = {
    MESSAGE_TYPE_POLL: '\U0001F4CA Опрос',
    MESSAGE_TYPE_TODO: '✅ Список дел',
    MESSAGE_TYPE_CONTACT: '\U0001F464 Контакт',
    MESSAGE_TYPE_LOCATION: '\U0001F4CD Геопозиция',
}


def _dm_rich_payload(msg, caption):
    # Shape must match send_message() so the client renders it in the same list.
    return {
        'id': str(msg.id),
        'author': _author_brief(msg.author),
        'content': caption,
        'created_at': msg.created_at.isoformat(),
        'attachments': [],
        'reply_to': None,
        'is_pinned': False,
        'edited': msg.edited,
        **rich_fields(msg, None),
    }


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@plaintext_view
def conversation_rich_send(request, conversation_id):
    """Create a checklist / contact / location message in a DM."""
    from .mesh_delivery import enabled as delivery_enabled
    try:
        convo = Conversation.objects.get(id=conversation_id, participants=request.user)
    except Conversation.DoesNotExist:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    if BlockedUser.objects.filter(
        Q(blocker=request.user, blocked__in=convo.participants.exclude(id=request.user.id)) |
        Q(blocked=request.user, blocker__in=convo.participants.exclude(id=request.user.id))
    ).exists():
        return Response({'error': 'blocked'}, status=status.HTTP_403_FORBIDDEN)

    kind = (request.data.get('type') or '').strip()
    if kind not in DM_RICH_TYPES:
        return Response({'error': 'unsupported type for a direct message'}, status=status.HTTP_400_BAD_REQUEST)
    try:
        payload, live_until = _build_rich(kind, request.data.get('payload') or {})
    except RichError as exc:
        return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

    caption = (request.data.get('content') or '').strip()[:2000]
    msg = Message(
        conversation=convo, author=request.user, message_type=kind,
        live_until=live_until, encrypted_content=encrypt_text(caption),
    )
    msg.payload = payload
    msg.save()

    from .mesh_delivery import enabled as delivery_enabled, pending_payload
    if delivery_enabled():
        return Response(pending_payload(msg), status=202)

    msg_payload = _dm_rich_payload(msg, caption)
    _broadcast_message(f'chat_{conversation_id}', msg_payload)

    notification = {
        'type': 'new_message_notification',
        'sender_id': str(request.user.id),
        'sender_name': (getattr(request.user, 'nickname', '') or request.user.username),
        'content': caption or _RICH_PREVIEW.get(kind, ''),
    }
    channel_layer = get_channel_layer()
    for pid in convo.participants.exclude(id=request.user.id).values_list('id', flat=True):
        async_to_sync(channel_layer.group_send)(
            f'user_{pid}', {'type': 'new.message.notification', 'data': notification}
        )
    return Response(msg_payload, status=status.HTTP_201_CREATED)


# ── Checklist interaction ───────────────────────────────────────────────────

@api_view(['POST'])
@permission_classes([IsAuthenticated])
def dm_todo_toggle(request, message_id):
    from .mesh_delivery import enabled as delivery_enabled
    try:
        msg = Message.objects.get(
            id=message_id, conversation__participants=request.user, message_type=MESSAGE_TYPE_TODO
        )
    except Message.DoesNotExist:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    try:
        _toggle_todo_item(msg, TodoCheck, request.user, request.data.get('item_id'))
    except RichError as exc:
        return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

    if delivery_enabled():
        from .mesh_delivery import pending_payload
        return Response(pending_payload(msg), status=202)
    view = todo_view(Message.objects.prefetch_related('todo_checks__user').get(id=msg.id))
    _broadcast(
        f'chat_{msg.conversation_id}',
        {'type': 'todo_update', 'message_id': str(message_id), 'todo': view},
    )
    return Response({'todo': view})


# ── Live location ───────────────────────────────────────────────────────────

@api_view(['POST'])
@permission_classes([IsAuthenticated])
def dm_location_update(request, message_id):
    """Push a new position for a live-location message, or stop sharing."""
    try:
        msg = Message.objects.get(
            id=message_id, conversation__participants=request.user,
            message_type=MESSAGE_TYPE_LOCATION,
        )
    except Message.DoesNotExist:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    if msg.author_id != request.user.id:
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    try:
        _apply_location_update(msg, request.data, stop=bool(request.data.get('stop')))
    except RichError as exc:
        return Response({'error': str(exc)}, status=status.HTTP_409_CONFLICT)

    from .mesh_delivery import enabled as delivery_enabled, pending_payload
    if delivery_enabled():
        return Response(pending_payload(msg), status=202)

    view = location_view(msg)
    _broadcast(
        f'chat_{msg.conversation_id}',
        {'type': 'location_update', 'message_id': str(message_id), 'location': view},
    )
    return Response({'location': view})
