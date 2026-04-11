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
from .models import Conversation, Message, Attachment, MessageReport, ScheduledMessage, Guild, GuildMembership, GuildChannel, GuildMessage, GuildAttachment, GuildScheduledMessage
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
        {'type': 'conversation_deleted', 'conversation_id': conversation_id},
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
        qs = qs.filter(id__lt=int(before_id))
    messages = list(qs[:limit])
    messages.reverse()

    return Response(MessageSerializer(messages, many=True, context={'request': request}).data)


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
        {'type': 'message_deleted', 'message_id': message_id}
    )

    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def pin_message(request, message_id):
    try:
        msg = Message.objects.get(id=message_id, conversation__participants=request.user)
    except Message.DoesNotExist:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    msg.is_pinned = not msg.is_pinned
    msg.save(update_fields=['is_pinned'])

    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'chat_{msg.conversation_id}',
        {'type': 'message_pinned', 'message_id': message_id, 'is_pinned': msg.is_pinned}
    )

    return Response({'is_pinned': msg.is_pinned})


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
        {'id': m.id, 'send_at': m.send_at.isoformat(), 'content': m.content}
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
            'scheduled_id': msg.id,
            'send_at': send_at.isoformat(),
        },
    )

    return Response(
        {'id': msg.id, 'send_at': send_at.isoformat()},
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

def _guild_data(guild, user):
    membership = guild.memberships.filter(user=user).first()
    members = []
    for m in guild.memberships.select_related('user').all():
        u = m.user
        members.append({
            'id': str(u.id),
            'username': u.username,
            'nickname': m.nickname or u.nickname or '',
            'avatar': u.avatar.url if u.avatar else '',
            'status': u.status,
            'role': m.role,
        })
    channels = []
    for ch in guild.channels.all():
        channels.append({
            'id': ch.id,
            'name': ch.name,
            'type': ch.channel_type,
            'topic': ch.topic,
            'position': ch.position,
        })
    return {
        'id': guild.id,
        'name': guild.name,
        'description': guild.description,
        'icon': guild.icon.url if guild.icon else '',
        'banner': guild.banner.url if guild.banner else '',
        'owner_id': str(guild.owner_id),
        'invite_code': guild.invite_code,
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
        for field in ('name', 'description'):
            if field in request.data:
                setattr(guild, field, request.data[field])
        guild.save()
        return Response(_guild_data(guild, request.user))

    # DELETE — owner only
    if membership.role != 'owner':
        return Response({'error': 'only owner can delete'}, status=status.HTTP_403_FORBIDDEN)
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'guild_{guild_id}',
        {'type': 'guild_deleted', 'guild_id': guild_id},
    )
    guild.delete()
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def guild_join(request):
    invite_code = request.data.get('invite_code', '').strip()
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
    target_membership.delete()
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'guild_{guild_id}',
        {'type': 'member_kicked', 'user_id': str(user_id), 'guild_name': guild.name},
    )
    # Delete guild if no members remain
    if not GuildMembership.objects.filter(guild=guild).exists():
        guild.delete()
    return Response(status=status.HTTP_204_NO_CONTENT)


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
        channels = [{'id': ch.id, 'name': ch.name, 'type': ch.channel_type, 'topic': ch.topic, 'position': ch.position}
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
        {'type': 'channel_created', 'channel': {'id': ch.id, 'name': ch.name, 'type': ch.channel_type, 'topic': ch.topic, 'position': ch.position}},
    )
    return Response({'id': ch.id, 'name': ch.name, 'type': ch.channel_type, 'topic': ch.topic, 'position': ch.position}, status=status.HTTP_201_CREATED)


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
        {'type': 'channel_deleted', 'channel_id': channel_id},
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
        qs = qs.filter(id__lt=int(before_id))
    msgs = list(qs[:limit])
    msgs.reverse()

    def serialize(m):
        return {
            'id': m.id,
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
                'id': m.reply_to.id,
                'content': m.reply_to.content,
                'author': {'id': str(m.reply_to.author.id), 'username': m.reply_to.author.username},
            } if m.reply_to else None,
            'attachments': [
                {
                    'id': att.id,
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
        {'type': 'message_deleted', 'id': message_id},
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
        {'type': 'message_pinned', 'id': message_id, 'is_pinned': msg.is_pinned},
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
        'id': att.id,
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
        {'type': 'guild_scheduled_queued', 'scheduled_id': sched.id, 'send_at': send_at.isoformat()},
    )

    return Response({'id': sched.id, 'send_at': send_at.isoformat()}, status=status.HTTP_201_CREATED)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def guild_voice_presence(request, guild_id):
    """Return current voice channel participants for all voice channels in a guild."""
    try:
        GuildMembership.objects.get(guild_id=guild_id, user=request.user)
    except GuildMembership.DoesNotExist:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    result = {}
    for ch_id, ch_data in _voice_channels.items():
        if ch_data.get('_guild_id') != guild_id:
            continue
        members = [v for k, v in ch_data.items() if k != '_guild_id']
        if members:
            result[ch_id] = members

    return Response(result)
