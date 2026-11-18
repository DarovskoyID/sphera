"""Authenticated account binding and device login with the existing access guards."""
import time

from rest_framework.decorators import api_view, permission_classes, authentication_classes, throttle_classes
from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework.throttling import AnonRateThrottle
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import AccessToken, RefreshToken
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.exceptions import TokenError
from django.conf import settings

from .mesh_sessions import CLAIM, sessions, MeshUnavailable
from sfera_mesh.consensus_directory import ConsensusUnavailable
from .views import AuthRateThrottle


class EntryProbeRateThrottle(AnonRateThrottle):
    # Every protected cipher exchange first verifies the selected entry without
    # credentials. These public signatures must not consume the login bucket.
    scope = 'mesh_entry_probe'
    rate = '600/min'


def _allowed(user):
    from . import bans
    from sfera_modules import hooks
    return user.is_active and not bans.is_banned(user.pk) and not hooks.access_block(user.pk)


@api_view(['POST'])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([EntryProbeRateThrottle])
def entry_probe(request):
    backend = sessions()
    try:
        if set(request.data) != {'nonce'}:
            raise ValueError('invalid_entry_probe')
        result = backend.entry_proof(request.data['nonce'])
    except ConsensusUnavailable as exc:
        raise MeshUnavailable() from exc
    except ValueError:
        return Response({'error': 'signed_mesh_entry_unavailable'}, status=503)
    response = Response(result)
    response['Cache-Control'] = 'no-store'
    return response


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def challenge(request):
    if not _allowed(request.user):
        return Response({'error': 'account_access_blocked'}, status=403)
    if not request.auth or 'jti' not in request.auth:
        return Response({'error': 'jwt_required'}, status=401)
    backend = sessions()
    try:
        if 'signed' in request.data:
            if set(request.data) != {'owner', 'device', 'signed'} or request.data['signed'] is not True:
                raise ValueError('invalid_signed_binding_request')
            body = backend.signed_challenge(str(request.user.pk), request.auth['jti'],
                request.data['owner'], request.data['device'])
        else:
            body = backend.challenge(str(request.user.pk), request.auth['jti'],
                                     request.data.get('owner'), request.data.get('device'))
    except ConsensusUnavailable as exc:
        raise MeshUnavailable() from exc
    except ValueError:
        return Response({'error': 'mesh_binding_rejected'}, status=400)
    response = Response(body); response['Cache-Control'] = 'no-store'
    return response


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def bind(request):
    if not _allowed(request.user):
        return Response({'error': 'account_access_blocked'}, status=403)
    if not request.auth or 'jti' not in request.auth:
        return Response({'error': 'jwt_required'}, status=401)
    backend = sessions()
    # Preserve both credential lifetimes, replacing the cookie so refresh cannot
    # silently discard the device binding. The old refresh is blacklisted.
    try:
        old_refresh = RefreshToken(request.COOKIES.get(settings.REFRESH_COOKIE_NAME, ''))
        if str(old_refresh['user_id']) != str(request.user.pk):
            raise TokenError('different application account')
    except (TokenError, KeyError):
        return Response({'error': 'matching_refresh_cookie_required'}, status=401)
    token = AccessToken(str(request.auth))
    expires = min(old_refresh['exp'], int(time.time()) + 86400)
    try:
        claim = backend.complete(str(request.user.pk), request.auth['jti'], request.data.get('challenge'),
                                 request.data.get('owner_signature'), request.data.get('device_signature'), expires)
    except ConsensusUnavailable as exc:
        raise MeshUnavailable() from exc
    except ValueError:
        return Response({'error': 'mesh_binding_rejected'}, status=400)
    token[CLAIM] = claim
    token['exp'] = min(token['exp'], expires)
    token.set_jti()
    refresh = RefreshToken.for_user(request.user)
    refresh[CLAIM] = claim
    refresh['exp'] = expires
    old_refresh.blacklist()
    response = Response({'access': str(token), 'mesh_session': claim, 'expires_at': expires})
    from .views import _set_refresh_cookie
    _set_refresh_cookie(response, refresh, request)
    return response


@api_view(['POST'])
@authentication_classes([JWTAuthentication])
@permission_classes([IsAuthenticated])
def unbind(request):
    if request.auth and CLAIM in request.auth:
        sessions(fresh=False).revoke(str(request.user.pk), request.auth[CLAIM])
    return Response(status=204)


def _login_response(user, backend, claim, request):
    # Never use _auth_response: its normal app lifetime may exceed this device
    # session's one-day bound. Token refresh must retain the same upper bound.
    backend.require(str(user.pk), claim)
    if not _allowed(user):
        return Response({'error': 'account_access_blocked'}, status=403)
    refresh = RefreshToken.for_user(user)
    refresh[CLAIM] = claim
    with backend.lock:
        expires = backend.db.execute('SELECT expires FROM app_sessions WHERE id=?', (claim['id'],)).fetchone()[0]
    refresh['exp'] = min(refresh['exp'], expires)
    access = refresh.access_token
    access['exp'] = min(access['exp'], expires)
    from .views import _set_refresh_cookie, audit_event, track_device
    audit_event(request, 'mesh_login_success', user=user)
    track_device(type('AuthRequest', (), {'user': user, 'GET': request.GET, 'META': request.META})())
    response = Response({'access': str(access), 'mesh_session': claim, 'expires_at': refresh['exp']})
    _set_refresh_cookie(response, refresh, request)
    return response


@api_view(['POST'])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([AuthRateThrottle])
def login_challenge(request):
    backend = sessions()
    try:
        body = backend.login_challenge(request.data.get('owner'), request.data.get('device'))
    except ConsensusUnavailable as exc:
        raise MeshUnavailable() from exc
    except ValueError:
        return Response({'error': 'mesh_login_rejected'}, status=400)
    return Response(body)


@api_view(['POST'])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([AuthRateThrottle])
def login(request):
    from .models import User
    from sfera_modules import hooks
    backend = sessions()
    try:
        body = backend.login_context(request.data.get('challenge'))
        user = User.objects.filter(pk=body['application_user'], is_active=True).first()
        if user is None or not _allowed(user):
            return Response({'error': 'account_access_blocked'}, status=403)
        claim = backend.complete(str(user.pk), body['login_jti'], body['challenge'],
            request.data.get('owner_signature'), request.data.get('device_signature'),
            int(time.time()) + 86400, purpose='login')
        block = hooks.login_block(user, request)
        if block:
            if block.get('error') != 'second_factor_required' or not block.get('challenge'):
                backend.revoke(str(user.pk), claim)
                return Response(block, status=403)
            opaque = backend.defer_factor(str(user.pk), block['challenge'], claim)
            # The module's raw credential never reaches the client or the
            # ordinary 2FA route, which would otherwise mint an unbound JWT.
            return Response({**block, 'challenge': opaque}, status=409)
        return _login_response(user, backend, claim, request)
    except ConsensusUnavailable as exc:
        raise MeshUnavailable() from exc
    except ValueError:
        return Response({'error': 'mesh_login_rejected'}, status=400)


@api_view(['POST'])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([AuthRateThrottle])
def login_second_factor(request):
    from sfera_modules import hooks
    backend = sessions()
    try:
        identity = request.data.get('challenge')
        expected, module_challenge, claim = backend.factor_context(identity)
        backend.require(expected, claim)
        user = hooks.second_factor_user(module_challenge, str(request.data.get('code', '')).strip(), request)
        if user is None or str(user.pk) != expected:
            return Response({'error': 'invalid_code'}, status=401)
        if not _allowed(user):
            return Response({'error': 'account_access_blocked'}, status=403)
        backend.factor_context(identity, consume=True)
        return _login_response(user, backend, claim, request)
    except ConsensusUnavailable as exc:
        raise MeshUnavailable() from exc
    except ValueError:
        return Response({'error': 'mesh_login_rejected'}, status=400)
