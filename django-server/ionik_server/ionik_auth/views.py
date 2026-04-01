from django.db.models import Q
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import RefreshToken
from .models import User, Friendship
from .serializers import RegisterSerializer, UserSerializer, FriendshipSerializer


@api_view(['POST'])
@permission_classes([AllowAny])
def register(request):
    serializer = RegisterSerializer(data=request.data)
    if serializer.is_valid():
        user = serializer.save()
        refresh = RefreshToken.for_user(user)
        return Response({
            'user': UserSerializer(user).data,
            'access': str(refresh.access_token),
            'refresh': str(refresh),
        }, status=status.HTTP_201_CREATED)
    return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def me(request):
    return Response(UserSerializer(request.user).data)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def users_list(request):
    users = User.objects.exclude(id=request.user.id)
    return Response(UserSerializer(users, many=True).data)


# ==================== Friends ====================

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def friends_list(request):
    """List accepted friends."""
    friendships = Friendship.objects.filter(
        Q(from_user=request.user) | Q(to_user=request.user),
        status='accepted',
    )
    friends = []
    for f in friendships:
        friend = f.to_user if f.from_user == request.user else f.from_user
        friends.append(friend)
    return Response(UserSerializer(friends, many=True).data)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def friend_request_send(request):
    """Send a friend request to a user by user_id."""
    to_user_id = request.data.get('user_id')
    if not to_user_id:
        return Response({'error': 'user_id required'}, status=status.HTTP_400_BAD_REQUEST)
    try:
        to_user = User.objects.get(id=to_user_id)
    except User.DoesNotExist:
        return Response({'error': 'User not found'}, status=status.HTTP_404_NOT_FOUND)
    if to_user == request.user:
        return Response({'error': 'Cannot add yourself'}, status=status.HTTP_400_BAD_REQUEST)

    existing = Friendship.objects.filter(
        Q(from_user=request.user, to_user=to_user) | Q(from_user=to_user, to_user=request.user)
    ).first()
    if existing:
        if existing.status == 'accepted':
            return Response({'error': 'Already friends'}, status=status.HTTP_400_BAD_REQUEST)
        if existing.status == 'pending':
            return Response({'error': 'Request already pending'}, status=status.HTTP_400_BAD_REQUEST)
        if existing.status == 'rejected':
            existing.status = 'pending'
            existing.from_user = request.user
            existing.to_user = to_user
            existing.save()
            return Response(FriendshipSerializer(existing).data, status=status.HTTP_200_OK)

    friendship = Friendship.objects.create(from_user=request.user, to_user=to_user)
    return Response(FriendshipSerializer(friendship).data, status=status.HTTP_201_CREATED)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def friend_request_accept(request, friendship_id):
    """Accept a pending friend request."""
    try:
        friendship = Friendship.objects.get(id=friendship_id, to_user=request.user, status='pending')
    except Friendship.DoesNotExist:
        return Response({'error': 'Request not found'}, status=status.HTTP_404_NOT_FOUND)
    friendship.status = 'accepted'
    friendship.save()
    return Response(FriendshipSerializer(friendship).data)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def friend_request_reject(request, friendship_id):
    """Reject a pending friend request."""
    try:
        friendship = Friendship.objects.get(id=friendship_id, to_user=request.user, status='pending')
    except Friendship.DoesNotExist:
        return Response({'error': 'Request not found'}, status=status.HTTP_404_NOT_FOUND)
    friendship.status = 'rejected'
    friendship.save()
    return Response(FriendshipSerializer(friendship).data)


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def friend_remove(request, user_id):
    """Remove a friend (delete the friendship)."""
    friendship = Friendship.objects.filter(
        Q(from_user=request.user, to_user_id=user_id) | Q(from_user_id=user_id, to_user=request.user),
        status='accepted',
    ).first()
    if not friendship:
        return Response({'error': 'Friendship not found'}, status=status.HTTP_404_NOT_FOUND)
    friendship.delete()
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def friend_requests_pending(request):
    """List incoming pending friend requests."""
    pending = Friendship.objects.filter(to_user=request.user, status='pending')
    return Response(FriendshipSerializer(pending, many=True).data)
