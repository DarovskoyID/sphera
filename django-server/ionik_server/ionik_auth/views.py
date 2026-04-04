from django.db.models import Q
from rest_framework import status
from rest_framework.decorators import (
    api_view, permission_classes, parser_classes,
)
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import RefreshToken
from .models import User, Friendship, BlockedUser, UserDevice, UserSettings, CustomEmoji
from .serializers import (
    RegisterSerializer, UserSerializer, FriendshipSerializer,
    ProfileUpdateSerializer, BlockedUserSerializer,
    UserDeviceSerializer, UserSettingsSerializer, CustomEmojiSerializer,
)


def get_client_ip(request):
    xff = request.META.get('HTTP_X_FORWARDED_FOR')
    if xff:
        return xff.split(',')[0].strip()
    return request.META.get('REMOTE_ADDR', '0.0.0.0')


def track_device(request):
    user = request.user
    ip = get_client_ip(request)
    ua = request.META.get('HTTP_USER_AGENT', '')

    if 'Mobile' in ua or 'Android' in ua or 'iPhone' in ua:
        dtype = 'mobile'
    elif 'Tablet' in ua or 'iPad' in ua:
        dtype = 'tablet'
    else:
        dtype = 'desktop'

    # Truncate UA for device name
    name = ua[:200] if ua else 'Unknown device'

    device, _ = UserDevice.objects.update_or_create(
        user=user,
        ip_address=ip,
        device_name=name,
        defaults={'device_type': dtype},
    )
    return device


# ==================== Auth ====================

@api_view(['POST'])
@permission_classes([AllowAny])
def register(request):
    serializer = RegisterSerializer(data=request.data)
    if serializer.is_valid():
        user = serializer.save()
        refresh = RefreshToken.for_user(user)
        return Response({
            'user': UserSerializer(
                user, context={'request': request}
            ).data,
            'access': str(refresh.access_token),
            'refresh': str(refresh),
        }, status=status.HTTP_201_CREATED)
    return Response(
        serializer.errors, status=status.HTTP_400_BAD_REQUEST
    )


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def me(request):
    track_device(request)
    return Response(
        UserSerializer(request.user, context={'request': request}).data
    )


@api_view(['PATCH'])
@permission_classes([IsAuthenticated])
@parser_classes([MultiPartParser, FormParser, JSONParser])
def update_profile(request):
    serializer = ProfileUpdateSerializer(
        request.user, data=request.data, partial=True,
    )
    if serializer.is_valid():
        serializer.save()
        return Response(
            UserSerializer(
                request.user, context={'request': request}
            ).data
        )
    return Response(
        serializer.errors, status=status.HTTP_400_BAD_REQUEST
    )


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def delete_account(request):
    username = request.data.get('username', '')
    password = request.data.get('password', '')
    if not username or not password:
        return Response(
            {'error': 'username and password required'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    if request.user.username != username:
        return Response(
            {'error': 'Username does not match'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    if not request.user.check_password(password):
        return Response(
            {'error': 'Password is incorrect'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    request.user.delete()
    return Response({'status': 'deleted'})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def change_password(request):
    old_pw = request.data.get('old_password', '')
    new_pw = request.data.get('new_password', '')
    if not old_pw or not new_pw:
        return Response(
            {'error': 'old_password and new_password required'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    if len(new_pw) < 6:
        return Response(
            {'error': 'Password must be at least 6 characters'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    if not request.user.check_password(old_pw):
        return Response(
            {'error': 'Current password is incorrect'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    request.user.set_password(new_pw)
    request.user.save()
    return Response({'status': 'ok'})


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def users_list(request):
    users = User.objects.exclude(id=request.user.id)
    return Response(
        UserSerializer(
            users, many=True, context={'request': request}
        ).data
    )


# ==================== Friends ====================

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def friends_list(request):
    friendships = Friendship.objects.filter(
        Q(from_user=request.user) | Q(to_user=request.user),
        status='accepted',
    )
    friends = []
    for f in friendships:
        friend = (
            f.to_user if f.from_user == request.user
            else f.from_user
        )
        friends.append(friend)
    return Response(
        UserSerializer(
            friends, many=True, context={'request': request}
        ).data
    )


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def friend_request_send(request):
    to_user_id = request.data.get('user_id')
    if not to_user_id:
        return Response(
            {'error': 'user_id required'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    try:
        to_user = User.objects.get(id=to_user_id)
    except User.DoesNotExist:
        return Response(
            {'error': 'User not found'},
            status=status.HTTP_404_NOT_FOUND,
        )
    if to_user == request.user:
        return Response(
            {'error': 'Cannot add yourself'},
            status=status.HTTP_400_BAD_REQUEST,
        )

    existing = Friendship.objects.filter(
        Q(from_user=request.user, to_user=to_user)
        | Q(from_user=to_user, to_user=request.user)
    ).first()
    if existing:
        if existing.status == 'accepted':
            return Response(
                {'error': 'Already friends'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if existing.status == 'pending':
            return Response(
                {'error': 'Request already pending'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if existing.status == 'rejected':
            existing.status = 'pending'
            existing.from_user = request.user
            existing.to_user = to_user
            existing.save()
            return Response(FriendshipSerializer(
                existing, context={'request': request}
            ).data)

    friendship = Friendship.objects.create(
        from_user=request.user, to_user=to_user,
    )
    return Response(
        FriendshipSerializer(
            friendship, context={'request': request}
        ).data,
        status=status.HTTP_201_CREATED,
    )


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def friend_request_accept(request, friendship_id):
    try:
        friendship = Friendship.objects.get(
            id=friendship_id,
            to_user=request.user,
            status='pending',
        )
    except Friendship.DoesNotExist:
        return Response(
            {'error': 'Request not found'},
            status=status.HTTP_404_NOT_FOUND,
        )
    friendship.status = 'accepted'
    friendship.save()
    return Response(FriendshipSerializer(
        friendship, context={'request': request}
    ).data)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def friend_request_reject(request, friendship_id):
    try:
        friendship = Friendship.objects.get(
            id=friendship_id,
            to_user=request.user,
            status='pending',
        )
    except Friendship.DoesNotExist:
        return Response(
            {'error': 'Request not found'},
            status=status.HTTP_404_NOT_FOUND,
        )
    friendship.status = 'rejected'
    friendship.save()
    return Response(FriendshipSerializer(
        friendship, context={'request': request}
    ).data)


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def friend_remove(request, user_id):
    friendship = Friendship.objects.filter(
        Q(from_user=request.user, to_user_id=user_id)
        | Q(from_user_id=user_id, to_user=request.user),
        status='accepted',
    ).first()
    if not friendship:
        return Response(
            {'error': 'Friendship not found'},
            status=status.HTTP_404_NOT_FOUND,
        )
    friendship.delete()
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def friend_requests_pending(request):
    pending = Friendship.objects.filter(
        to_user=request.user, status='pending',
    )
    return Response(FriendshipSerializer(
        pending, many=True, context={'request': request}
    ).data)


# ==================== Block ====================

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def blocked_list(request):
    blocks = BlockedUser.objects.filter(
        blocker=request.user,
    ).select_related('blocked')
    return Response(BlockedUserSerializer(
        blocks, many=True, context={'request': request}
    ).data)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def block_user(request):
    user_id = request.data.get('user_id')
    if not user_id:
        return Response(
            {'error': 'user_id required'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    try:
        target = User.objects.get(id=user_id)
    except User.DoesNotExist:
        return Response(
            {'error': 'User not found'},
            status=status.HTTP_404_NOT_FOUND,
        )
    if target == request.user:
        return Response(
            {'error': 'Cannot block yourself'},
            status=status.HTTP_400_BAD_REQUEST,
        )

    block, created = BlockedUser.objects.get_or_create(
        blocker=request.user, blocked=target,
    )
    if not created:
        return Response(
            {'error': 'Already blocked'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    return Response(
        BlockedUserSerializer(
            block, context={'request': request}
        ).data,
        status=status.HTTP_201_CREATED,
    )


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def unblock_user(request, user_id):
    deleted, _ = BlockedUser.objects.filter(
        blocker=request.user, blocked_id=user_id,
    ).delete()
    if not deleted:
        return Response(
            {'error': 'Not blocked'},
            status=status.HTTP_404_NOT_FOUND,
        )
    return Response(status=status.HTTP_204_NO_CONTENT)


# ==================== Devices ====================

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def device_list(request):
    devices = request.user.devices.all()
    return Response(
        UserDeviceSerializer(devices, many=True).data
    )


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def device_remove(request, device_id):
    deleted, _ = request.user.devices.filter(id=device_id).delete()
    if not deleted:
        return Response(
            {'error': 'Device not found'},
            status=status.HTTP_404_NOT_FOUND,
        )
    return Response(status=status.HTTP_204_NO_CONTENT)


# ==================== User Settings ====================

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def user_settings_get(request):
    settings, _ = UserSettings.objects.get_or_create(
        user=request.user,
    )
    return Response(UserSettingsSerializer(settings).data)


@api_view(['PATCH'])
@permission_classes([IsAuthenticated])
def user_settings_update(request):
    settings, _ = UserSettings.objects.get_or_create(
        user=request.user,
    )
    serializer = UserSettingsSerializer(
        settings, data=request.data, partial=True,
    )
    if serializer.is_valid():
        serializer.save()
        return Response(serializer.data)
    return Response(
        serializer.errors, status=status.HTTP_400_BAD_REQUEST,
    )


# ==================== Custom Emojis ====================

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def emoji_list(request):
    emojis = CustomEmoji.objects.select_related('created_by').order_by('name')
    return Response(CustomEmojiSerializer(emojis, many=True, context={'request': request}).data)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@parser_classes([MultiPartParser, FormParser])
def emoji_create(request):
    name = request.data.get('name', '').strip().lower()
    image = request.FILES.get('image')
    if not name or not image:
        return Response({'error': 'name and image required'}, status=status.HTTP_400_BAD_REQUEST)
    if not name.replace('_', '').isalnum():
        return Response({'error': 'name must be alphanumeric/underscore only'}, status=status.HTTP_400_BAD_REQUEST)
    if CustomEmoji.objects.filter(name=name).exists():
        return Response({'error': 'name already taken'}, status=status.HTTP_400_BAD_REQUEST)
    emoji = CustomEmoji(name=name, created_by=request.user)
    emoji.image.save(image.name, image, save=True)
    return Response(CustomEmojiSerializer(emoji, context={'request': request}).data, status=status.HTTP_201_CREATED)


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def emoji_delete(request, emoji_id):
    try:
        emoji = CustomEmoji.objects.get(id=emoji_id, created_by=request.user)
    except CustomEmoji.DoesNotExist:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    emoji.image.delete(save=False)
    emoji.delete()
    return Response(status=status.HTTP_204_NO_CONTENT)
