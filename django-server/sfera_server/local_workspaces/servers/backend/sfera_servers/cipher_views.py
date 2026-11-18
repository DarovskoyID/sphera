"""Opt-in opaque Guild send and signed selected-SQL status, with real ACLs."""
import re
import secrets
import sqlite3
import time
import logging
from hashlib import sha256
from django.conf import settings
from django.core.exceptions import ObjectDoesNotExist, ValidationError
from django.db import transaction, IntegrityError, OperationalError
from django.utils import timezone
from django.views.decorators.cache import never_cache
from rest_framework.decorators import api_view, authentication_classes, permission_classes, throttle_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from sfera_auth.cipher_views import _backend, scope_members, CipherRateThrottle
from sfera_auth.mesh_sessions import CLAIM, MeshJWTAuthentication, MeshUnavailable
from sfera_mesh.consensus_directory import ConsensusUnavailable
from sfera_mesh.storage import canonical
from sfera_messages.dm_cipher import parse, authorize
from sfera_messages.encryption import encrypt_text
from sfera_messages.mesh_delivery import client_nonce, enabled as delivery_enabled, pending_payload
from sfera_messages.services import _author_brief, _fanout
from sfera_modules.permissions import requires_module
from .models import GuildChannel, GuildMembership, GuildMessage, GuildCipherMessageIdentity


def channel_access(user, guild_id, channel_id, *, write=False):
    channel = GuildChannel.objects.select_for_update().select_related('guild').get(pk=channel_id, guild_id=guild_id)
    member = GuildMembership.objects.select_for_update().get(guild_id=guild_id, user=user)
    if channel.channel_type != 'text' or channel.guild.is_discoverable:
        raise ValueError('cipher_guild_requires_private_text_channel')
    if write and ((member.muted_until and member.muted_until > timezone.now()) or
                  (channel.guild.is_personal_channel and channel.guild.owner_id != user.pk)):
        raise ValueError('cipher_guild_write_forbidden')
    return channel


def message_payload(message, nonce=''):
    from sfera_messages.serializers import MessageSerializer
    result = {'id': str(message.pk), 'channel_id': str(message.channel_id),
        'author': _author_brief(message.author), 'content': '', 'message_type': 'cipher', 'payload': message.payload,
        'created_at': message.created_at.isoformat(), 'is_pinned': message.is_pinned, 'edited': False,
        'attachments': [], 'tags': [], 'reply_to': None, 'reactions': [], 'views': 0, 'comments_count': 0}
    result['publication_state'] = MessageSerializer().get_publication_state(message)
    if nonce:
        result['nonce'] = nonce
    return result


@never_cache
@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@throttle_classes([CipherRateThrottle])
@requires_module('servers')
def send(request, guild_id, channel_id):
    try:
        if not getattr(settings, 'SFERA_MESH_GUILD_CIPHER_MESSAGES', False):
            return Response(status=404)
        authority = _backend(request)
        if authority is None:
            return Response(status=404)
        if set(request.data) - {'cipher', 'nonce'} or 'cipher' not in request.data:
            raise ValueError('invalid_cipher_guild_request')
        nonce = client_nonce(request.data.get('nonce'))
        value = parse(request.data['cipher'], channel_id, author=request.user.pk, source='guild', guild=guild_id)
        backend, claim = authority.sessions, request.auth[CLAIM]
        with backend.directory.lock, backend.lock, transaction.atomic():
            backend.require(str(request.user.pk), claim)
            if (value['sender']['owner'], value['sender']['device']) != (claim['owner'], claim['device']):
                raise ValueError('cipher_guild_session_mismatch')
            channel = channel_access(request.user, guild_id, channel_id, write=True)
            members = scope_members(request.user, 'guild', str(channel_id))
            digest = sha256(canonical(value)).hexdigest()
            consumed = GuildCipherMessageIdentity.objects.select_for_update().filter(pk=value['id']).first()
            old = GuildMessage.objects.select_for_update().filter(pk=value['id']).first()
            if consumed is not None and (consumed.digest != digest or old is None):
                return Response({'error': 'cipher_message_deleted' if old is None else 'cipher_message_id_conflict'},
                    status=410 if old is None else 409)
            if consumed is None:
                if GuildCipherMessageIdentity.objects.count() >= 1000000:
                    return Response({'error': 'cipher_message_identity_capacity'}, status=503)
                GuildCipherMessageIdentity.objects.create(id=value['id'], digest=digest)
            if old is not None:
                if old.message_type != 'cipher' or old.channel_id != channel.pk or old.author_id != request.user.pk or canonical(old.payload) != canonical(value):
                    raise ValueError('cipher_guild_message_id_conflict')
                message, created = old, False
            else:
                proof = authority.attest(str(request.user.pk), claim, 'guild', str(channel_id), members, secrets.token_hex(32),
                    revalidate=lambda: scope_members(request.user, 'guild', str(channel_id)))['body']
                authorize(value, proof, claim)
                consumed = GuildCipherMessageIdentity.objects.get(pk=value['id'])
                consumed.authorization = {'body': proof, 'signature': backend.entry_key.sign(canonical(proof)).hex()}
                consumed.save(update_fields=['authorization'])
                message = GuildMessage(id=value['id'], channel=channel, author=request.user,
                    message_type='cipher', encrypted_content=encrypt_text(''))
                message.payload = value
                message._mesh_nonce = nonce
                message.save(force_insert=True)
                if proof['expires_at'] <= int(time.time()):
                    raise ValueError('cipher_guild_authorization_expired')
                created = True
            if sorted(scope_members(request.user, 'guild', str(channel_id))) != sorted(members):
                raise ValueError('cipher_guild_acl_changed')
            channel_access(request.user, guild_id, channel_id, write=True)
            backend.require(str(request.user.pk), claim)
            backend.directory.anchor()
            payload = message_payload(message, nonce)
            if delivery_enabled() and payload['publication_state'] == 'pending':
                return Response(pending_payload(message, nonce), status=202)
            if created:
                transaction.on_commit(lambda: _fanout('guild_channel_' + str(channel_id),
                    {'type': 'chat_message', 'message': payload}, payload))
            return Response(payload, status=201 if created else 200)
    except (ConsensusUnavailable, sqlite3.Error, OperationalError) as exc:
        raise MeshUnavailable() from exc
    except IntegrityError:
        return Response({'error': 'cipher_guild_conflict_retry'}, status=409)
    except (ValueError, TypeError, KeyError, ObjectDoesNotExist, ValidationError) as exc:
        logging.getLogger(__name__).debug('Guild cipher request rejected: %s', exc)
        large = str(exc) in ('cipher_message_too_large', 'message_mesh_body_too_large')
        return Response({'error': 'cipher_guild_too_large' if large else 'cipher_guild_rejected'}, status=413 if large else 409)


@never_cache
@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@throttle_classes([CipherRateThrottle])
@requires_module('servers')
def status(request, guild_id, channel_id):
    try:
        if not getattr(settings, 'SFERA_MESH_GUILD_CIPHER_MESSAGES', False):
            return Response(status=404)
        authority = _backend(request)
        if authority is None:
            return Response(status=404)
        if set(request.data) != {'nonce', 'messages'} or not isinstance(request.data['nonce'], str) or not re.fullmatch('[0-9a-f]{64}', request.data['nonce']):
            raise ValueError('invalid_cipher_guild_status')
        values = request.data['messages']
        if not isinstance(values, list) or not 1 <= len(values) <= 16:
            raise ValueError('invalid_cipher_guild_status')
        values = [parse(value, channel_id, source='guild', guild=guild_id) for value in values]
        if len({value['id'] for value in values}) != len(values):
            raise ValueError('duplicate_cipher_guild_status_id')
        backend, claim = authority.sessions, request.auth[CLAIM]
        with backend.directory.lock, backend.lock, transaction.atomic():
            backend.require(str(request.user.pk), claim)
            channel_access(request.user, guild_id, channel_id)
            members = scope_members(request.user, 'guild', str(channel_id))
            results = []
            for value in values:
                digest = sha256(canonical(value)).hexdigest()
                consumed = GuildCipherMessageIdentity.objects.filter(pk=value['id'], digest=digest).first()
                row = GuildMessage.objects.filter(pk=value['id']).first()
                state = 'unknown'
                if consumed and row is None:
                    state = 'deleted'
                elif consumed and str(row.channel_id) == str(channel_id) and row.message_type == 'cipher' and canonical(row.payload) == canonical(value):
                    state = 'present'
                results.append({'id': value['id'], 'digest': digest, 'state': state,
                    'authorization': consumed.authorization if state == 'present' and consumed.authorization else None})
            if sorted(scope_members(request.user, 'guild', str(channel_id))) != sorted(members):
                raise ValueError('cipher_guild_acl_changed')
            backend.require(str(request.user.pk), claim)
            backend.directory.anchor()
            if backend.entry_key is None:
                raise ValueError('signed_application_entry_not_configured')
            now = int(time.time())
            body = {'domain': 'sfera-guild-cipher-status-v1', 'authority': 'selected_application_sql',
                'network': backend.directory.network, 'genesis': backend.directory.pin, 'entry': backend.entry,
                'user': str(request.user.pk), 'owner': claim['owner'], 'device': claim['device'],
                'guild': str(guild_id), 'scope': str(channel_id), 'nonce': request.data['nonce'],
                'issued_at': now, 'expires_at': now + 15, 'messages': results}
            document = {'body': body, 'signature': backend.entry_key.sign(canonical(body)).hex()}
            if len(canonical(document)) > 1048576: return Response({'error': 'cipher_guild_status_batch_too_large'}, status=413)
            return Response(document)
    except (ConsensusUnavailable, sqlite3.Error, OperationalError) as exc:
        raise MeshUnavailable() from exc
    except (ValueError, TypeError, KeyError, ObjectDoesNotExist, ValidationError):
        return Response({'error': 'cipher_guild_status_rejected'}, status=409)
