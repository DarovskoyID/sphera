import uuid
from datetime import timedelta
from django.core.files.base import ContentFile
from django.db.models import Q
from django.http import HttpResponse
from django.utils import timezone
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework import status
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync
from .models import Conversation, Message, Attachment, MessageReport, MessagePin, ScheduledMessage, Guild, GuildMembership, GuildChannel, GuildMessage, GuildAttachment, GuildScheduledMessage, GuildEmoji, GuildSticker, GuildSound, GuildRole, GuildMemberRole, GuildInvite, GuildAuditLog
from .serializers import ConversationSerializer, MessageSerializer, AttachmentSerializer
from .encryption import encrypt_bytes, decrypt_bytes, encrypt_text
from ionik_auth.models import BlockedUser
from .voice_state import _voice_channels

MAX_UPLOAD_SIZE = 50 * 1024 * 1024  # 50 MB


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
    if isinstance(attachment_ids, int):
        attachment_ids = [attachment_ids]

    if not content and not attachment_ids:
        return Response({'error': 'empty message'}, status=status.HTTP_400_BAD_REQUEST)

    msg = Message.objects.create(
        conversation=convo,
        author=request.user,
        encrypted_content=encrypt_text(content),
        reply_to_id=reply_to_id,
    )
    if attachment_ids:
        Attachment.objects.filter(id__in=attachment_ids).update(message=msg)

    attachments_data = []
    if attachment_ids:
        attachments_data = list(
            Attachment.objects.filter(message=msg).values('id', 'original_name', 'size')
        )
        for a in attachments_data:
            a['id'] = str(a['id'])

    reply_to_data = None
    if reply_to_id:
        try:
            rt = Message.objects.select_related('author').get(id=reply_to_id)
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
        except Message.DoesNotExist:
            pass

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


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def delete_message(request, message_id):
    try:
        msg = Message.objects.prefetch_related('attachments').get(id=message_id, author=request.user)
    except Message.DoesNotExist:
        return Response({'error': 'not found or not your message'}, status=status.HTTP_404_NOT_FOUND)

    conversation_id = msg.conversation_id

    # Collect and delete attachment files from disk before cascade-deleting the message
    for att in msg.attachments.all():
        try:
            att.file.delete(save=False)
        except Exception:
            pass

    msg.delete()

    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'chat_{conversation_id}',
        {'type': 'message_deleted', 'message_id': str(message_id)}
    )

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

    raw = uploaded.read()
    encrypted = encrypt_bytes(raw)

    att = Attachment(
        conversation=convo,
        uploader=request.user,
        original_filename=uploaded.name,
        content_type=uploaded.content_type or 'application/octet-stream',
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

    with att.file.open('rb') as f:
        encrypted = f.read()

    decrypted = decrypt_bytes(encrypted)

    response = HttpResponse(decrypted, content_type=att.content_type)
    filename = att.original_filename.replace('"', '\\"')
    response['Content-Disposition'] = f'inline; filename="{filename}"'
    response['Content-Length'] = att.file_size
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
        reply_to_id=reply_to_id,
        attachment_ids=attachment_ids or [],
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
        })
    channels = []
    for ch in guild.channels.all():
        channels.append({
            'id': str(ch.id),
            'name': ch.name,
            'type': ch.channel_type,
            'topic': ch.topic,
            'position': ch.position,
        })
    return {
        'id': str(guild.id),
        'name': guild.name,
        'description': guild.description,
        'tag': guild.tag,
        'icon': guild.icon.url if guild.icon else '',
        'banner': guild.banner.url if guild.banner else '',
        'owner_id': str(guild.owner_id),
        'invite_code': guild.invite_code,
        'boost_level': guild.boost_level,
        'verification_level': guild.verification_level,
        'default_notifications': guild.default_notifications,
        'explicit_content_filter': guild.explicit_content_filter,
        'require_2fa': guild.require_2fa,
        'my_role': membership.role if membership else '',
        'members': members,
        'channels': channels,
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
    guild = Guild.objects.create(name=name, description=request.data.get('description', ''), owner=request.user)
    GuildMembership.objects.create(guild=guild, user=request.user, role='owner')
    # Default channels
    GuildChannel.objects.create(guild=guild, name='general', channel_type='text', position=0)
    GuildChannel.objects.create(guild=guild, name='General', channel_type='voice', position=1)
    return Response(_guild_data(guild, request.user), status=status.HTTP_201_CREATED)


@api_view(['GET', 'PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
def guild_detail(request, guild_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist):
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

    # DELETE — owner only
    if membership.role != 'owner':
        return Response({'error': 'only owner can delete'}, status=status.HTTP_403_FORBIDDEN)
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
    minutes = int(request.data.get('duration_minutes', 5))
    from django.utils import timezone
    target_membership.muted_until = timezone.now() + timedelta(minutes=minutes)
    target_membership.save(update_fields=['muted_until'])
    return Response({'muted_until': target_membership.muted_until.isoformat()})


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
    return Response({'role': new_role})


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def guild_channel_list_create(request, guild_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    if request.method == 'GET':
        channels = [{'id': str(ch.id), 'name': ch.name, 'type': ch.channel_type, 'topic': ch.topic, 'position': ch.position}
                    for ch in guild.channels.all()]
        return Response(channels)

    if membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    name = request.data.get('name', '').strip()
    if not name:
        return Response({'error': 'name required'}, status=status.HTTP_400_BAD_REQUEST)
    ch = GuildChannel.objects.create(
        guild=guild, name=name,
        channel_type=request.data.get('type', 'text'),
        topic=request.data.get('topic', ''),
        position=guild.channels.count(),
    )
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'guild_{guild_id}',
        {'type': 'channel_created', 'channel': {'id': str(ch.id), 'name': ch.name, 'type': ch.channel_type, 'topic': ch.topic, 'position': ch.position}},
    )
    return Response({'id': str(ch.id), 'name': ch.name, 'type': ch.channel_type, 'topic': ch.topic, 'position': ch.position}, status=status.HTTP_201_CREATED)


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def guild_channel_delete(request, guild_id, channel_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        membership = GuildMembership.objects.get(guild=guild, user=request.user)
        ch = GuildChannel.objects.get(id=channel_id, guild=guild)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist, GuildChannel.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    if membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    ch.delete()
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'guild_{guild_id}',
        {'type': 'channel_deleted', 'channel_id': str(channel_id)},
    )
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def guild_channel_messages(request, guild_id, channel_id):
    try:
        guild = Guild.objects.get(id=guild_id)
        GuildMembership.objects.get(guild=guild, user=request.user)
        ch = GuildChannel.objects.get(id=channel_id, guild=guild)
    except (Guild.DoesNotExist, GuildMembership.DoesNotExist, GuildChannel.DoesNotExist):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    limit = min(int(request.GET.get('limit', 50)), 200)
    before_id = request.GET.get('before')
    qs = ch.messages.select_related('author', 'reply_to', 'reply_to__author').prefetch_related('attachments').order_by('-created_at')
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
    msg.delete()
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'guild_channel_{channel_id}',
        {'type': 'message_deleted', 'id': str(message_id)},
    )
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

    raw = uploaded.read()
    encrypted = encrypt_bytes(raw)

    att = GuildAttachment(
        channel=channel,
        uploader=request.user,
        original_filename=uploaded.name,
        content_type=uploaded.content_type or 'application/octet-stream',
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

    with att.file.open('rb') as f:
        encrypted = f.read()
    decrypted = decrypt_bytes(encrypted)

    response = HttpResponse(decrypted, content_type=att.content_type)
    filename = att.original_filename.replace('"', '\\"')
    response['Content-Disposition'] = f'inline; filename="{filename}"'
    response['Content-Length'] = att.file_size
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

    if not content and not attachment_ids:
        return Response({'error': 'content or attachments required'}, status=status.HTTP_400_BAD_REQUEST)

    send_at = timezone.now() + timedelta(seconds=max(5, min(delay_seconds, 86400)))

    sched = GuildScheduledMessage.objects.create(
        channel=channel,
        author=request.user,
        encrypted_content=encrypt_text(content),
        send_at=send_at,
        reply_to_id=reply_to_id,
        attachment_ids=attachment_ids,
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
        return Response({'ok': True})

    GuildMemberRole.objects.filter(membership=target_m, role=role).delete()
    _log(guild, request.user, 'member_role_remove', target_id=str(user_id), target_username=target_m.user.username, details={'role': role.name})
    return Response(status=status.HTTP_204_NO_CONTENT)


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
