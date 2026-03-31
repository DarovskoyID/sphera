from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework import status
from .models import Conversation, Message
from .serializers import ConversationSerializer, MessageSerializer


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def conversation_list(request):
    """List all conversations for the current user."""
    convos = request.user.conversations.all().order_by('-created_at')
    return Response(ConversationSerializer(convos, many=True).data)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def conversation_create(request):
    """Create or get existing DM conversation with another user."""
    user_id = request.data.get('user_id')
    if not user_id:
        return Response({'error': 'user_id required'}, status=status.HTTP_400_BAD_REQUEST)

    # Check if DM conversation already exists between these two users
    existing = Conversation.objects.filter(
        participants=request.user
    ).filter(
        participants=user_id
    ).first()

    if existing:
        return Response(ConversationSerializer(existing).data)

    convo = Conversation.objects.create()
    convo.participants.add(request.user.id, user_id)
    return Response(ConversationSerializer(convo).data, status=status.HTTP_201_CREATED)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def message_list(request, conversation_id):
    """Get message history for a conversation (paginated)."""
    try:
        convo = Conversation.objects.get(id=conversation_id, participants=request.user)
    except Conversation.DoesNotExist:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    messages = convo.messages.order_by('-created_at')[:50]
    return Response(MessageSerializer(messages[::-1], many=True).data)
