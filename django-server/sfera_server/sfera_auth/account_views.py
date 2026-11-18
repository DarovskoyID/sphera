"""Opt-in owner-signed password/recovery updates for a bound active device."""
import sqlite3
from django.conf import settings
from rest_framework.decorators import api_view, authentication_classes, permission_classes, throttle_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from .mesh_sessions import CLAIM, MeshJWTAuthentication, MeshUnavailable, sessions, submit_account_record
from .mesh_views import _allowed
from .cipher_views import CipherRateThrottle
from sfera_mesh.account_publication import AccountPublication
from sfera_mesh.consensus_directory import ConsensusUnavailable


def backend(request):
    if not getattr(settings, 'SFERA_MESH_ACCOUNT_RECOVERY', False):
        return None
    if not _allowed(request.user) or not request.auth or CLAIM not in request.auth:
        raise ValueError('active_mesh_session_required')
    return AccountPublication(sessions())


@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@throttle_classes([CipherRateThrottle])
def head(request):
    try:
        authority = backend(request)
        if authority is None:
            return Response(status=404)
        if set(request.data) not in ({'nonce'}, {'nonce', 'controlled'}) or ('controlled' in request.data and request.data['controlled'] is not True):
            raise ValueError('invalid_account_head_request')
        result = authority.head(str(request.user.pk), request.auth[CLAIM], request.data['nonce'], controlled=request.data.get('controlled', False))
    except (ConsensusUnavailable, sqlite3.Error) as exc:
        raise MeshUnavailable() from exc
    except (ValueError, TypeError, KeyError):
        return Response({'error': 'account_head_rejected'}, status=409)
    response = Response(result); response['Cache-Control'] = 'no-store'
    return response


@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@throttle_classes([CipherRateThrottle])
def publish(request):
    try:
        authority = backend(request)
        if authority is None:
            return Response(status=404)
        if set(request.data) == {'update', 'vault'}:
            result = authority.publish_control(str(request.user.pk), request.auth[CLAIM], request.data['update'], request.data['vault'], submit_account_record)
        elif set(request.data) == {'record', 'vault'}:
            result = authority.publish(str(request.user.pk), request.auth[CLAIM], request.data['record'], request.data['vault'], submit_account_record)
        else:
            raise ValueError('invalid_account_publish_request')
    except (ConsensusUnavailable, sqlite3.Error, OSError) as exc:
        raise MeshUnavailable() from exc
    except (ValueError, TypeError, KeyError):
        return Response({'error': 'account_publish_rejected'}, status=409)
    response = Response(result, status=200 if result['state'] == 'confirmed' else 202)
    response['Cache-Control'] = 'no-store'
    return response


@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@throttle_classes([CipherRateThrottle])
def devices(request):
    from sfera_mesh.device_publication import DevicePublication
    try:
        account = backend(request)
        if account is None: return Response(status=404)
        authority = DevicePublication(account.sessions)
        if set(request.data) == {'nonce'}:
            result = authority.head(str(request.user.pk), request.auth[CLAIM], request.data['nonce'])
        elif set(request.data) == {'event'}:
            result = authority.publish(str(request.user.pk), request.auth[CLAIM], request.data['event'], submit_account_record)
        else: raise ValueError('invalid_device_publication_request')
    except (ConsensusUnavailable, sqlite3.Error, OSError) as exc: raise MeshUnavailable() from exc
    except (ValueError, TypeError, KeyError): return Response({'error':'device_publication_rejected'}, status=409)
    response = Response(result, status=202 if result.get('state') == 'pending' else 200)
    response['Cache-Control'] = 'no-store'
    return response
