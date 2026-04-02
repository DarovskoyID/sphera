from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework import status
from .models import Conversation, Message
from .serializers import ConversationSerializer, MessageSerializer


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def conversation_list(request):
    convos = request.user.conversations.all().order_by('-created_at')
    return Response(
        ConversationSerializer(
            convos, many=True, context={'request': request}
        ).data
    )


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def conversation_create(request):
    user_id = request.data.get('user_id')
    if not user_id:
        return Response(
            {'error': 'user_id required'},
            status=status.HTTP_400_BAD_REQUEST,
        )

    existing = Conversation.objects.filter(
        participants=request.user
    ).filter(
        participants=user_id
    ).first()

    if existing:
        return Response(
            ConversationSerializer(
                existing, context={'request': request}
            ).data
        )

    convo = Conversation.objects.create()
    convo.participants.add(request.user.id, user_id)
    return Response(
        ConversationSerializer(
            convo, context={'request': request}
        ).data,
        status=status.HTTP_201_CREATED,
    )


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def message_list(request, conversation_id):
    """
    Get messages for a conversation.
    Supports cursor pagination:
      ?before=<msg_id>  — load older messages
      ?limit=50         — number of messages (default 50)
    Returns messages in ascending order (oldest first).
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

    limit = min(int(request.GET.get('limit', 50)), 200)
    before_id = request.GET.get('before')

    qs = convo.messages.order_by('-created_at')
    if before_id:
        qs = qs.filter(id__lt=int(before_id))
    messages = list(qs[:limit])
    messages.reverse()

    return Response(
        MessageSerializer(
            messages, many=True, context={'request': request}
        ).data
    )
