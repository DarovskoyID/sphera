import json
import secrets
import threading
from datetime import datetime, timedelta, timezone as dt_timezone

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings as django_settings
from django.core.files.base import ContentFile
from django.core.mail import send_mail
from django.core.validators import validate_email
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import connection
from django.db.models import Q
from django.http import FileResponse, Http404
from django.utils import timezone
from django.contrib.auth.password_validation import validate_password
from rest_framework import status
from rest_framework.decorators import (
    api_view, permission_classes, parser_classes, throttle_classes,
)
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.settings import api_settings
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer, TokenRefreshSerializer
from rest_framework_simplejwt.tokens import RefreshToken


class AuthRateThrottle(AnonRateThrottle):
    """Tight, IP-keyed limit for credential / account-sensitive endpoints."""
    scope = 'auth'
from .models import (
    User, Friendship, BlockedUser, UserDevice, UserSettings, CustomEmoji,
    FcmToken, DataExport, EmailVerificationCode, SecurityAuditLog,
    is_child, enforce_child_settings,
)
from .serializers import (
    RegisterSerializer, UserSerializer, MeSerializer, FriendshipSerializer,
    ProfileSerializer, ProfileUpdateSerializer, BlockedUserSerializer,
    UserDeviceSerializer, UserSettingsSerializer, CustomEmojiSerializer,
)


def get_client_ip(request):
    xff = request.META.get('HTTP_X_FORWARDED_FOR')
    if xff:
        return xff.split(',')[0].strip()
    return request.META.get('REMOTE_ADDR', '0.0.0.0')


def audit_event(request, event, user=None, metadata=None):
    try:
        actor = user or getattr(request, 'user', None)
        if not actor or getattr(actor, 'is_anonymous', True):
            actor = None
        SecurityAuditLog.objects.create(
            user=actor,
            event=event,
            ip_address=get_client_ip(request),
            user_agent=request.META.get('HTTP_USER_AGENT', '')[:2000],
            metadata=metadata or {},
        )
    except Exception:
        pass


def _device_type_from_ua(ua):
    # iPad/Android tablets first (Android tablets lack the "Mobile" token).
    if 'iPad' in ua or 'Tablet' in ua or ('Android' in ua and 'Mobile' not in ua):
        return 'tablet'
    if 'Mobile' in ua or 'Android' in ua or 'iPhone' in ua or 'iPod' in ua:
        return 'mobile'
    return 'desktop'


def _device_name_from_ua(ua):
    if not ua:
        return 'Unknown device'
    # Browser
    if 'Electron' in ua:
        browser = 'Sfera Desktop'
    elif 'Edg' in ua:
        browser = 'Edge'
    elif 'OPR' in ua or 'Opera' in ua:
        browser = 'Opera'
    elif 'SamsungBrowser' in ua:
        browser = 'Samsung Internet'
    elif 'Firefox' in ua or 'FxiOS' in ua:
        browser = 'Firefox'
    elif 'CriOS' in ua or 'Chrome' in ua or 'Chromium' in ua:
        browser = 'Chrome'
    elif 'Safari' in ua:
        browser = 'Safari'
    else:
        browser = 'Browser'
    # OS
    if 'Windows' in ua:
        os_name = 'Windows'
    elif 'Android' in ua:
        os_name = 'Android'
    elif 'iPhone' in ua or 'iPod' in ua:
        os_name = 'iOS'
    elif 'iPad' in ua:
        os_name = 'iPadOS'
    elif 'Mac OS' in ua or 'Macintosh' in ua:
        os_name = 'macOS'
    elif 'CrOS' in ua:
        os_name = 'ChromeOS'
    elif 'Linux' in ua:
        os_name = 'Linux'
    else:
        os_name = 'Unknown OS'
    return f'{browser} on {os_name}'


def track_device(request):
    user = request.user
    ip = get_client_ip(request)
    ua = request.META.get('HTTP_USER_AGENT', '')

    # The client reports an accurate id/name/type via query params (headers
    # would trigger a CORS preflight); fall back to UA parsing.
    device_id = (request.GET.get('device_id') or request.META.get('HTTP_X_DEVICE_ID', '') or '').strip()[:128]
    client_name = (request.GET.get('device_name') or request.META.get('HTTP_X_DEVICE_NAME', '') or '').strip()
    client_type = (request.GET.get('device_type') or request.META.get('HTTP_X_DEVICE_TYPE', '') or '').strip()

    dtype = client_type if client_type in ('mobile', 'tablet', 'desktop') else _device_type_from_ua(ua)
    name = (client_name[:200] if client_name else _device_name_from_ua(ua))

    # Prefer the stable device id; only fall back to IP when none was sent.
    if device_id:
        device, created = UserDevice.objects.get_or_create(
            user=user,
            device_id=device_id,
            defaults={'device_name': name, 'device_type': dtype, 'ip_address': ip},
        )
        if not created:
            UserDevice.objects.filter(pk=device.pk).update(
                device_name=name, device_type=dtype, ip_address=ip,
            )
    else:
        device, created = UserDevice.objects.get_or_create(
            user=user,
            ip_address=ip,
            defaults={'device_name': name, 'device_type': dtype},
        )
        if not created:
            UserDevice.objects.filter(pk=device.pk).update(
                device_name=name, device_type=dtype,
            )

    # A genuinely new device — but not the account's very first one, which is
    # just the sign-up itself — is worth telling the owner about, in case it
    # is not them.
    if created and user.devices.exclude(pk=device.pk).exists():
        try:
            _notify_new_login(user, name, ip)
        except Exception:
            pass
    return device


def _notify_new_login(user, device_name, ip):
    """Email the account owner that a new device just signed in."""
    email = getattr(user, 'email', '') or ''
    if not email:
        return
    when = timezone.now().strftime('%d.%m.%Y %H:%M UTC')
    subject = 'Сфера — новый вход в аккаунт'
    body = (
        f'Здравствуйте, {user.username}!\n\n'
        f'В ваш аккаунт в Сфере только что вошли с нового устройства:\n\n'
        f'  Устройство: {device_name}\n'
        f'  IP-адрес: {ip}\n'
        f'  Время: {when}\n\n'
        f'Если это были вы — всё в порядке, письмо можно проигнорировать.\n'
        f'Если это были не вы — смените пароль и завершите все сеансы '
        f'в настройках безопасности как можно скорее.'
    )
    send_mail(
        subject,
        body,
        getattr(django_settings, 'DEFAULT_FROM_EMAIL', None),
        [email],
        fail_silently=True,
    )


# ==================== Auth ====================

# Code alphabet: digits + uppercase letters, minus the visually ambiguous ones
# (0/O, 1/I) so a code copied from an email is hard to mistype.
_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
_CODE_LENGTH = 6


def is_app_request(request):
    """Is this the native shell rather than a browser?

    The shells append a product token to the WebView's user agent — see
    docs/ANDROID_WEBVIEW.md. Nothing security-critical hangs on the answer: it
    only chooses between two session lifetimes, both of which end on sign-out,
    a password change or a revoked device. A browser that forged the token
    would get a session that does not idle out, which is the same thing the
    user gets by installing the app.
    """
    agent = request.META.get('HTTP_USER_AGENT', '')
    return django_settings.APP_USER_AGENT_TOKEN in agent


def _session_lifetime(request):
    if is_app_request(request):
        return django_settings.APP_REFRESH_TOKEN_LIFETIME
    return django_settings.SIMPLE_JWT['REFRESH_TOKEN_LIFETIME']


def _with_session_lifetime(refresh, request):
    """Restamp a refresh token's expiry for the client that asked for it.

    Both the login serializer and the rotation on refresh mint tokens with the
    lifetime from SIMPLE_JWT, which is the browser's. Re-stamping keeps the jti
    and the rest of the payload — so blacklisting still recognises the token —
    and only moves `exp`.

    The matching OutstandingToken row is moved with it. Revoking every session
    for a user works by walking those rows, and `flushexpiredtokens` deletes
    the ones that have passed their recorded expiry: leaving an app token's row
    stamped a day and a half out would quietly drop it from the register while
    the token itself stayed valid for years, and a password change would no
    longer sign the phone out.
    """
    lifetime = _session_lifetime(request)
    refresh.set_exp(lifetime=lifetime)

    try:
        from rest_framework_simplejwt.token_blacklist.models import OutstandingToken
        OutstandingToken.objects.filter(jti=refresh.payload[api_settings.JTI_CLAIM]).update(
            token=str(refresh),
            expires_at=datetime.fromtimestamp(refresh.payload['exp'], tz=dt_timezone.utc),
        )
    except Exception:
        # The register is a convenience for revocation, not the token's
        # validity. Failing to update it must not fail the sign-in.
        pass

    return refresh


def _set_refresh_cookie(response, refresh, request):
    response.set_cookie(
        django_settings.REFRESH_COOKIE_NAME,
        str(refresh),
        max_age=int(_session_lifetime(request).total_seconds()),
        httponly=True,
        secure=django_settings.REFRESH_COOKIE_SECURE,
        samesite=django_settings.REFRESH_COOKIE_SAMESITE,
        path=django_settings.REFRESH_COOKIE_PATH,
    )


def _clear_refresh_cookie(response):
    response.delete_cookie(
        django_settings.REFRESH_COOKIE_NAME,
        path=django_settings.REFRESH_COOKIE_PATH,
        samesite=django_settings.REFRESH_COOKIE_SAMESITE,
    )


def _blacklist_user_refresh_tokens(user):
    try:
        from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
        for token in OutstandingToken.objects.filter(user=user):
            BlacklistedToken.objects.get_or_create(token=token)
    except Exception:
        pass


def _auth_response(user, refresh, request, status_code=status.HTTP_200_OK):
    _with_session_lifetime(refresh, request)
    response = Response({
        'user': UserSerializer(user, context={'request': request}).data,
        'access': str(refresh.access_token),
    }, status=status_code)
    _set_refresh_cookie(response, refresh, request)
    return response


def _generate_code():
    return ''.join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_LENGTH))


def _send_verification_email(email, code):
    ttl = getattr(django_settings, 'EMAIL_CODE_TTL_MINUTES', 15)
    subject = 'Сфера — код подтверждения email'
    body = (
        f'Ваш код подтверждения в Сфере: {code}\n\n'
        f'Введите его в приложении, чтобы завершить создание аккаунта. '
        f'Код действителен {ttl} минут.\n\n'
        f'Если вы не запрашивали код, просто проигнорируйте это письмо.'
    )
    send_mail(
        subject,
        body,
        getattr(django_settings, 'DEFAULT_FROM_EMAIL', None),
        [email],
        fail_silently=False,
    )


@api_view(['POST'])
@permission_classes([AllowAny])
@throttle_classes([AuthRateThrottle])
def register_send_code(request):
    """Step 1 of sign-up: validate the address and email a confirmation code."""
    email = (request.data.get('email') or '').strip().lower()
    username = (request.data.get('username') or '').strip()

    if not email:
        return Response({'email': 'Email is required.'}, status=status.HTTP_400_BAD_REQUEST)
    try:
        validate_email(email)
    except DjangoValidationError:
        return Response({'email': 'Enter a valid email address.'}, status=status.HTTP_400_BAD_REQUEST)

    if User.objects.filter(email__iexact=email).exists():
        return Response(
            {'email': 'A user with that email already exists.'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    if username and User.objects.filter(username__iexact=username).exists():
        return Response(
            {'username': 'A user with that username already exists.'},
            status=status.HTTP_400_BAD_REQUEST,
        )

    now = timezone.now()
    resend_gap = getattr(django_settings, 'EMAIL_CODE_RESEND_SECONDS', 60)
    existing = EmailVerificationCode.objects.filter(email=email).first()
    if existing and (now - existing.updated_at).total_seconds() < resend_gap:
        wait = int(resend_gap - (now - existing.updated_at).total_seconds())
        return Response(
            {'detail': f'Please wait {wait}s before requesting a new code.'},
            status=status.HTTP_429_TOO_MANY_REQUESTS,
        )

    code = _generate_code()
    ttl = getattr(django_settings, 'EMAIL_CODE_TTL_MINUTES', 15)
    EmailVerificationCode.objects.update_or_create(
        email=email,
        defaults={
            'code': code,
            'attempts': 0,
            'expires_at': now + timedelta(minutes=ttl),
        },
    )

    try:
        _send_verification_email(email, code)
    except Exception:
        return Response(
            {'detail': 'Could not send the confirmation email. Try again later.'},
            status=status.HTTP_502_BAD_GATEWAY,
        )

    return Response({'status': 'sent'}, status=status.HTTP_200_OK)


@api_view(['POST'])
@permission_classes([AllowAny])
@throttle_classes([AuthRateThrottle])
def login(request):
    # A banned account with the right password learns why it cannot sign in.
    from . import bans
    candidate = User.objects.filter(username=str(request.data.get('username', ''))).first()
    if candidate and bans.is_banned(candidate.id) and candidate.check_password(str(request.data.get('password', ''))):
        audit_event(request, 'login_banned', user=candidate)
        return Response(bans.ban_info(candidate.id), status=status.HTTP_403_FORBIDDEN)
    serializer = TokenObtainPairSerializer(data=request.data)
    if not serializer.is_valid():
        audit_event(request, 'login_failed', metadata={'username': str(request.data.get('username', ''))[:150]})
        return Response(serializer.errors, status=status.HTTP_401_UNAUTHORIZED)
    user = serializer.user
    refresh = RefreshToken(serializer.validated_data['refresh'])
    try:
        track_device(type('AuthRequest', (), {'user': user, 'GET': request.GET, 'META': request.META})())
    except Exception:
        pass
    audit_event(request, 'login_success', user=user)
    return _auth_response(user, refresh, request)


@api_view(['POST'])
@permission_classes([AllowAny])
@throttle_classes([AuthRateThrottle])
def refresh_token(request):
    refresh_value = request.COOKIES.get(django_settings.REFRESH_COOKIE_NAME)
    if not refresh_value:
        audit_event(request, 'refresh_missing')
        return Response({'detail': 'refresh cookie missing'}, status=status.HTTP_401_UNAUTHORIZED)

    serializer = TokenRefreshSerializer(data={'refresh': refresh_value})
    # A token that is expired, blacklisted or simply malformed makes the
    # serializer raise TokenError rather than fail validation, and TokenError is
    # not a DRF exception — left alone it comes back as a 500 with the cookie
    # still in place. Both are ordinary outcomes here, now more than ever: a
    # browser idle for a day and a half arrives holding exactly such a token,
    # and it needs the 401 that sends it to the sign-in screen.
    try:
        valid = serializer.is_valid()
    except TokenError:
        valid = False
    if not valid:
        audit_event(request, 'refresh_failed')
        response = Response(
            {'detail': 'refresh token is no longer valid'},
            status=status.HTTP_401_UNAUTHORIZED,
        )
        _clear_refresh_cookie(response)
        return response

    response = Response({'access': serializer.validated_data['access']})
    rotated = serializer.validated_data.get('refresh')
    if rotated:
        # The rotated token carries the browser lifetime the serializer minted
        # it with. Re-stamp it, so the app's session keeps not expiring and the
        # browser's window slides forward another day and a half from now.
        _set_refresh_cookie(
            response, _with_session_lifetime(RefreshToken(rotated), request), request,
        )
    audit_event(request, 'refresh_success')
    return response


@api_view(['POST'])
@permission_classes([AllowAny])
def logout_view(request):
    refresh_value = request.COOKIES.get(django_settings.REFRESH_COOKIE_NAME)
    if refresh_value:
        try:
            RefreshToken(refresh_value).blacklist()
        except TokenError:
            pass
    audit_event(request, 'logout')
    response = Response(status=status.HTTP_204_NO_CONTENT)
    _clear_refresh_cookie(response)
    return response


@api_view(['POST'])
@permission_classes([AllowAny])
@throttle_classes([AuthRateThrottle])
def register(request):
    """Step 2 of sign-up: verify the code, then create the account."""
    email = (request.data.get('email') or '').strip().lower()
    code = (request.data.get('code') or '').strip().upper()

    if not email or not code:
        return Response(
            {'code': 'Email and confirmation code are required.'},
            status=status.HTTP_400_BAD_REQUEST,
        )

    record = EmailVerificationCode.objects.filter(email=email).first()
    if record is None:
        return Response(
            {'code': 'No confirmation code was requested for this email.'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    if record.is_expired():
        record.delete()
        return Response(
            {'code': 'The confirmation code has expired. Request a new one.'},
            status=status.HTTP_400_BAD_REQUEST,
        )

    max_attempts = getattr(django_settings, 'EMAIL_CODE_MAX_ATTEMPTS', 5)
    if record.attempts >= max_attempts:
        record.delete()
        return Response(
            {'code': 'Too many incorrect attempts. Request a new code.'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    if record.code != code:
        record.attempts += 1
        record.save(update_fields=['attempts'])
        return Response(
            {'code': 'Incorrect confirmation code.'},
            status=status.HTTP_400_BAD_REQUEST,
        )

    serializer = RegisterSerializer(data=request.data)
    if serializer.is_valid():
        user = serializer.save()
        record.delete()
        refresh = RefreshToken.for_user(user)
        audit_event(request, 'register_success', user=user)
        return _auth_response(user, refresh, request, status.HTTP_201_CREATED)
    return Response(
        serializer.errors, status=status.HTTP_400_BAD_REQUEST
    )


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def me(request):
    try:
        track_device(request)
    except Exception:
        pass
    return Response(
        MeSerializer(request.user, context={'request': request}).data
    )


@api_view(['PATCH'])
@permission_classes([IsAuthenticated])
@parser_classes([MultiPartParser, FormParser, JSONParser])
def update_profile(request):
    data = request.data
    # The avatar and banner arrive as files, so the profile form is multipart,
    # and multipart has no notion of a list — `links` comes over as a JSON
    # string. Decode it here so the serializer sees the list it validates.
    raw_links = data.get('links')
    if isinstance(raw_links, str):
        data = data.copy()
        try:
            data['links'] = json.loads(raw_links or '[]')
        except ValueError:
            return Response(
                {'links': ['must be valid JSON']},
                status=status.HTTP_400_BAD_REQUEST,
            )

    serializer = ProfileUpdateSerializer(
        request.user, data=data, partial=True,
    )
    if serializer.is_valid():
        serializer.save()
        user = request.user
        user.refresh_from_db()
        response_data = MeSerializer(user, context={'request': request}).data

        # Broadcast profile change to all connected signaling clients
        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)('signaling', {
            'type': 'user.profile.update',
            'user': {
                'id': str(user.id),
                'username': user.username,
                'nickname': user.nickname or '',
                'avatar': user.avatar.url if user.avatar else '',
                'bio': user.bio or '',
                'status': user.status,
                'account_type': user.account_type,
            },
        })

        return Response(response_data)
    return Response(
        serializer.errors, status=status.HTTP_400_BAD_REQUEST
    )


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@throttle_classes([AuthRateThrottle])
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
        audit_event(request, 'delete_account_failed')
        return Response(
            {'error': 'Password is incorrect'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    audit_event(request, 'delete_account_success')
    _blacklist_user_refresh_tokens(request.user)
    request.user.delete()
    response = Response({'status': 'deleted'})
    _clear_refresh_cookie(response)
    return response


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@throttle_classes([AuthRateThrottle])
def change_password(request):
    old_pw = request.data.get('old_password', '')
    new_pw = request.data.get('new_password', '')
    if not old_pw or not new_pw:
        return Response(
            {'error': 'old_password and new_password required'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    # Verify the current password before doing anything else.
    if not request.user.check_password(old_pw):
        audit_event(request, 'password_change_failed')
        return Response(
            {'error': 'Current password is incorrect'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    # Enforce the project-wide password policy (length, common, numeric, …).
    try:
        validate_password(new_pw, user=request.user)
    except DjangoValidationError as exc:
        return Response(
            {'error': ' '.join(exc.messages)},
            status=status.HTTP_400_BAD_REQUEST,
        )
    request.user.set_password(new_pw)
    request.user.save()
    audit_event(request, 'password_change_success')
    _blacklist_user_refresh_tokens(request.user)
    response = Response({'status': 'ok'})
    _clear_refresh_cookie(response)
    return response


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@throttle_classes([AuthRateThrottle])
def revoke_sessions(request):
    """Sign the account out of every session, this one included.

    Blacklists all outstanding refresh tokens and drops the device records, so
    a stolen or forgotten session on another machine can no longer refresh.
    The caller is logged out too — the client clears its tokens and returns to
    the sign-in screen once this succeeds.
    """
    _blacklist_user_refresh_tokens(request.user)
    request.user.devices.all().delete()
    audit_event(request, 'sessions_revoked')
    response = Response({'status': 'ok'})
    _clear_refresh_cookie(response)
    return response


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
    # A bot has nobody to press "accept", so any request aimed at one is
    # promoted here too — this heals links made before bots auto-accepted.
    Friendship.objects.filter(
        from_user=request.user, to_user__account_type='bot', status='pending',
    ).update(status='accepted')
    friendships = Friendship.objects.filter(
        Q(from_user=request.user) | Q(to_user=request.user),
        status='accepted',
    ).exclude(
        # System bots (Сфероник) are tools reached from the server bar, never
        # contacts, so they must not show up in the DM list.
        Q(from_user__bot_profile__is_system=True) | Q(to_user__bot_profile__is_system=True),
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
        if existing.status in ('pending', 'awaiting_parent'):
            return Response(
                {'error': 'Request already pending'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if existing.status == 'rejected':
            # Asking again after a refusal is a fresh request, and goes back
            # past the parent if a child is involved — including when it was
            # the parent who refused it the first time.
            waits = is_child(request.user) or is_child(to_user)
            existing.status = 'awaiting_parent' if waits else 'pending'
            existing.from_user = request.user
            existing.to_user = to_user
            existing.save()
            friendship_data = FriendshipSerializer(existing, context={'request': request}).data
            if not waits:
                _push_friend_event(str(to_user_id), 'friend-request', friendship_data)
            return Response(friendship_data)

    # Bots can't accept anything: adding one is immediate, not a request.
    is_bot = getattr(to_user, 'account_type', 'user') == 'bot'
    # A child on either side means a parent decides first — and until they do,
    # the other party is not told the request exists. That holds whichever
    # direction it came from: a stranger should not learn that an account is a
    # child's by watching whether their request is delivered.
    needs_parent = not is_bot and (is_child(request.user) or is_child(to_user))

    if is_bot:
        new_status = 'accepted'
    elif needs_parent:
        new_status = 'awaiting_parent'
    else:
        new_status = 'pending'

    friendship = Friendship.objects.create(
        from_user=request.user, to_user=to_user, status=new_status,
    )
    friendship_data = FriendshipSerializer(friendship, context={'request': request}).data
    if not is_bot and not needs_parent:
        # Notify recipient in real time so their pending requests update immediately
        _push_friend_event(str(to_user_id), 'friend-request', friendship_data)
    return Response(friendship_data, status=status.HTTP_201_CREATED)


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
    # Notify the requester (from_user) that their request was accepted
    me_data = UserSerializer(request.user, context={'request': request}).data
    _push_friend_event(str(friendship.from_user_id), 'friend-added', me_data)
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
    me_data = UserSerializer(request.user, context={'request': request}).data
    _push_friend_event(str(friendship.from_user_id), 'friend-request-rejected', me_data)
    return Response(FriendshipSerializer(
        friendship, context={'request': request}
    ).data)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def mutual_friends(request, user_id):
    """Friends shared by the current user and user_id."""
    def get_friend_ids(user):
        friendships = Friendship.objects.filter(
            Q(from_user=user) | Q(to_user=user),
            status='accepted',
        )
        ids = set()
        for f in friendships:
            other = (
                f.to_user if f.from_user == user
                else f.from_user
            )
            ids.add(other.id)
        return ids

    try:
        target = User.objects.get(id=user_id)
    except User.DoesNotExist:
        return Response(
            {'error': 'User not found'},
            status=status.HTTP_404_NOT_FOUND,
        )

    mutual_ids = get_friend_ids(request.user) & get_friend_ids(target)
    users = User.objects.filter(id__in=mutual_ids)
    return Response(
        UserSerializer(users, many=True, context={'request': request}).data
    )


def _friend_ids(user):
    """Ids of everyone `user` has an accepted friendship with."""
    friendships = Friendship.objects.filter(
        Q(from_user=user) | Q(to_user=user), status='accepted',
    ).values_list('from_user_id', 'to_user_id')
    ids = set()
    for from_id, to_id in friendships:
        ids.add(to_id if from_id == user.id else from_id)
    return ids


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def user_profile(request, user_id):
    """Everything the profile screen shows about one user.

    One request rather than four. The screen needs the profile, whether the
    two are friends, who they both know and where they both are, and asking
    for those separately meant four round-trips before the page settled.

    What is shown depends on the reader. A user who has turned off "show my
    profile to everyone" is fully visible to friends and reduced to a name and
    an avatar for everyone else — enough to recognise who is speaking, and no
    more.
    """
    try:
        user = User.objects.get(id=user_id)
    except User.DoesNotExist:
        return Response(
            {'error': 'User not found'},
            status=status.HTTP_404_NOT_FOUND,
        )

    is_self = user.id == request.user.id
    my_friends = _friend_ids(request.user)
    is_friend = user.id in my_friends

    settings_row = getattr(user, 'settings', None)
    public = settings_row is None or settings_row.show_profile_to_everyone
    full = is_self or is_friend or public

    data = ProfileSerializer(user, context={'request': request}).data
    if not full:
        data = {
            key: value for key, value in data.items()
            if key in {
                'id', 'username', 'nickname', 'avatar', 'status',
                'account_type', 'verification_level', 'verification',
            }
        }

    data['is_self'] = is_self
    data['is_friend'] = is_friend
    data['restricted'] = not full

    if full and not is_self:
        mutual_ids = my_friends & _friend_ids(user)
        data['mutual_friends'] = UserSerializer(
            User.objects.filter(id__in=mutual_ids),
            many=True, context={'request': request},
        ).data

        # Module-provided sections (e.g. servers → mutual_guilds).
        from sfera_modules import hooks
        for extra in hooks.collect(hooks.PROFILE_EXTRAS, request.user, user).values():
            if isinstance(extra, dict):
                data.update(extra)
    else:
        data['mutual_friends'] = []

    # Gifts are not a feature yet. The profile screen has a shelf for them and
    # reads it from here, so the shape of the answer is settled now and the
    # screen will not need touching when they arrive.
    data['gifts'] = []

    return Response(data)


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
    # Notify the removed friend in real time
    me_data = UserSerializer(request.user, context={'request': request}).data
    _push_friend_event(str(user_id), 'friend-removed', me_data)
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

    _push_block_event(str(user_id), 'blocked', str(request.user.id))
    _log_block_in_guilds(request.user, target, 'member_block')
    audit_event(request, 'block_user', metadata={'target_user_id': str(target.id)})

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

    _push_block_event(str(user_id), 'unblocked', str(request.user.id))
    _log_block_in_guilds(request.user, User.objects.filter(id=user_id).first(), 'member_unblock')
    audit_event(request, 'unblock_user', metadata={'target_user_id': str(user_id)})

    return Response(status=status.HTTP_204_NO_CONTENT)


def _log_block_in_guilds(actor, target, action):
    if not target:
        return
    from sfera_modules import hooks
    signal = hooks.user_blocked if action == 'member_block' else hooks.user_unblocked
    signal.send_robust(sender=None, blocker=actor, blocked=target)


def _push_block_event(target_user_id: str, event_type: str, by_user_id: str):
    """Send a real-time block/unblock notification to the target user."""
    try:
        layer = get_channel_layer()
        async_to_sync(layer.group_send)(
            f'user_{target_user_id}',
            {
                'type': 'block.notify',
                'data': {
                    'type': event_type,
                    'by_user_id': by_user_id,
                },
            },
        )
    except Exception:
        pass


def _push_friend_event(target_user_id: str, event_type: str, user_data: dict):
    """Send a real-time friend list change to the target user."""
    try:
        layer = get_channel_layer()
        async_to_sync(layer.group_send)(
            f'user_{target_user_id}',
            {
                'type': 'block.notify',
                'data': {
                    'type': event_type,
                    'user': user_data,
                },
            },
        )
    except Exception:
        pass


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
    audit_event(request, 'device_remove', metadata={'device_id': str(device_id)})
    return Response(status=status.HTTP_204_NO_CONTENT)


# ==================== User Settings ====================

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def user_settings_get(request):
    settings, _ = UserSettings.objects.get_or_create(
        user=request.user,
    )
    # On read too, not only on write. A child moved into a family after turning
    # the filter off would otherwise keep it off until they next happened to
    # save this page.
    if is_child(request.user):
        enforce_child_settings(settings)
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
        # The child's settings screen is not read-only — they can still choose
        # a theme and a language. It simply does not get to turn the filter
        # off, so the locked values go back after every save.
        if is_child(request.user):
            enforce_child_settings(settings)
            return Response(UserSettingsSerializer(settings).data)
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


@api_view(['POST', 'DELETE'])
@permission_classes([IsAuthenticated])
def fcm_token(request):
    token = (request.data or {}).get('token', '').strip()
    if not token:
        return Response({'error': 'token required'}, status=status.HTTP_400_BAD_REQUEST)
    if request.method == 'POST':
        FcmToken.objects.update_or_create(token=token, defaults={'user': request.user})
        return Response({'ok': True})
    FcmToken.objects.filter(user=request.user, token=token).delete()
    return Response(status=status.HTTP_204_NO_CONTENT)


# ==================== Data Export ====================
#
# Collects everything the user has written on the platform (DMs, server
# posts/messages and post comments) into one JSON file. The build runs in a
# background thread because it can take a while for active accounts; the client
# polls the status endpoint and downloads the file once it is ready.


def _safe_content(obj):
    """Decrypt a message/comment body, tolerating bad/legacy ciphertext."""
    try:
        return obj.content
    except Exception:
        return None


def _build_data_export(export_id, user_id):
    # Fresh DB connection for this thread.
    connection.close()
    from sfera_messages.models import Message
    from sfera_modules import hooks

    try:
        export = DataExport.objects.get(id=export_id)
    except DataExport.DoesNotExist:
        return

    try:
        user = User.objects.get(id=user_id)

        direct_messages = []
        for m in (Message.objects
                  .filter(author_id=user_id)
                  .select_related('conversation')
                  .order_by('created_at')
                  .iterator()):
            direct_messages.append({
                'id': str(m.id),
                'conversation_id': str(m.conversation_id),
                'content': _safe_content(m),
                'reply_to': str(m.reply_to_id) if m.reply_to_id else None,
                'is_pinned': m.is_pinned,
                'created_at': m.created_at.isoformat(),
            })

        # Module sections: {section_name: [rows]}.
        sections = {}
        for provided in hooks.collect(hooks.DATA_EXPORT, user).values():
            if isinstance(provided, dict):
                sections.update(provided)

        payload = {
            'export_version': 1,
            'generated_at': timezone.now().isoformat(),
            'account': {
                'id': str(user.id),
                'username': user.username,
                'nickname': user.nickname,
                'email': user.email,
                'date_joined': user.date_joined.isoformat() if user.date_joined else None,
            },
            'direct_messages': direct_messages,
            **sections,
            'counts': {
                'direct_messages': len(direct_messages),
                **{name: len(rows) for name, rows in sections.items()},
            },
        }

        total = len(direct_messages) + sum(len(rows) for rows in sections.values())
        data = json.dumps(payload, ensure_ascii=False, indent=2)
        filename = f'sfera-data-export-{export_id}.json'
        export.file.save(filename, ContentFile(data.encode('utf-8')), save=False)
        export.item_count = total
        export.status = 'ready'
        export.completed_at = timezone.now()
        export.save(update_fields=['file', 'item_count', 'status', 'completed_at'])
    except Exception as exc:  # noqa: BLE001
        export.status = 'failed'
        export.error = str(exc)[:1000]
        export.completed_at = timezone.now()
        export.save(update_fields=['status', 'error', 'completed_at'])
    finally:
        connection.close()


def _export_payload(export, request):
    data = {
        'id': str(export.id),
        'status': export.status,
        'item_count': export.item_count,
        'created_at': export.created_at.isoformat(),
        'completed_at': export.completed_at.isoformat() if export.completed_at else None,
    }
    if export.status == 'ready':
        data['download_url'] = request.build_absolute_uri(
            f'/api/auth/data-export/{export.id}/download/'
        )
    if export.status == 'failed':
        data['error'] = export.error
    return data


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def data_export_request(request):
    # Reuse an in-progress export instead of stacking up duplicates.
    existing = (DataExport.objects
                .filter(user=request.user, status='pending')
                .first())
    if existing:
        return Response(_export_payload(existing, request))

    export = DataExport.objects.create(user=request.user, status='pending')
    audit_event(request, 'data_export_request', metadata={'export_id': str(export.id)})
    thread = threading.Thread(
        target=_build_data_export,
        args=(str(export.id), str(request.user.id)),
        daemon=True,
    )
    thread.start()
    return Response(_export_payload(export, request), status=status.HTTP_202_ACCEPTED)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def data_export_status(request, export_id):
    try:
        export = DataExport.objects.get(id=export_id, user=request.user)
    except DataExport.DoesNotExist:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    return Response(_export_payload(export, request))


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def data_export_download(request, export_id):
    try:
        export = DataExport.objects.get(id=export_id, user=request.user)
    except DataExport.DoesNotExist:
        raise Http404
    if export.status != 'ready' or not export.file:
        return Response({'error': 'not ready'}, status=status.HTTP_409_CONFLICT)
    audit_event(request, 'data_export_download', metadata={'export_id': str(export.id)})
    response = FileResponse(
        export.file.open('rb'),
        as_attachment=True,
        filename='sfera-data-export.json',
        content_type='application/json',
    )
    return response

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def ban_status(request):
    # A banned token never reaches this view: BanGuardMiddleware answers for it.
    return Response({'banned': False})
