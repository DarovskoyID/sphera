import uuid
import os
import shlex
import subprocess
import tempfile
import threading
from datetime import timedelta
from django.conf import settings
from django.core.files.base import ContentFile
from django.db.models import Q, Count
from django.http import HttpResponse
from django.utils import timezone
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework import status
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync
from .models import Conversation, Message, Attachment, MessageReport, MessagePin, ScheduledMessage, Guild, GuildMembership, GuildChannel, GuildCategory, GuildMessage, GuildAttachment, GuildScheduledMessage, GuildEmoji, GuildSticker, GuildSound, GuildRole, GuildMemberRole, GuildInvite, GuildAuditLog, GuildMessageReaction, GuildMessageView, GuildPostComment
from .serializers import ConversationSerializer, MessageSerializer, AttachmentSerializer
from .encryption import encrypt_bytes, decrypt_bytes, encrypt_text
from ionik_auth.models import BlockedUser
from .voice_state import _voice_channels

MAX_UPLOAD_SIZE = 50 * 1024 * 1024  # 50 MB
MAX_ATTACHMENTS_PER_MESSAGE = 15
BLOCKED_UPLOAD_TYPES = {
    'application/javascript',
    'application/x-javascript',
    'image/svg+xml',
    'text/html',
    'text/javascript',
}
BLOCKED_UPLOAD_EXTENSIONS = {
    '.bat', '.cmd', '.com', '.exe', '.hta', '.html', '.js', '.jse',
    '.msi', '.ps1', '.scr', '.svg', '.vbs', '.wsf',
}


def _id_list(value):
    if value in (None, ''):
        return []
    if isinstance(value, (str, int)):
        value = [value]
    if not isinstance(value, list) or len(value) > MAX_ATTACHMENTS_PER_MESSAGE:
        raise ValueError('invalid attachment list')
    result = []
    for item in value:
        try:
            result.append(uuid.UUID(str(item)))
        except (TypeError, ValueError) as exc:
            raise ValueError('invalid attachment id') from exc
    return result


def _safe_upload(uploaded):
    content_type = (uploaded.content_type or 'application/octet-stream').split(';', 1)[0].lower()
    if content_type in BLOCKED_UPLOAD_TYPES:
        return False, content_type
    ext = os.path.splitext(uploaded.name or '')[1].lower()
    if ext in BLOCKED_UPLOAD_EXTENSIONS:
        return False, content_type
    return True, content_type


def _scan_upload(raw):
    command = getattr(settings, 'UPLOAD_SCAN_COMMAND', '')
    if not command:
        return True
    with tempfile.NamedTemporaryFile(delete=True) as tmp:
        tmp.write(raw)
        tmp.flush()
        argv = shlex.split(command) + [tmp.name]
        return subprocess.run(argv, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def _dm_reply_or_error(convo, reply_to_id):
    if not reply_to_id:
        return None, None
    try:
        return Message.objects.get(id=reply_to_id, conversation=convo), None
    except (ValueError, Message.DoesNotExist):
        return None, Response({'error': 'invalid reply target'}, status=status.HTTP_400_BAD_REQUEST)


def _guild_reply_or_error(channel, reply_to_id):
    if not reply_to_id:
        return None, None
    try:
        return GuildMessage.objects.get(id=reply_to_id, channel=channel), None
    except (ValueError, GuildMessage.DoesNotExist):
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


def _claim_guild_attachments(channel, user, attachment_ids, msg=None):
    ids = _id_list(attachment_ids)
    if not ids:
        return []
    qs = GuildAttachment.objects.filter(
        id__in=ids,
        channel=channel,
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
    return Response(ConversationSerializer(convos, many=True, context={'request': request}).data)


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
        return Response(data)

    if blocked_by_other:
        # No existing conversation and blocked — nothing to show
        return Response({'error': 'blocked'}, status=status.HTTP_403_FORBIDDEN)

    convo = Conversation.objects.create()
    convo.participants.add(request.user.id, user_id)
    data = ConversationSerializer(convo, context={'request': request}).data
    data['blocked_by_other'] = False
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

    limit = min(int(request.GET.get('limit', 50)), 200)
    before_id = request.GET.get('before')

    qs = convo.messages.select_related('author', 'reply_to', 'reply_to__author').prefetch_related('attachments').order_by('-created_at')
    if before_id:
        try:
            anchor = convo.messages.get(id=before_id)
            qs = qs.filter(created_at__lt=anchor.created_at)
        except convo.messages.model.DoesNotExist:
            pass
    messages = list(qs[:limit])
    messages.reverse()

    pinned_ids = set(
        MessagePin.objects.filter(user=request.user, message__in=messages).values_list('message_id', flat=True)
    )

    return Response(MessageSerializer(messages, many=True, context={'request': request, 'pinned_ids': pinned_ids}).data)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def send_message(request, conversation_id):
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

    msg = Message.objects.create(
        conversation=convo,
        author=request.user,
        encrypted_content=encrypt_text(content),
        reply_to=reply_to,
    )
    if attachment_ids:
        _claim_dm_attachments(convo, request.user, attachment_ids, msg)

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
    }

    msg_payload = {
        'id': str(msg.id),
        'author': user_data,
        'content': content,
        'created_at': msg.created_at.isoformat(),
        'attachments': attachments_data,
        'reply_to': reply_to_data,
        'is_pinned': False,
    }

    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'chat_{conversation_id}',
        {'type': 'chat_message', 'message': msg_payload},
    )

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
    for pid in other_ids:
        async_to_sync(channel_layer.group_send)(
            f'user_{pid}',
            {'type': 'new.message.notification', 'data': notification},
        )

    return Response(msg_payload, status=status.HTTP_201_CREATED)


def _wipe_files_async(file_fields):
    """Delete storage files off the request path so a delete returns instantly
    and the realtime broadcast isn't blocked on (potentially large) disk I/O."""
    def _run():
        for f in file_fields:
            try:
                f.delete(save=False)
            except Exception:
                pass
    if file_fields:
        threading.Thread(target=_run, daemon=True).start()


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def delete_message(request, message_id):
    try:
        msg = Message.objects.prefetch_related('attachments').get(id=message_id, author=request.user)
    except Message.DoesNotExist:
        return Response({'error': 'not found or not your message'}, status=status.HTTP_404_NOT_FOUND)

    conversation_id = msg.conversation_id

    # Capture the attachment files, then drop the row and broadcast immediately;
    # the actual disk cleanup happens in the background (see _wipe_files_async).
    attachment_files = [att.file for att in msg.attachments.all() if att.file]

    msg.delete()

    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'chat_{conversation_id}',
        {'type': 'message_deleted', 'message_id': str(message_id)}
    )

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
def upload_attachment(request, conversation_id):
    try:
        convo = Conversation.objects.get(id=conversation_id, participants=request.user)
    except Conversation.DoesNotExist:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    uploaded = request.FILES.get('file')
    if not uploaded:
        return Response({'error': 'no file provided'}, status=status.HTTP_400_BAD_REQUEST)

    if uploaded.size > MAX_UPLOAD_SIZE:
        return Response({'error': 'file too large (max 50 MB)'}, status=status.HTTP_400_BAD_REQUEST)
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

    try:
        with att.file.open('rb') as f:
            encrypted = f.read()
    except FileNotFoundError:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    decrypted = decrypt_bytes(encrypted)

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
    if ws_type == 'chat':
        conversation_id = request.data.get('conversation_id')
        try:
            Conversation.objects.get(id=conversation_id, participants=request.user)
        except (ValueError, Conversation.DoesNotExist):
            return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
        return Response({'ok': True})

    if ws_type == 'guild_channel':
        guild_id = request.data.get('guild_id')
        channel_id = request.data.get('channel_id')
        try:
            GuildChannel.objects.get(id=channel_id, guild_id=guild_id)
            GuildMembership.objects.get(guild_id=guild_id, user=request.user)
        except (ValueError, GuildChannel.DoesNotExist, GuildMembership.DoesNotExist):
            return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
        return Response({'ok': True})

    return Response({'error': 'invalid ws type'}, status=status.HTTP_400_BAD_REQUEST)


def _log(guild, actor, action, target_id='', target_username='', details=None):
    GuildAuditLog.objects.create(
        guild=guild, action=action,
        actor_id=str(actor.id), actor_username=actor.username,
        target_id=target_id, target_username=target_username,
        details=details or {},
    )


def _guild_data(guild, user):
    membership = guild.memberships.filter(user=user).first()
    members = []
    for m in guild.memberships.select_related('user').prefetch_related('custom_role_assignments').all():
        u = m.user
        members.append({
            'id': str(u.id),
            'username': u.username,
            'nickname': m.nickname or u.nickname or '',
            'avatar': u.avatar.url if u.avatar else '',
            'status': u.status,
            'role': m.role,
            'custom_roles': [str(r.role_id) for r in m.custom_role_assignments.all()],
            'muted_until': m.muted_until.isoformat() if m.muted_until and m.muted_until > timezone.now() else None,
        })
    channels = []
    for ch in guild.channels.all():
        channels.append({
            'id': str(ch.id),
            'name': ch.name,
            'type': ch.channel_type,
            'topic': ch.topic,
            'position': ch.position,
            'category_id': str(ch.category_id) if ch.category_id else None,
            'user_limit': ch.user_limit,
        })
    categories = []
    for cat in guild.categories.all():
        categories.append({
            'id': str(cat.id),
            'name': cat.name,
            'position': cat.position,
        })
    return {
        'id': str(guild.id),
        'name': guild.name,
        'description': guild.description,
        'tag': guild.tag,
        'tags': guild.tags or [],
        'icon': guild.icon.url if guild.icon else '',
        'banner': guild.banner.url if guild.banner else '',
        'owner_id': str(guild.owner_id),
        'invite_code': guild.invite_code,
        'boost_level': guild.boost_level,
        'verification_level': guild.verification_level,
        'default_notifications': guild.default_notifications,
        'explicit_content_filter': guild.explicit_content_filter,
        'require_2fa': guild.require_2fa,
        'is_discoverable': guild.is_discoverable,
        'is_personal_channel': guild.is_personal_channel,
        'comments_enabled': guild.comments_enabled,
        'my_role': membership.role if membership else '',
        'my_muted_until': membership.muted_until.isoformat() if membership and membership.muted_until and membership.muted_until > timezone.now() else None,
        'my_notifications_muted': membership.notifications_muted if membership else False,
        'members': members,
        'channels': channels,
        'categories': categories,
    }


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def guild_list_create(request):
    if request.method == 'GET':
        memberships = GuildMembership.objects.filter(user=request.user).select_related('guild')
        guilds = [_guild_data(m.guild, request.user) for m in memberships]
        return Response(guilds)

    # POST — create guild
    name = request.data.get('name', '').strip()
    if not name:
        return Response({'error': 'name required'}, status=status.HTTP_400_BAD_REQUEST)
    is_personal = bool(request.data.get('is_personal_channel', False))
    guild = Guild.objects.create(
        name=name, description=request.data.get('description', ''),
        owner=request.user, is_personal_channel=is_personal,
    )
    GuildMembership.objects.create(guild=guild, user=request.user, role='owner')
    if is_personal:
        GuildChannel.objects.create(guild=guild, name='feed', channel_type='text', position=0)
    else:
        GuildChannel.objects.create(guild=guild, name='general', channel_type='text', position=0)
        GuildChannel.objects.create(guild=guild, name='General', channel_type='voice', position=1)
    return Response(_guild_data(guild, request.user), status=status.HTTP_201_CREATED)


import re as _re

_FTS_AVAILABLE = None  # lazily detected once per process


def _fts_ready():
    """Detect whether the SQLite FTS5 'guild_fts' table exists (cached per process)."""
    global _FTS_AVAILABLE
    if _FTS_AVAILABLE is not None:
        return _FTS_AVAILABLE
    from django.db import connection
    if connection.vendor != 'sqlite':
        _FTS_AVAILABLE = False
        return False
    try:
        with connection.cursor() as cur:
            cur.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='guild_fts'")
            _FTS_AVAILABLE = cur.fetchone() is not None
    except Exception:
        _FTS_AVAILABLE = False
    return _FTS_AVAILABLE


def _fts_search_ids(terms):
    """Return guild ids matching all terms via FTS5 prefix search, or None on failure."""
    if not _fts_ready():
        return None
    # Keep only safe word characters, then require every term as a prefix (implicit AND).
    cleaned = [_re.sub(r'[^\w]', '', t) for t in terms]
    cleaned = [t for t in cleaned if t]
    if not cleaned:
        return None
    match = ' '.join(f'{t}*' for t in cleaned)
    from django.db import connection
    try:
        with connection.cursor() as cur:
            cur.execute(
                "SELECT guild_id FROM guild_fts WHERE guild_fts MATCH %s LIMIT 300",
                [match],
            )
            return [row[0] for row in cur.fetchall()]
    except Exception:
        return None


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def guild_explore(request):
    from django.core.cache import cache

    search = request.query_params.get('q', '').strip()[:80]
    my_guild_ids = set(GuildMembership.objects.filter(user=request.user).values_list('guild_id', flat=True))

    # Fetch only the columns we serialize — avoids hauling full rows from a huge table.
    base = (
        Guild.objects.filter(is_discoverable=True)
        .annotate(member_count=Count('memberships'))
        .order_by('-member_count')
        .only('id', 'name', 'description', 'icon', 'banner', 'invite_code', 'tags', 'tag', 'is_personal_channel')
    )

    def serialize(g):
        return {
            'id': str(g.id),
            'name': g.name,
            'description': g.description,
            'icon': g.icon.url if g.icon else '',
            'banner': g.banner.url if g.banner else '',
            'member_count': g.member_count,
            'invite_code': g.invite_code,
            'tags': g.tags or [],
            'is_personal_channel': g.is_personal_channel,
        }

    mine = {str(i) for i in my_guild_ids}

    # Keep guilds/channels the user already belongs to in the results (marked
    # is_member) so they remain findable — the UI shows "you're already here"
    # instead of a join button. is_member is applied per-user, after the shared
    # cache, so it never gets baked into the cached payload.
    def with_membership(rows):
        return [{**r, 'is_member': r['id'] in mine} for r in rows]

    # ── No query → cached popular list (dominates traffic) ───────────────────
    if not search:
        cache_key = 'guild_explore_popular_v2'
        cached = cache.get(cache_key)
        if cached is None:
            cached = [serialize(g) for g in base[:100]]
            cache.set(cache_key, cached, 30)
        return Response(with_membership(cached))

    # ── Search → cache results per normalized query (shared via Redis) ───────
    norm = ' '.join(search.lower().split())
    cache_key = f'guild_explore_q:{norm}'
    cached = cache.get(cache_key)
    if cached is not None:
        return Response(with_membership(cached))

    if search.startswith('#'):
        tag_q = search[1:].strip()
        qs = base.filter(tags__icontains=tag_q) if tag_q else base
        guilds = list(qs[:50])
    else:
        terms = [t for t in search.split() if t][:5]
        ids = _fts_search_ids(terms)
        # Use FTS only when it actually returns hits. An empty result (common for
        # Cyrillic prefix matches the FTS tokenizer can't handle) must fall through
        # to the LIKE search rather than yielding "no servers found".
        if ids:
            # FTS5 path — order the matched ids by popularity.
            qs = base.filter(id__in=ids)
            guilds = list(qs[:50])
        else:
            # Fallback: LIKE across fields, every term must match.
            cond = Q()
            for term in terms:
                cond &= (
                    Q(name__icontains=term) | Q(description__icontains=term)
                    | Q(tag__icontains=term) | Q(tags__icontains=term)
                )
            guilds = list((base.filter(cond) if terms else base)[:50])

    result = [serialize(g) for g in guilds]
    cache.set(cache_key, result, 15)
    return Response(with_membership(result))


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def search_messages_view(request):
    """Full-text search across channel posts and server messages.

    Returns messages from guilds the user is a member of, plus posts in publicly
    discoverable channels — so authors' #hashtags surface both the post and channel.
    """
    from .search_index import search_messages

    query = request.query_params.get('q', '').strip()[:80]
    if not query:
        return Response([])

    hits = search_messages(query, limit=120)
    if not hits:
        return Response([])

    # Only ~120 hits — resolve visibility against this small guild set, not the whole DB.
    hit_guild_ids = {h[1] for h in hits}
    member_ids = set(
        str(g) for g in GuildMembership.objects.filter(
            user=request.user, guild_id__in=hit_guild_ids
        ).values_list('guild_id', flat=True)
    )
    discoverable_ids = set(
        str(g) for g in Guild.objects.filter(
            id__in=hit_guild_ids, is_discoverable=True
        ).values_list('id', flat=True)
    )
    # Global discovery search must only surface content from guilds/channels that
    # opted into discovery. A channel that hid itself (is_discoverable=False) must
    # not leak its posts here, even to members/followers.
    visible = discoverable_ids

    ordered_ids = [h[0] for h in hits if h[1] in visible][:30]
    if not ordered_ids:
        return Response([])

    msgs = {
        str(m.id): m for m in GuildMessage.objects
        .filter(id__in=ordered_ids)
        .select_related('author', 'channel', 'channel__guild')
    }

    result = []
    for mid in ordered_ids:
        m = msgs.get(mid)
        if not m:
            continue
        g = m.channel.guild
        result.append({
            'id': str(m.id),
            'content': (m.content or '')[:200],
            'created_at': m.created_at.isoformat(),
            'channel': {'id': str(m.channel_id), 'name': m.channel.name},
            'guild': {
                'id': str(g.id),
                'name': g.name,
                'icon': g.icon.url if g.icon else '',
                'is_personal_channel': g.is_personal_channel,
                'is_member': str(g.id) in member_ids,
                'invite_code': g.invite_code,
            },
            'author': {'username': m.author.username, 'nickname': m.author.nickname or ''},
        })
    return Response(result)


@api_view(['GET', 'PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
def guild_detail(request, guild_id):
    try:
        guild = Guild.objects.get(id=guild_id)
    except Guild.DoesNotExist:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    membership = GuildMembership.objects.filter(guild=guild, user=request.user).first()
    # Non-members may READ a discoverable guild/channel (preview before subscribing).
    if membership is None and not (request.method == 'GET' and guild.is_discoverable):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    if request.method == 'GET':
        return Response(_guild_data(guild, request.user))

    if request.method == 'PATCH':
        if membership.role not in ('owner', 'admin'):
            return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
        for field in ('name', 'description', 'tag', 'verification_level', 'default_notifications', 'explicit_content_filter'):
            if field in request.data:
                setattr(guild, field, request.data[field])
        if 'boost_level' in request.data and membership.role == 'owner':
            guild.boost_level = int(request.data['boost_level'])
        if 'require_2fa' in request.data and membership.role == 'owner':
            guild.require_2fa = request.data['require_2fa'] in (True, 'true', '1')
        if 'is_discoverable' in request.data:
            guild.is_discoverable = request.data['is_discoverable'] in (True, 'true', '1')
        if 'comments_enabled' in request.data:
            guild.comments_enabled = request.data['comments_enabled'] in (True, 'true', '1')
        if 'tags' in request.data:
            raw = request.data['tags']
            if isinstance(raw, str):
                import json as _json
                try:
                    raw = _json.loads(raw)
                except Exception:
                    raw = [t.strip() for t in raw.split(',') if t.strip()]
            guild.tags = [t[:24] for t in raw[:10]] if isinstance(raw, list) else []
        if 'icon' in request.FILES:
            if guild.icon:
                guild.icon.delete(save=False)
            guild.icon = request.FILES['icon']
        if 'banner' in request.FILES:
            if guild.banner:
                guild.banner.delete(save=False)
            guild.banner = request.FILES['banner']
        if request.data.get('remove_icon') == 'true' and guild.icon:
            guild.icon.delete(save=False)
            guild.icon = None
        if request.data.get('remove_banner') == 'true' and guild.banner:
            guild.banner.delete(save=False)
            guild.banner = None
        guild.save()
        _log(guild, request.user, 'guild_update', details={'name': guild.name})
        return Response(_guild_data(guild, request.user))

    # DELETE — owner only, password-confirmed
    if membership.role != 'owner':
        return Response({'error': 'only owner can delete'}, status=status.HTTP_403_FORBIDDEN)
    password = request.data.get('password', '')
    if not password or not request.user.check_password(password):
        return Response({'error': 'invalid password'}, status=status.HTTP_403_FORBIDDEN)
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'guild_{guild_id}',
        {'type': 'guild_deleted', 'guild_id': str(guild_id)},
    )
    guild.delete()
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def guild_join(request):
    invite_code = request.data.get('invite_code', '').strip()
    # Check GuildInvite table first, then fall back to Guild.invite_code
    custom_invite = None
    try:
        custom_invite = GuildInvite.objects.select_related('guild').get(code=invite_code, is_active=True)
        if custom_invite.expires_at and custom_invite.expires_at < timezone.now():
            custom_invite.is_active = False
            custom_invite.save()
            return Response({'error': 'invite expired'}, status=status.HTTP_400_BAD_REQUEST)
        if custom_invite.max_uses and custom_invite.uses >= custom_invite.max_uses:
            custom_invite.is_active = False
            custom_invite.save()
            return Response({'error': 'invite has reached max uses'}, status=status.HTTP_400_BAD_REQUEST)
        guild = custom_invite.guild
    except GuildInvite.DoesNotExist:
        try:
            guild = Guild.objects.get(invite_code=invite_code)
        except Guild.DoesNotExist:
            return Response({'error': 'invalid invite code'}, status=status.HTTP_404_NOT_FOUND)

    # Check if any current member has blocked the joiner or vice versa
    member_ids = GuildMembership.objects.filter(guild=guild).values_list('user_id', flat=True)
    blocked_exists = BlockedUser.objects.filter(
        Q(blocker=request.user, blocked_id__in=member_ids) |
        Q(blocker_id__in=member_ids, blocked=request.user)
    ).exists()
    if blocked_exists:
        return Response({'error': 'You cannot join this server'}, status=status.HTTP_403_FORBIDDEN)

    membership, created = GuildMembership.objects.get_or_create(guild=guild, user=request.user, defaults={'role': 'member'})
    if custom_invite and created:
        custom_invite.uses += 1
        custom_invite.save()
    # Notify guild members
    channel_layer = get_channel_layer()
    u = request.user
    async_to_sync(channel_layer.group_send)(
        f'guild_{guild.id}',
        {
            'type': 'member_joined',
            'member': {
                'id': str(u.id), 'username': u.username,
                'nickname': membership.nickname or u.nickname or '',
                'avatar': u.avatar.url if u.avatar else '',
                'status': u.status, 'role': membership.role,
            },
        },
    )
    return Response(_guild_data(guild, request.user), status=status.HTTP_200_OK if not created else status.HTTP_201_CREATED)


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def guild_leave(request, guild_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    if membership.role == 'owner':
        return Response({'error': 'owner cannot leave — transfer ownership or delete the guild'}, status=status.HTTP_400_BAD_REQUEST)
    membership.delete()
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'guild_{guild_id}',
        {'type': 'member_left', 'user_id': str(request.user.id)},
    )
    # Delete guild if no members remain
    if not GuildMembership.objects.filter(guild=guild).exists():
        guild.delete()
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def guild_kick(request, guild_id, user_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        my_membership = GuildMembership.objects.get(guild=guild, user=request.user)
        target_membership = GuildMembership.objects.get(guild=guild, user_id=user_id)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    # Only owner/admin can kick
    if my_membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    # Nobody can kick the owner
    if target_membership.role == 'owner':
        return Response({'error': 'cannot kick the owner'}, status=status.HTTP_403_FORBIDDEN)
    # Admin cannot kick another admin
    if my_membership.role == 'admin' and target_membership.role == 'admin':
        return Response({'error': 'admins cannot kick other admins'}, status=status.HTTP_403_FORBIDDEN)
    target_username = target_membership.user.username
    target_membership.delete()
    _log(guild, request.user, 'member_kick', target_id=str(user_id), target_username=target_username)
    channel_layer = get_channel_layer()
    kick_payload = {'type': 'member_kicked', 'user_id': str(user_id), 'guild_name': guild.name}
    # Broadcast to all guild members who are browsing any channel
    async_to_sync(channel_layer.group_send)(f'guild_{guild_id}', kick_payload)
    # Also notify the kicked user directly via their signaling WS (covers the case
    # where they are not currently browsing a channel in this guild)
    async_to_sync(channel_layer.group_send)(
        f'user_{user_id}',
        {'type': 'guild.kicked', 'user_id': str(user_id), 'guild_name': guild.name, 'guild_id': str(guild_id)},
    )
    # Delete guild if no members remain
    if not GuildMembership.objects.filter(guild=guild).exists():
        guild.delete()
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def guild_mute_member(request, guild_id, user_id):
    from datetime import timedelta
    try:
        guild = Guild.objects.get(id=guild_id)
        my_membership = GuildMembership.objects.get(guild=guild, user=request.user)
        target_membership = GuildMembership.objects.get(guild=guild, user_id=user_id)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    if my_membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    if target_membership.role == 'owner':
        return Response({'error': 'cannot mute the owner'}, status=status.HTTP_403_FORBIDDEN)
    if my_membership.role == 'admin' and target_membership.role == 'admin':
        return Response({'error': 'admins cannot mute other admins'}, status=status.HTTP_403_FORBIDDEN)
    minutes = int(request.data.get('duration_minutes', 0))
    if minutes > 0:
        target_membership.muted_until = timezone.now() + timedelta(minutes=minutes)
    else:
        target_membership.muted_until = None
    target_membership.save(update_fields=['muted_until'])
    muted_until_iso = target_membership.muted_until.isoformat() if target_membership.muted_until else None
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(f'guild_{guild_id}', {
        'type': 'member_muted',
        'user_id': str(user_id),
        'muted_until': muted_until_iso,
    })
    return Response({'muted_until': muted_until_iso})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def guild_set_role(request, guild_id, user_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        my_membership = GuildMembership.objects.get(guild=guild, user=request.user)
        target_membership = GuildMembership.objects.get(guild=guild, user_id=user_id)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    if my_membership.role != 'owner':
        return Response({'error': 'only owner can change roles'}, status=status.HTTP_403_FORBIDDEN)
    new_role = request.data.get('role')
    if new_role not in ('admin', 'member'):
        return Response({'error': 'role must be admin or member'}, status=status.HTTP_400_BAD_REQUEST)
    target_membership.role = new_role
    target_membership.save(update_fields=['role'])
    _log(guild, request.user, 'member_role_set', target_id=str(user_id), target_username=target_membership.user.username, details={'role': new_role})
    # Broadcast so the promoted/demoted member (and everyone viewing the guild)
    # sees the new role live, without needing a page refresh.
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(f'guild_{guild_id}', {
        'type': 'member_role_changed',
        'user_id': str(user_id),
        'role': new_role,
    })
    return Response({'role': new_role})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def guild_toggle_notifications(request, guild_id):
    try:
        membership = GuildMembership.objects.get(guild_id=guild_id, user=request.user)
    except GuildMembership.DoesNotExist:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    membership.notifications_muted = not membership.notifications_muted
    membership.save(update_fields=['notifications_muted'])
    return Response({'notifications_muted': membership.notifications_muted})


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def guild_channel_list_create(request, guild_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    if request.method == 'GET':
        channels = [{'id': str(ch.id), 'name': ch.name, 'type': ch.channel_type, 'topic': ch.topic, 'position': ch.position, 'user_limit': ch.user_limit}
                    for ch in guild.channels.all()]
        return Response(channels)

    if membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    name = request.data.get('name', '').strip()
    if not name:
        return Response({'error': 'name required'}, status=status.HTTP_400_BAD_REQUEST)
    category_id = request.data.get('category_id')
    category = None
    if category_id:
        try:
            category = GuildCategory.objects.get(id=category_id, guild=guild)
        except GuildCategory.DoesNotExist:
            pass
    ch = GuildChannel.objects.create(
        guild=guild, name=name,
        channel_type=request.data.get('type', 'text'),
        topic=request.data.get('topic', ''),
        position=guild.channels.count(),
        category=category,
    )
    ch_data = {'id': str(ch.id), 'name': ch.name, 'type': ch.channel_type, 'topic': ch.topic, 'position': ch.position, 'category_id': str(ch.category_id) if ch.category_id else None, 'user_limit': ch.user_limit}
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'guild_{guild_id}',
        {'type': 'channel_created', 'channel': ch_data},
    )
    _log(guild, request.user, 'channel_create', details={'name': ch.name, 'type': ch.channel_type})
    return Response(ch_data, status=status.HTTP_201_CREATED)


@api_view(['PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
def guild_channel_detail(request, guild_id, channel_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
        ch = GuildChannel.objects.get(id=channel_id, guild=guild)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist, GuildChannel.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    if membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)

    if request.method == 'DELETE':
        ch_name = ch.name
        ch.delete()
        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f'guild_{guild_id}',
            {'type': 'channel_deleted', 'channel_id': str(channel_id)},
        )
        _log(guild, request.user, 'channel_delete', details={'name': ch_name})
        return Response(status=status.HTTP_204_NO_CONTENT)

    if 'user_limit' in request.data:
        ch.user_limit = max(0, min(99, int(request.data['user_limit'])))
    if 'name' in request.data:
        ch.name = request.data['name'].strip() or ch.name
    ch.save()
    ch_data = {'id': str(ch.id), 'name': ch.name, 'type': ch.channel_type, 'topic': ch.topic, 'position': ch.position, 'category_id': str(ch.category_id) if ch.category_id else None, 'user_limit': ch.user_limit}
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'guild_{guild_id}',
        {'type': 'channel_updated', 'channel': ch_data},
    )
    return Response(ch_data)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def guild_category_create(request, guild_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    if membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    name = request.data.get('name', '').strip()
    if not name:
        return Response({'error': 'name required'}, status=status.HTTP_400_BAD_REQUEST)
    cat = GuildCategory.objects.create(guild=guild, name=name, position=guild.categories.count())
    cat_data = {'id': str(cat.id), 'name': cat.name, 'position': cat.position}
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'guild_{guild_id}',
        {'type': 'category_created', 'category': cat_data},
    )
    _log(guild, request.user, 'category_create', details={'name': name})
    return Response(cat_data, status=status.HTTP_201_CREATED)


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def guild_category_delete(request, guild_id, category_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
        cat = GuildCategory.objects.get(id=category_id, guild=guild)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist, GuildCategory.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    if membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    cat_name = cat.name
    cat.channels.update(category=None)
    cat.delete()
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'guild_{guild_id}',
        {'type': 'category_deleted', 'category_id': str(category_id)},
    )
    _log(guild, request.user, 'category_delete', details={'name': cat_name})
    return Response(status=status.HTTP_204_NO_CONTENT)


def _aggregate_reactions(reactions_qs, current_user):
    from collections import defaultdict
    grouped = defaultdict(lambda: {'count': 0, 'me': False})
    for r in reactions_qs:
        grouped[r.emoji]['count'] += 1
        if r.user_id == current_user.id:
            grouped[r.emoji]['me'] = True
    return [{'emoji': k, 'count': v['count'], 'me': v['me']} for k, v in grouped.items()]


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def guild_channel_messages(request, guild_id, channel_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        ch = GuildChannel.objects.get(id=channel_id, guild=guild)
    except (Guild.DoesNotExist, GuildChannel.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    # Members can read; non-members can read a discoverable channel (preview).
    if not GuildMembership.objects.filter(guild=guild, user=request.user).exists() and not guild.is_discoverable:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    limit = min(int(request.GET.get('limit', 50)), 200)
    before_id = request.GET.get('before')
    qs = ch.messages.select_related('author', 'reply_to', 'reply_to__author').prefetch_related('attachments', 'reactions', 'views', 'comments').order_by('-created_at')
    if before_id:
        try:
            anchor = ch.messages.get(id=before_id)
            qs = qs.filter(created_at__lt=anchor.created_at)
        except ch.messages.model.DoesNotExist:
            pass
    msgs = list(qs[:limit])
    msgs.reverse()

    def serialize(m):
        return {
            'id': str(m.id),
            'author': {
                'id': str(m.author.id),
                'username': m.author.username,
                'nickname': m.author.nickname or '',
                'avatar': m.author.avatar.url if m.author.avatar else '',
                'status': m.author.status,
            },
            'content': m.content,
            'created_at': m.created_at.isoformat(),
            'is_pinned': m.is_pinned,
            'reply_to': {
                'id': str(m.reply_to.id),
                'content': m.reply_to.content,
                'author': {'id': str(m.reply_to.author.id), 'username': m.reply_to.author.username},
            } if m.reply_to else None,
            'attachments': [
                {
                    'id': str(att.id),
                    'filename': att.original_filename,
                    'content_type': att.content_type,
                    'file_size': att.file_size,
                    'url': f'/api/guild-attachments/{att.id}/',
                }
                for att in m.attachments.all()
            ],
            'reactions': _aggregate_reactions(m.reactions.all(), request.user),
            'views': len(m.views.all()),
            'comments_count': len(m.comments.all()),
        }

    return Response([serialize(m) for m in msgs])


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def guild_message_delete(request, guild_id, message_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
        msg = GuildMessage.objects.get(id=message_id, channel__guild=guild)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist, GuildMessage.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    if msg.author != request.user and membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    channel_id = msg.channel_id
    # Capture attachment files, then delete + broadcast immediately and wipe the
    # files off the request path (attachment.message is SET_NULL, so without this
    # the files would leak on disk).
    attachment_files = [att.file for att in msg.attachments.all() if att.file]
    msg.delete()
    from .search_index import unindex_message
    unindex_message(message_id)
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'guild_channel_{channel_id}',
        {'type': 'message_deleted', 'id': str(message_id)},
    )
    _wipe_files_async(attachment_files)
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def guild_message_pin(request, guild_id, message_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        GuildMembership.objects.get(guild=guild, user=request.user)
        msg = GuildMessage.objects.get(id=message_id, channel__guild=guild)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist, GuildMessage.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    msg.is_pinned = not msg.is_pinned
    msg.save(update_fields=['is_pinned'])
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'guild_channel_{msg.channel_id}',
        {'type': 'message_pinned', 'id': str(message_id), 'is_pinned': msg.is_pinned},
    )
    return Response({'is_pinned': msg.is_pinned})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def guild_upload_attachment(request, guild_id, channel_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        GuildMembership.objects.get(guild=guild, user=request.user)
        channel = GuildChannel.objects.get(id=channel_id, guild=guild)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist, GuildChannel.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    uploaded = request.FILES.get('file')
    if not uploaded:
        return Response({'error': 'no file provided'}, status=status.HTTP_400_BAD_REQUEST)
    if uploaded.size > MAX_UPLOAD_SIZE:
        return Response({'error': 'file too large (max 50 MB)'}, status=status.HTTP_400_BAD_REQUEST)
    ok, content_type = _safe_upload(uploaded)
    if not ok:
        return Response({'error': 'file type not allowed'}, status=status.HTTP_400_BAD_REQUEST)

    raw = uploaded.read()
    if not _scan_upload(raw):
        return Response({'error': 'file rejected by scanner'}, status=status.HTTP_400_BAD_REQUEST)
    encrypted = encrypt_bytes(raw)

    att = GuildAttachment(
        channel=channel,
        uploader=request.user,
        original_filename=uploaded.name,
        content_type=content_type,
        file_size=len(raw),
    )
    att.file.save(f'{uuid.uuid4().hex}.enc', ContentFile(encrypted), save=True)

    return Response({
        'id': str(att.id),
        'filename': att.original_filename,
        'content_type': att.content_type,
        'file_size': att.file_size,
        'url': f'/api/guild-attachments/{att.id}/',
    }, status=status.HTTP_201_CREATED)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def guild_download_attachment(request, attachment_id):
    try:
        att = GuildAttachment.objects.select_related('channel__guild').get(id=attachment_id)
        GuildMembership.objects.get(guild=att.channel.guild, user=request.user)
    except (GuildAttachment.DoesNotExist, GuildMembership.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    try:
        with att.file.open('rb') as f:
            encrypted = f.read()
    except FileNotFoundError:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    decrypted = decrypt_bytes(encrypted)

    response = HttpResponse(decrypted, content_type=att.content_type)
    filename = att.original_filename.replace('"', '\\"')
    response['Content-Disposition'] = f'attachment; filename="{filename}"'
    response['Content-Length'] = att.file_size
    response['X-Content-Type-Options'] = 'nosniff'
    return response


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def guild_schedule_message(request, guild_id, channel_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        GuildMembership.objects.get(guild=guild, user=request.user)
        channel = GuildChannel.objects.get(id=channel_id, guild=guild)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist, GuildChannel.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    content = request.data.get('content', '').strip()
    delay_seconds = int(request.data.get('delay_seconds', 60))
    attachment_ids = request.data.get('attachment_ids', [])
    reply_to_id = request.data.get('reply_to_id')
    try:
        attachment_ids = _claim_guild_attachments(channel, request.user, attachment_ids)
    except ValueError:
        return Response({'error': 'invalid attachment'}, status=status.HTTP_400_BAD_REQUEST)
    reply_to, reply_error = _guild_reply_or_error(channel, reply_to_id)
    if reply_error:
        return reply_error

    if not content and not attachment_ids:
        return Response({'error': 'content or attachments required'}, status=status.HTTP_400_BAD_REQUEST)

    send_at = timezone.now() + timedelta(seconds=max(5, min(delay_seconds, 86400)))

    sched = GuildScheduledMessage.objects.create(
        channel=channel,
        author=request.user,
        encrypted_content=encrypt_text(content),
        send_at=send_at,
        reply_to=reply_to,
        attachment_ids=[str(item) for item in attachment_ids],
    )

    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'guild_channel_{channel_id}',
        {'type': 'guild_scheduled_queued', 'scheduled_id': str(sched.id), 'send_at': send_at.isoformat()},
    )

    return Response({'id': str(sched.id), 'send_at': send_at.isoformat()}, status=status.HTTP_201_CREATED)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def guild_voice_presence(request, guild_id):
    """Return current voice channel participants for all voice channels in a guild."""
    try:
        GuildMembership.objects.get(guild_id=guild_id, user=request.user)
    except GuildMembership.DoesNotExist:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    guild_id_str = str(guild_id)
    result = {}
    for ch_id, ch_data in _voice_channels.items():
        if ch_data.get('_guild_id') != guild_id_str:
            continue
        members = [v for k, v in ch_data.items() if k != '_guild_id']
        if members:
            result[str(ch_id)] = members

    return Response(result)


# ── Emoji ─────────────────────────────────────────────────────────────────────
@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def guild_emojis(request, guild_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    if request.method == 'GET':
        return Response([{'id': str(e.id), 'name': e.name, 'image': e.image.url} for e in guild.emojis.all()])

    if membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    name = request.data.get('name', '').strip()
    if not name or 'image' not in request.FILES:
        return Response({'error': 'name and image required'}, status=status.HTTP_400_BAD_REQUEST)
    emoji = GuildEmoji.objects.create(guild=guild, name=name, image=request.FILES['image'], uploader=request.user)
    _log(guild, request.user, 'emoji_create', details={'name': name})
    return Response({'id': str(emoji.id), 'name': emoji.name, 'image': emoji.image.url}, status=status.HTTP_201_CREATED)


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def guild_emoji_delete(request, guild_id, emoji_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
        emoji = GuildEmoji.objects.get(id=emoji_id, guild=guild)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist, GuildEmoji.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    if membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    _log(guild, request.user, 'emoji_delete', details={'name': emoji.name})
    emoji.image.delete(save=False)
    emoji.delete()
    return Response(status=status.HTTP_204_NO_CONTENT)


# ── Stickers ──────────────────────────────────────────────────────────────────
@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def guild_stickers(request, guild_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    if request.method == 'GET':
        return Response([{'id': str(s.id), 'name': s.name, 'description': s.description, 'image': s.image.url} for s in guild.stickers.all()])

    if membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    name = request.data.get('name', '').strip()
    if not name or 'image' not in request.FILES:
        return Response({'error': 'name and image required'}, status=status.HTTP_400_BAD_REQUEST)
    sticker = GuildSticker.objects.create(
        guild=guild, name=name, description=request.data.get('description', ''),
        image=request.FILES['image'], uploader=request.user,
    )
    _log(guild, request.user, 'sticker_create', details={'name': name})
    return Response({'id': str(sticker.id), 'name': sticker.name, 'description': sticker.description, 'image': sticker.image.url}, status=status.HTTP_201_CREATED)


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def guild_sticker_delete(request, guild_id, sticker_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
        sticker = GuildSticker.objects.get(id=sticker_id, guild=guild)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist, GuildSticker.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    if membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    _log(guild, request.user, 'sticker_delete', details={'name': sticker.name})
    sticker.image.delete(save=False)
    sticker.delete()
    return Response(status=status.HTTP_204_NO_CONTENT)


# ── Sounds ────────────────────────────────────────────────────────────────────
@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def guild_sounds(request, guild_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    if request.method == 'GET':
        return Response([{'id': str(s.id), 'name': s.name, 'url': s.file.url} for s in guild.sounds.all()])

    if membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    name = request.data.get('name', '').strip()
    if not name or 'file' not in request.FILES:
        return Response({'error': 'name and file required'}, status=status.HTTP_400_BAD_REQUEST)
    sound = GuildSound.objects.create(guild=guild, name=name, file=request.FILES['file'], uploader=request.user)
    _log(guild, request.user, 'sound_create', details={'name': name})
    return Response({'id': str(sound.id), 'name': sound.name, 'url': sound.file.url}, status=status.HTTP_201_CREATED)


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def guild_sound_delete(request, guild_id, sound_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
        sound = GuildSound.objects.get(id=sound_id, guild=guild)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist, GuildSound.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    if membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    _log(guild, request.user, 'sound_delete', details={'name': sound.name})
    sound.file.delete(save=False)
    sound.delete()
    return Response(status=status.HTTP_204_NO_CONTENT)


# ── Roles ─────────────────────────────────────────────────────────────────────
@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def guild_roles(request, guild_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    if request.method == 'GET':
        return Response([{'id': str(r.id), 'name': r.name, 'color': r.color, 'permissions': r.permissions, 'position': r.position} for r in guild.custom_roles.all()])

    if membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    name = request.data.get('name', '').strip()
    if not name:
        return Response({'error': 'name required'}, status=status.HTTP_400_BAD_REQUEST)
    role = GuildRole.objects.create(
        guild=guild, name=name,
        color=request.data.get('color', '#99aab5'),
        permissions=request.data.get('permissions', []),
        position=guild.custom_roles.count(),
    )
    _log(guild, request.user, 'role_create', details={'name': name})
    return Response({'id': str(role.id), 'name': role.name, 'color': role.color, 'permissions': role.permissions, 'position': role.position}, status=status.HTTP_201_CREATED)


@api_view(['PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
def guild_role_detail(request, guild_id, role_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
        role = GuildRole.objects.get(id=role_id, guild=guild)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist, GuildRole.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    if membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)

    if request.method == 'PATCH':
        for field in ('name', 'color', 'permissions', 'position'):
            if field in request.data:
                setattr(role, field, request.data[field])
        role.save()
        _log(guild, request.user, 'role_update', details={'name': role.name})
        return Response({'id': str(role.id), 'name': role.name, 'color': role.color, 'permissions': role.permissions, 'position': role.position})

    _log(guild, request.user, 'role_delete', details={'name': role.name})
    role.delete()
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['POST', 'DELETE'])
@permission_classes([IsAuthenticated])
def guild_member_role(request, guild_id, user_id, role_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
        target_m = GuildMembership.objects.get(guild=guild, user_id=user_id)
        role = GuildRole.objects.get(id=role_id, guild=guild)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist, GuildRole.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    if membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)

    if request.method == 'POST':
        GuildMemberRole.objects.get_or_create(membership=target_m, role=role)
        _log(guild, request.user, 'member_role_assign', target_id=str(user_id), target_username=target_m.user.username, details={'role': role.name})
    else:
        GuildMemberRole.objects.filter(membership=target_m, role=role).delete()
        _log(guild, request.user, 'member_role_remove', target_id=str(user_id), target_username=target_m.user.username, details={'role': role.name})

    custom_roles = [str(r.role_id) for r in target_m.custom_role_assignments.all()]
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(f'guild_{guild_id}', {
        'type': 'member_roles_changed',
        'user_id': str(user_id),
        'custom_roles': custom_roles,
    })
    return Response({'ok': True} if request.method == 'POST' else {'ok': True}, status=200)


# ── Invites ───────────────────────────────────────────────────────────────────
@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def guild_invites(request, guild_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    if membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)

    if request.method == 'GET':
        invites = guild.invites.filter(is_active=True).select_related('creator')
        return Response([{
            'id': str(i.id), 'code': i.code,
            'creator': {'id': str(i.creator.id), 'username': i.creator.username} if i.creator else None,
            'max_uses': i.max_uses, 'uses': i.uses,
            'expires_at': i.expires_at.isoformat() if i.expires_at else None,
            'created_at': i.created_at.isoformat(),
        } for i in invites])

    import secrets as _s
    from datetime import timedelta as _td
    expires_hours = request.data.get('expires_hours')
    max_uses = request.data.get('max_uses')
    invite = GuildInvite.objects.create(
        guild=guild, creator=request.user,
        max_uses=int(max_uses) if max_uses else None,
        expires_at=timezone.now() + _td(hours=int(expires_hours)) if expires_hours else None,
    )
    _log(guild, request.user, 'invite_create', details={'code': invite.code})
    return Response({
        'id': str(invite.id), 'code': invite.code,
        'creator': {'id': str(request.user.id), 'username': request.user.username},
        'max_uses': invite.max_uses, 'uses': invite.uses,
        'expires_at': invite.expires_at.isoformat() if invite.expires_at else None,
        'created_at': invite.created_at.isoformat(),
    }, status=status.HTTP_201_CREATED)


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def guild_invite_revoke(request, guild_id, invite_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
        invite = GuildInvite.objects.get(id=invite_id, guild=guild)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist, GuildInvite.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    if membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    invite.is_active = False
    invite.save()
    _log(guild, request.user, 'invite_revoke', details={'code': invite.code})
    return Response(status=status.HTTP_204_NO_CONTENT)


# ── Audit log ─────────────────────────────────────────────────────────────────
@api_view(['GET'])
@permission_classes([IsAuthenticated])
def guild_audit_log(request, guild_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    if membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    logs = guild.audit_logs.all()[:100]
    return Response([{
        'id': str(lg.id), 'action': lg.action,
        'actor': {'id': lg.actor_id, 'username': lg.actor_username},
        'target': {'id': lg.target_id, 'username': lg.target_username} if lg.target_id else None,
        'details': lg.details,
        'created_at': lg.created_at.isoformat(),
    } for lg in logs])


# ── Reactions ───────────────────────────────────���──────────────────────────��─
@api_view(['POST'])
@permission_classes([IsAuthenticated])
def guild_message_reaction(request, guild_id, message_id):
    emoji = request.data.get('emoji', '').strip()
    if not emoji:
        return Response({'error': 'emoji required'}, status=status.HTTP_400_BAD_REQUEST)
    try:
        guild = Guild.objects.get(id=guild_id)
        GuildMembership.objects.get(guild=guild, user=request.user)
        msg = GuildMessage.objects.get(id=message_id, channel__guild=guild)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist, GuildMessage.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    existing = GuildMessageReaction.objects.filter(message=msg, user=request.user)
    same = existing.filter(emoji=emoji).first()
    if same:
        # Toggling off an existing reaction is always allowed.
        same.delete()
        added = False
    else:
        # Adding a new reaction — cap each user at 3 distinct reactions per message.
        if existing.count() >= 3:
            return Response(
                {'error': 'reaction limit reached', 'detail': 'Можно поставить не более 3 реакций'},
                status=status.HTTP_409_CONFLICT,
            )
        GuildMessageReaction.objects.create(message=msg, user=request.user, emoji=emoji)
        added = True

    reactions = _aggregate_reactions(msg.reactions.all(), request.user)
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'guild_channel_{msg.channel_id}',
        {'type': 'reaction_update', 'message_id': str(message_id), 'reactions': reactions},
    )
    return Response({'added': added, 'reactions': reactions})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def guild_message_view(request, guild_id, message_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        msg = GuildMessage.objects.get(id=message_id, channel__guild=guild)
    except (Guild.DoesNotExist, GuildMessage.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    # Only members record a view. Non-members (e.g. a guild the user left but the
    # client still has open) get a harmless 200 no-op instead of a 404 — otherwise
    # the client retries per-message and floods the console/logs.
    if GuildMembership.objects.filter(guild=guild, user=request.user).exists():
        GuildMessageView.objects.get_or_create(message=msg, user=request.user)
    return Response({'views': msg.views.count()})


# ── Post comments ─────────────────────────────────────────────────────────────
def _comment_data(c, server_ip_unused=None):
    return {
        'id': str(c.id),
        'author': {
            'id': str(c.author.id),
            'username': c.author.username,
            'nickname': c.author.nickname or '',
            'avatar': c.author.avatar.url if c.author.avatar else '',
        },
        'content': c.content,
        'created_at': c.created_at.isoformat(),
    }


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def guild_message_comments(request, guild_id, message_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        GuildMembership.objects.get(guild=guild, user=request.user)
        msg = GuildMessage.objects.get(id=message_id, channel__guild=guild)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist, GuildMessage.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    if request.method == 'GET':
        comments = msg.comments.select_related('author').all()
        return Response([_comment_data(c) for c in comments])

    # POST — add comment
    if not guild.comments_enabled:
        return Response({'error': 'comments disabled'}, status=status.HTTP_403_FORBIDDEN)
    content = (request.data.get('content') or '').strip()
    if not content:
        return Response({'error': 'content required'}, status=status.HTTP_400_BAD_REQUEST)
    comment = GuildPostComment(message=msg, author=request.user)
    comment.content = content[:2000]
    comment.save()
    return Response(_comment_data(comment), status=status.HTTP_201_CREATED)


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def guild_comment_delete(request, guild_id, comment_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        GuildMembership.objects.get(guild=guild, user=request.user)
        comment = GuildPostComment.objects.get(id=comment_id, message__channel__guild=guild)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist, GuildPostComment.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    # Only the comment's own author may delete it — not even the channel owner.
    if comment.author != request.user:
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    comment.delete()
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def turn_credentials(request):
    """ICE-серверы для звонка. Балансировка: TURN-нода выбирается round-robin из
    пула settings.IONIK_TURN_NODES. Если задан общий секрет — креды временные
    (coturn use-auth-secret), иначе статические. Клиент кэширует ответ на звонок."""
    import base64
    import hashlib
    import hmac
    import random
    import time

    realm = getattr(settings, 'IONIK_TURN_REALM', '') or 'localhost'
    default_port = int(getattr(settings, 'IONIK_TURN_PORT', 3478))
    nodes = [n.strip() for n in getattr(settings, 'IONIK_TURN_NODES', '').split(',') if n.strip()]
    if not nodes:
        nodes = ['%s:%d' % (realm, default_port)]

    host, _, port_s = random.choice(nodes).partition(':')
    port = int(port_s) if port_s else default_port

    secret = getattr(settings, 'IONIK_TURN_SECRET', '')
    if secret:
        ttl = int(getattr(settings, 'IONIK_TURN_TTL', 3600))
        username = '%d:ionik' % (int(time.time()) + ttl)
        credential = base64.b64encode(
            hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()
        ).decode()
    else:
        username = getattr(settings, 'IONIK_TURN_USER', 'ionikuser')
        credential = getattr(settings, 'IONIK_TURN_PASS', 'ionikturn123')

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
