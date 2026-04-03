import uuid
from django.core.files.base import ContentFile
from django.http import HttpResponse
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework import status
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync
from .models import Conversation, Message, Attachment, MessageReport
from .serializers import ConversationSerializer, MessageSerializer, AttachmentSerializer
from .encryption import encrypt_bytes, decrypt_bytes

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
        return Response({'error': 'user_id required'}, status=status.HTTP_400_BAD_REQUEST)

    existing = Conversation.objects.filter(participants=request.user).filter(participants=user_id).first()
    if existing:
        return Response(ConversationSerializer(existing, context={'request': request}).data)

    convo = Conversation.objects.create()
    convo.participants.add(request.user.id, user_id)
    return Response(ConversationSerializer(convo, context={'request': request}).data, status=status.HTTP_201_CREATED)


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
