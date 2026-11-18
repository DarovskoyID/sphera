"""Opt-in cipher authorization. Existing accounts and current ACLs remain required."""
from django.conf import settings
from django.views.decorators.cache import never_cache
import sqlite3
from rest_framework.decorators import api_view, permission_classes, authentication_classes, throttle_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle

from .mesh_sessions import sessions, CLAIM, MeshJWTAuthentication, MeshUnavailable, submit_account_record
from .mesh_views import _allowed
from sfera_mesh.cipher_authority import CipherAuthority
from sfera_mesh.consensus_directory import ConsensusUnavailable


class CipherRateThrottle(UserRateThrottle):
    scope = 'mesh_cipher'
    rate = '120/min'


class CipherProfileRateThrottle(UserRateThrottle):
    scope = 'mesh_cipher_profile'
    rate = '3600/min'


def _backend(request):
    if not getattr(settings, 'SFERA_MESH_CIPHER_AUTHORITY', False):
        return None
    if not _allowed(request.user) or not request.auth or CLAIM not in request.auth:
        raise ValueError('active_mesh_session_required')
    return CipherAuthority(sessions())


@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@throttle_classes([CipherProfileRateThrottle])
def profile(request):
    from sfera_mesh.cipher_profiles import CipherProfiles
    try:
        if not getattr(settings, 'SFERA_MESH_CIPHER_PROFILE_GUARD', False) and not sessions().directory.current['state'].get('cipher_profiles'): return Response(status=404)
        if _backend(request) is None: return Response(status=404)
        authority = CipherProfiles(sessions())
        if set(request.data) == {'nonce'}:
            result = authority.head(str(request.user.pk), request.auth[CLAIM], request.data['nonce'])
        elif set(request.data) == {'record'}:
            result = authority.publish(str(request.user.pk), request.auth[CLAIM], request.data['record'], submit_account_record)
        else: raise ValueError('invalid_cipher_profile_request')
    except (ConsensusUnavailable, sqlite3.Error, OSError) as exc: raise MeshUnavailable() from exc
    except (ValueError, TypeError, KeyError): return Response({'error':'cipher_profile_rejected'}, status=409)
    response = Response(result); response['Cache-Control'] = 'no-store'
    return response


@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@throttle_classes([CipherRateThrottle])
def device(request):
    try:
        authority = _backend(request)
        if authority is None:
            return Response(status=404)
        if set(request.data) != {'certificate'}:
            raise ValueError('invalid_cipher_device_request')
        result = authority.publish(str(request.user.pk), request.auth[CLAIM], request.data['certificate'])
    except ConsensusUnavailable as exc:
        raise MeshUnavailable() from exc
    except ValueError as exc:
        if str(exc) != 'cipher_global_pin_pending':
            return Response({'error': 'cipher_device_rejected'}, status=409)
        # publish has already checked the device certificate, current admission,
        # exact claim and absence of a global pin. Consensus resolves a race.
        try:
            submit_account_record(request.data['certificate'])
        except (OSError, ValueError):
            raise MeshUnavailable() from exc
        response = Response({'error': 'cipher_device_pin_pending'}, status=503)
        response['Cache-Control'] = 'no-store'
        return response
    except sqlite3.Error as exc:
        raise MeshUnavailable() from exc
    except (TypeError, KeyError):
        return Response({'error': 'cipher_device_rejected'}, status=409)
    response = Response(result); response['Cache-Control'] = 'no-store'
    return response


@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@throttle_classes([CipherRateThrottle])
def archive_device(request):
    try:
        authority = _backend(request)
        if authority is None: return Response(status=404)
        if set(request.data) != {'device', 'device_public', 'nonce'}: raise ValueError('invalid_archive_device_request')
        result = authority.archive_device(str(request.user.pk), request.auth[CLAIM], request.data['device'], request.data['device_public'], request.data['nonce'])
    except (ConsensusUnavailable, sqlite3.Error, OSError) as exc: raise MeshUnavailable() from exc
    except (ValueError, TypeError, KeyError): return Response({'error': 'archive_device_rejected'}, status=409)
    response = Response(result); response['Cache-Control'] = 'no-store'
    return response


def scope_members(user, source, scope):
    if source == 'dm':
        from sfera_messages.models import Conversation
        from .models import User, BlockedUser
        conversation = Conversation.objects.filter(pk=scope, participants=user).first()
        if conversation is None:
            raise ValueError('cipher_scope_unavailable')
        members = list(conversation.participants.order_by('pk').values_list('pk', flat=True)[:65])
        if len(members) > 64 or BlockedUser.objects.filter(blocker_id__in=members, blocked_id__in=members).exists():
            raise ValueError('cipher_scope_unavailable')
        if any(not _allowed(member) for member in User.objects.filter(pk__in=members)):
            raise ValueError('cipher_scope_unavailable')
        return [str(member) for member in members]
    if source == 'guild':
        from django.apps import apps
        from sfera_messages.mesh_guild import can_read
        channel = apps.get_model('sfera_servers.GuildChannel').objects.select_related('guild').get(pk=scope)
        if channel.channel_type != 'text' or channel.guild.is_discoverable or not can_read(user, channel):
            raise ValueError('cipher_scope_unavailable')
        rows = list(apps.get_model('sfera_servers.GuildMembership').objects.filter(guild_id=channel.guild_id).select_related('user')[:65])
        if len(rows) > 64:
            raise ValueError('cipher_scope_member_limit')
        return sorted(str(row.user_id) for row in rows if can_read(row.user, channel))
    raise ValueError('invalid_cipher_scope')


@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@throttle_classes([CipherRateThrottle])
def scope(request):
    from django.core.exceptions import ObjectDoesNotExist, ValidationError
    try:
        authority = _backend(request)
        if authority is None:
            return Response(status=404)
        if set(request.data) != {'source', 'scope', 'nonce'}:
            raise ValueError('invalid_cipher_scope_request')
        source, identity = request.data['source'], request.data['scope']
        members = scope_members(request.user, source, identity)
        result = authority.attest(str(request.user.pk), request.auth[CLAIM], source, identity, members, request.data['nonce'],
            revalidate=lambda: scope_members(request.user, source, identity))
    except ConsensusUnavailable as exc:
        raise MeshUnavailable() from exc
    except sqlite3.Error as exc:
        raise MeshUnavailable() from exc
    except (ValueError, TypeError, KeyError, LookupError, ObjectDoesNotExist, ValidationError):
        return Response({'error': 'cipher_scope_rejected'}, status=409)
    response = Response(result); response['Cache-Control'] = 'no-store'
    return response


@never_cache
@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@throttle_classes([CipherRateThrottle])
def relay(request):
    from django.core.exceptions import ObjectDoesNotExist, ValidationError
    from sfera_mesh.cipher_relay import CipherRelay
    try:
        authority = _backend(request)
        if authority is None:
            return Response(status=404)
        if set(request.data) != {'source', 'scope', 'roster', 'epoch', 'request'}:
            raise ValueError('invalid_cipher_relay_request')
        source, identity = request.data['source'], request.data['scope']
        members = scope_members(request.user, source, identity)
        result = CipherRelay(authority).request(str(request.user.pk), request.auth[CLAIM],
            source, identity, request.data['roster'], request.data['epoch'], request.data['request'], members,
            revalidate=lambda: scope_members(request.user, source, identity))
    except (ConsensusUnavailable, sqlite3.Error) as exc:
        raise MeshUnavailable() from exc
    except (ValueError, TypeError, KeyError, LookupError, ObjectDoesNotExist, ValidationError):
        response = Response({'error': 'cipher_relay_rejected'}, status=409)
        response['Cache-Control'] = 'no-store'
        return response
    response = Response(result)
    response['Cache-Control'] = 'no-store'
    return response
