"""Explicit opaque send path; its first committed envelope latches cipher mode."""
import secrets
import sqlite3
import time
import re
from hashlib import sha256
from django.conf import settings

from django.core.exceptions import ObjectDoesNotExist, ValidationError
from django.db import transaction, IntegrityError, OperationalError
from django.views.decorators.cache import never_cache
from rest_framework.decorators import api_view, authentication_classes, permission_classes, throttle_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from sfera_auth.cipher_views import _backend, scope_members, CipherRateThrottle
from sfera_auth.mesh_sessions import CLAIM, MeshJWTAuthentication, MeshUnavailable
from sfera_mesh.consensus_directory import ConsensusUnavailable
from sfera_mesh.storage import canonical
from .dm_cipher import parse, authorize, KIND
from .encryption import encrypt_text
from .models import Conversation, Message, CipherMessageIdentity
from .serializers import MessageSerializer

IDENTITY_LIMIT = 1000000


@never_cache
@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@throttle_classes([CipherRateThrottle])
def status(request, conversation_id):
    """Fresh selected-application SQL state, explicitly not consensus finality."""
    try:
        authority = _backend(request)
        if authority is None: return Response(status=404)
        if set(request.data) != {'nonce', 'messages'} or not isinstance(request.data['nonce'], str) or not re.fullmatch('[0-9a-f]{64}', request.data['nonce']):
            raise ValueError('invalid_cipher_status_request')
        values = request.data['messages']
        if not isinstance(values, list) or not 1 <= len(values) <= 16:
            raise ValueError('invalid_cipher_status_request')
        values = [parse(value, conversation_id) for value in values]
        if len({value['id'] for value in values}) != len(values): raise ValueError('duplicate_cipher_status_id')
        backend, claim = authority.sessions, request.auth[CLAIM]
        with backend.directory.lock, backend.lock, transaction.atomic():
            backend.require(str(request.user.pk), claim)
            members = scope_members(request.user, 'dm', str(conversation_id))
            results = []
            for value in values:
                digest = sha256(canonical(value)).hexdigest()
                consumed = CipherMessageIdentity.objects.filter(pk=value['id'], digest=digest).exists()
                row = Message.objects.filter(pk=value['id']).first()
                state = 'unknown'
                if consumed and row is None: state = 'deleted'
                elif (consumed and str(row.conversation_id) == str(conversation_id) and row.message_type == KIND and
                      canonical(row.payload) == canonical(value)): state = 'present'
                results.append({'id': value['id'], 'digest': digest, 'state': state})
            if sorted(scope_members(request.user, 'dm', str(conversation_id))) != sorted(members): raise ValueError('cipher_status_acl_changed')
            backend.require(str(request.user.pk), claim); backend.directory.anchor()
            if backend.entry_key is None: raise ValueError('signed_application_entry_not_configured')
            now = int(time.time())
            body = {'domain': 'sfera-dm-cipher-status-v1', 'authority': 'selected_application_sql',
                'network': backend.directory.network, 'genesis': backend.directory.pin, 'entry': backend.entry,
                'user': str(request.user.pk), 'owner': claim['owner'], 'device': claim['device'],
                'scope': str(conversation_id), 'nonce': request.data['nonce'], 'issued_at': now, 'expires_at': now + 15,
                'messages': results}
            return Response({'body': body, 'signature': backend.entry_key.sign(canonical(body)).hex()})
    except (ConsensusUnavailable, sqlite3.Error, OperationalError) as exc:
        raise MeshUnavailable() from exc
    except (ValueError, TypeError, KeyError, ObjectDoesNotExist, ValidationError):
        return Response({'error': 'cipher_status_rejected'}, status=409)


@never_cache
@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@throttle_classes([CipherRateThrottle])
def send(request, conversation_id):
    from .mesh_delivery import enabled as delivery_enabled, pending_payload, client_nonce
    try:
        if not getattr(settings, 'SFERA_MESH_CIPHER_MESSAGES', False):
            return Response(status=404)
        authority = _backend(request)
        if authority is None:
            return Response(status=404)
        if set(request.data) - {'cipher', 'nonce'} or 'cipher' not in request.data:
            raise ValueError('invalid_cipher_send_request')
        nonce = client_nonce(request.data.get('nonce'))
        value = parse(request.data['cipher'], conversation_id, author=request.user.pk)
        backend = authority.sessions
        with backend.directory.lock, backend.lock:
            backend.require(str(request.user.pk), request.auth[CLAIM])
            if (value['sender']['owner'], value['sender']['device']) != (request.auth[CLAIM]['owner'], request.auth[CLAIM]['device']):
                raise ValueError('cipher_message_session_mismatch')
            members = scope_members(request.user, 'dm', str(conversation_id))
            with transaction.atomic():
                conversation = Conversation.objects.select_for_update().get(pk=conversation_id, participants=request.user)
                digest = sha256(canonical(value)).hexdigest()
                consumed = CipherMessageIdentity.objects.select_for_update().filter(pk=value['id']).first()
                old = Message.objects.select_for_update().filter(pk=value['id']).first()
                if consumed is not None and (consumed.digest != digest or old is None):
                    return Response({'error': 'cipher_message_deleted' if old is None else 'cipher_message_id_conflict'},
                        status=410 if old is None else 409)
                if consumed is None:
                    if CipherMessageIdentity.objects.count() >= IDENTITY_LIMIT:
                        return Response({'error': 'cipher_message_identity_capacity'}, status=503)
                    CipherMessageIdentity.objects.create(id=value['id'], digest=digest)
                if old is not None:
                    if (old.message_type != KIND or old.conversation_id != conversation.pk or old.author_id != request.user.pk or
                            canonical(old.payload) != canonical(value)):
                        raise ValueError('cipher_message_id_conflict')
                    msg, created = old, False
                else:
                    proof = authority.attest(str(request.user.pk), request.auth[CLAIM], 'dm', str(conversation_id),
                        members, secrets.token_hex(32), revalidate=lambda: scope_members(request.user, 'dm', str(conversation_id)))['body']
                    authorize(value, proof, request.auth[CLAIM])
                    msg = Message(id=value['id'], conversation=conversation, author=request.user,
                        message_type=KIND, encrypted_content=encrypt_text(''))
                    msg.payload = value
                    msg._mesh_nonce = nonce
                    msg.save(force_insert=True)
                    if proof['expires_at'] <= int(time.time()):
                        raise ValueError('cipher_message_authorization_expired')
                    created = True
                if sorted(scope_members(request.user, 'dm', str(conversation_id))) != sorted(members):
                    raise ValueError('cipher_message_acl_changed')
                backend.require(str(request.user.pk), request.auth[CLAIM])
                backend.directory.anchor()
                if delivery_enabled():
                    if MessageSerializer(msg).data['publication_state'] == 'pending':
                        return Response(pending_payload(msg, nonce), status=202)
                payload = dict(MessageSerializer(msg).data)
                if nonce:
                    payload['nonce'] = nonce
                if created:
                    transaction.on_commit(lambda: _deliver(msg, payload))
                return Response(payload, status=201 if created else 200)
    except (ConsensusUnavailable, sqlite3.Error, OperationalError) as exc:
        raise MeshUnavailable() from exc
    except IntegrityError:
        return Response({'error': 'cipher_message_conflict_retry'}, status=409)
    except (ValueError, TypeError, KeyError, ObjectDoesNotExist, ValidationError) as exc:
        oversized = str(exc) in ('cipher_message_too_large', 'message_mesh_body_too_large')
        return Response({'error': 'cipher_message_too_large' if oversized else 'cipher_message_rejected'}, status=413 if oversized else 409)


def _deliver(message, payload):
    from .services import _fanout, _fanout_user_notifs
    _fanout('chat_' + str(message.conversation_id), {'type': 'chat_message', 'message': payload}, payload)
    _fanout_user_notifs(list(message.conversation.participants.exclude(pk=message.author_id).values_list('pk', flat=True)),
        {'type': 'new_message_notification', 'sender_id': str(message.author_id),
         'sender_name': message.author.nickname or message.author.username, 'content': 'Зашифрованное сообщение'})
