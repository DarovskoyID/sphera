"""Device assertion of opening a precise envelope, never proof of human reading."""
import re
import sqlite3
import time
import uuid
from hashlib import sha256
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature
from django.db import transaction, OperationalError
from django.core.exceptions import ObjectDoesNotExist
from django.utils import timezone
from django.views.decorators.cache import never_cache
from rest_framework.decorators import api_view, authentication_classes, permission_classes, throttle_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from sfera_auth.cipher_views import _backend, scope_members, CipherRateThrottle
from sfera_auth.mesh_sessions import CLAIM, MeshJWTAuthentication, MeshUnavailable
from sfera_mesh.consensus_directory import ConsensusUnavailable
from sfera_mesh.storage import canonical
from .models import Message, CipherReadReceipt


@never_cache
@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@throttle_classes([CipherRateThrottle])
def acknowledge(request, conversation_id):
    try:
        authority = _backend(request)
        if authority is None: return Response(status=404)
        if set(request.data) != {'receipt'}: raise ValueError('invalid_cipher_read_receipt')
        receipt = request.data['receipt']
        if not isinstance(receipt, dict) or set(receipt) != {'body', 'signature'} or len(canonical(receipt)) > 4096:
            raise ValueError('invalid_cipher_read_receipt')
        body, signature = receipt['body'], receipt['signature']
        fields = {'domain', 'network', 'genesis', 'entry', 'user', 'owner', 'device', 'scope',
                  'message_id', 'cipher_digest', 'nonce', 'issued_at', 'expires_at'}
        if not isinstance(body, dict) or set(body) != fields or not isinstance(signature, str) or not re.fullmatch('[0-9a-f]{128}', signature):
            raise ValueError('invalid_cipher_read_receipt')
        backend, claim = authority.sessions, request.auth[CLAIM]
        if not isinstance(body['message_id'], str) or str(uuid.UUID(body['message_id'])) != body['message_id']:
            raise ValueError('invalid_cipher_read_message')
        now = int(time.time())
        if (body['domain'] != 'sfera-dm-cipher-read-v1' or body['network'] != backend.directory.network or
            body['genesis'] != backend.directory.pin or body['entry'] != backend.entry or body['user'] != str(request.user.pk) or
            body['owner'] != claim['owner'] or body['device'] != claim['device'] or body['scope'] != str(conversation_id) or
            type(body['issued_at']) is not int or type(body['expires_at']) is not int or body['issued_at'] > now + 5 or
            body['expires_at'] != body['issued_at'] + 60 or body['expires_at'] <= now or
            any(not isinstance(body[key], str) or not re.fullmatch('[0-9a-f]{64}', body[key]) for key in ('nonce', 'cipher_digest'))):
            raise ValueError('invalid_cipher_read_context')
        with backend.directory.lock, backend.lock, transaction.atomic():
            backend.require(str(request.user.pk), claim)
            members = scope_members(request.user, 'dm', str(conversation_id))
            if len(members) != 2: raise ValueError('cipher_read_requires_pair')
            _, public = backend._device(claim['owner'], claim['device'])
            Ed25519PublicKey.from_public_bytes(bytes.fromhex(public)).verify(bytes.fromhex(signature), canonical(body))
            from .mesh_delivery import visible
            message = visible(Message.objects.select_for_update().filter(pk=body['message_id'],
                conversation_id=conversation_id, message_type='cipher').exclude(author=request.user), request.user).get()
            if sha256(canonical(message.payload)).hexdigest() != body['cipher_digest']:
                raise ValueError('cipher_read_digest_mismatch')
            stored, created = CipherReadReceipt.objects.get_or_create(message=message, defaults={'receipt': receipt})
            if created:
                timestamp = timezone.now()
                Message.objects.filter(pk=message.pk).update(read_at=timestamp)
                Message.objects.filter(pk=message.pk, delivered_at=None).update(delivered_at=timestamp)
            else:
                timestamp = message.read_at or stored.created_at
            if sorted(scope_members(request.user, 'dm', str(conversation_id))) != sorted(members): raise ValueError('cipher_read_acl_changed')
            backend.require(str(request.user.pk), claim); backend.directory.anchor()
            result = {'id': str(message.pk), 'read_at': timestamp.isoformat(), 'receipt': stored.receipt}
            if created: transaction.on_commit(lambda: _deliver(str(conversation_id), result))
            return Response(result)
    except (ConsensusUnavailable, sqlite3.Error, OperationalError) as exc:
        raise MeshUnavailable() from exc
    except (ValueError, TypeError, KeyError, ObjectDoesNotExist, InvalidSignature):
        return Response({'error': 'cipher_read_rejected'}, status=409)


def _deliver(scope, result):
    from .services import _fanout
    payload = {'type': 'message_status', 'ids': [result['id']], 'field': 'read_at',
               'ts': result['read_at'], 'cipher_read_receipt': result['receipt']}
    _fanout('chat_' + scope, payload, payload)
