"""Authenticated read-only recovery. Never creates accounts or source rows."""
from functools import wraps
from hashlib import sha256
import re
import sqlite3
import subprocess
import time

from cryptography.fernet import InvalidToken
from django.apps import apps
from django.conf import settings
from django.db import DatabaseError
from django.http import HttpResponse
from django.utils.http import content_disposition_header
from django.utils.dateparse import parse_datetime
from rest_framework.decorators import api_view, authentication_classes, permission_classes, throttle_classes
from rest_framework.exceptions import APIException, NotFound, ParseError, PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle

from sfera_auth.mesh_sessions import MeshJWTAuthentication
from sfera_mesh.directory import digest64
from sfera_mesh.storage import canonical
from sfera_mesh.recovery_roots import current_root
from .mesh_history import _uuid
from .mesh_read import read_config
from .mesh_reader import open_reader
from .mesh_recovery_index import _index, read_index_messages, read_index_attachment
from .mesh_paged_read import PagedRecoveryRead, read_paged_bodies, read_paged_attachment


class RecoveryUnavailable(APIException):
    status_code = 503
    default_detail = 'confirmed_history_unavailable'


class RecoveryChanged(APIException):
    status_code = 409
    default_detail = 'history_changed_refresh_required'


class RecoveryWarming(RecoveryUnavailable):
    default_detail = 'history_verification_in_progress'
    wait = 1


class RecoveryThrottle(UserRateThrottle):
    scope = 'mesh_recovery'
    rate = '60/min'


def recovery_view(view):
    authenticated = api_view(['GET'])(authentication_classes([MeshJWTAuthentication])(
        permission_classes([IsAuthenticated])(throttle_classes([RecoveryThrottle])(view))))
    @wraps(authenticated)
    def wrapped(*args, **kwargs):
        response = authenticated(*args, **kwargs)
        response['Cache-Control'] = 'no-store, private'
        response['Pragma'] = 'no-cache'
        response['X-Content-Type-Options'] = 'nosniff'
        return response
    return wrapped


def _account(user):
    from sfera_auth.models import User, UserBan
    from sfera_auth.mesh_views import _allowed
    if (not _allowed(user) or not User.objects.filter(pk=user.pk, is_active=True).exists() or
            UserBan.objects.filter(user_id=user.pk).exists()):
        raise PermissionDenied('account_access_blocked')


def _configuration(user):
    if not getattr(settings, 'SFERA_MESH_RECOVERY_READS', False):
        raise NotFound()
    _account(user)
    from .mesh_index_worker import enabled
    publisher = getattr(settings, 'SFERA_MESH_RECOVERY_PUBLISHER', '')
    if not enabled() or not digest64(publisher):
        raise RecoveryUnavailable()
    return publisher


def _guild_allowed(user):
    from sfera_modules.permissions import has_module
    return apps.is_installed('sfera_servers') and has_module(user, 'servers')


def _live_access(user, source, scope, document=None, *, paged=None):
    from .models import Conversation, MessageMeshWrite
    from .mesh_sources import source_model, scope_field
    _account(user)
    if source not in ('dm', 'guild'):
        raise ParseError('invalid_history_source')
    if source == 'dm':
        origin = Conversation.objects.filter(pk=scope).first()
        if origin is not None and not origin.participants.filter(pk=user.pk).exists():
            raise PermissionDenied('history_access_denied')
        members = sorted(str(value) for value in origin.participants.values_list('pk', flat=True)[:65]) if origin else None
        public, guild_id = False, None
    else:
        if not _guild_allowed(user):
            raise PermissionDenied('module_not_installed')
        origin = apps.get_model('sfera_servers.GuildChannel').objects.select_related('guild').filter(pk=scope).first()
        if origin is not None:
            from .mesh_guild import can_read
            if not can_read(user, origin):
                raise PermissionDenied('history_access_denied')
        guild_id = str(origin.guild_id) if origin else None
        members = sorted(str(value) for value in apps.get_model('sfera_servers.GuildMembership').objects
            .filter(guild_id=guild_id).values_list('user_id', flat=True)[:65]) if origin else None
        public = origin.guild.is_discoverable if origin else None
    if document is None:
        return
    if origin is not None and (document['members'] != members or document['public'] != public or document['guild_id'] != guild_id):
        raise RecoveryUnavailable('history_membership_update_pending')
    writes = MessageMeshWrite.objects.filter(source=source, conversation_id=scope)
    if writes.filter(state='pending').exists():
        raise RecoveryUnavailable('history_update_pending')
    if paged is not None:
        from .mesh_paged_guard import check_sql_pages, GuardMismatch, GuardWarming
        deleted = writes.filter(format_version=4).order_by('message_id').values_list('message_id', flat=True).distinct()
        rows = source_model(source).objects.filter(**{scope_field(source): scope}).order_by('pk').values_list('pk', 'mesh_write_id')
        try: check_sql_pages(paged, deleted.iterator(chunk_size=128), rows.iterator(chunk_size=128))
        except GuardWarming as exc: raise RecoveryWarming() from exc
        except GuardMismatch as exc: raise RecoveryUnavailable(str(exc)) from exc
        return
    deleted = set(entry['message_id'] for entry in document['entries'] if entry['deleted'])
    if writes.filter(format_version=4).exclude(message_id__in=deleted).exists():
        raise RecoveryUnavailable('history_deletion_update_pending')
    entries = {entry['message_id']: entry for entry in document['entries'] if not entry['deleted']}
    rows = list(source_model(source).objects.filter(**{scope_field(source): scope}).values_list('pk', 'mesh_write_id')[:257])
    if len(rows) > 256:
        raise RecoveryUnavailable()
    for pk, write_id in rows:
        entry = entries.get(str(pk))
        expected = sha256(canonical({'domain': 'sfera-mesh-django-message-write-v1', 'message': str(pk),
            'snapshot': entry['snapshot_hash']})).hexdigest() if entry else None
        if entry is None or write_id != expected:
            raise RecoveryUnavailable('history_revision_update_pending')


def _parameters(request, allowed):
    if set(request.query_params) - set(allowed) or any(len(request.query_params.getlist(key)) != 1 for key in request.query_params):
        raise ParseError('invalid_history_query')
    return request.query_params


def _translate(operation):
    try:
        return operation()
    except PermissionError as exc:
        raise PermissionDenied('history_access_denied') from exc
    except ValueError as exc:
        if 'root_changed' in str(exc):
            raise RecoveryChanged() from exc
        if str(exc) == 'recovery_timeline_cursor_unknown':
            raise ParseError('invalid_history_cursor') from exc
        raise RecoveryUnavailable() from exc
    except (OSError, InvalidToken, sqlite3.Error, DatabaseError, subprocess.SubprocessError) as exc:
        raise RecoveryUnavailable() from exc


def _catalog(reader, publisher, *, paged=False):
    directory = reader.publication.directory
    with directory.lock:
        directory.anchor()
        trees = directory.current['state'].get('recovery_trees', {})
        heads = {key: head for key, head in directory.current['state'].get('recovery_trees' if paged else 'recovery_roots', {}).items()
            if (paged or key not in trees) and head['record']['body']['publisher'] == publisher}
        fingerprint = sha256(canonical({key: head['digest'] for key, head in heads.items()})).hexdigest()
        return heads, fingerprint, directory.pin


@recovery_view
def paged_scopes(request):
    def operation():
        publisher = _configuration(request.user)
        query = _parameters(request, {'after', 'catalog', 'limit'})
        try:
            limit = int(query.get('limit', 4))
        except ValueError as exc:
            raise ParseError('invalid_history_limit') from exc
        after, expected = query.get('after'), query.get('catalog')
        if (not 1 <= limit <= 4 or (expected is not None and not digest64(expected)) or
                (after is not None and (not digest64(after) or not digest64(expected)))):
            raise ParseError('invalid_history_cursor')
        with open_reader(read_config()) as reader:
            heads, catalog, genesis = _catalog(reader, publisher, paged=True)
            if expected is not None and expected != catalog:
                raise RecoveryChanged()
            if after is not None and after not in heads:
                raise ParseError('invalid_history_cursor')
            keys = sorted(key for key in heads if after is None or key > after)
            selected, result, reads = keys[:limit], [], []
            deadline = time.monotonic() + 25
            for identity in selected:
                root = heads[identity]['record']['body']; source, scope = root['source'], root['scope']
                try:
                    _live_access(request.user, source, scope)
                    def authorize(index, source=source, scope=scope):
                        _live_access(request.user, source, scope, index.document, paged=index)
                        _session_current(request)
                    read = PagedRecoveryRead(reader, publisher, source, scope, request.user.pk,
                        expected_root=heads[identity]['digest'], authorize_paged=authorize, deadline=deadline)
                    read.finish()
                except (PermissionError, PermissionDenied):
                    continue
                reads.append(read)
                result.append({'source': source, 'scope': scope, 'root_hash': read.head['digest'],
                    'generation': read.root['version'], 'messages': read.root['count'] - read.root['deleted_count'],
                    'deleted_count': read.root['deleted_count']})
            for read in reads:
                read.finish()
            if _catalog(reader, publisher, paged=True)[1] != catalog or time.monotonic() >= deadline:
                raise RecoveryChanged()
            return Response({'domain': 'sfera-mesh-recovery-catalog-v2', 'publisher': publisher, 'genesis': genesis,
                'catalog': catalog, 'scopes': result, 'next_after': selected[-1] if len(keys) > len(selected) else None})
    return _translate(operation)


@recovery_view
def scopes(request):
    def operation():
        publisher = _configuration(request.user)
        query = _parameters(request, {'after', 'catalog', 'limit'})
        try:
            limit = int(query.get('limit', 4))
        except ValueError as exc:
            raise ParseError('invalid_history_limit') from exc
        after, expected = query.get('after'), query.get('catalog')
        if (not 1 <= limit <= 4 or (expected is not None and not digest64(expected)) or
                (after is not None and (not digest64(after) or not digest64(expected)))):
            raise ParseError('invalid_history_cursor')
        with open_reader(read_config()) as reader:
            heads, catalog, genesis = _catalog(reader, publisher)
            if expected is not None and expected != catalog:
                raise RecoveryChanged()
            if after is not None and after not in heads:
                raise ParseError('invalid_history_cursor')
            keys = sorted(key for key in heads if after is None or key > after)
            selected, result, authorized = keys[:limit], [], []
            deadline = time.monotonic() + 25
            for identity in selected:
                root = heads[identity]['record']['body']; source, scope = root['source'], root['scope']
                try:
                    _live_access(request.user, source, scope)
                    head, document, _ = _index(reader, publisher, source, scope, request.user.pk, heads[identity]['digest'], deadline,
                        lambda doc: _live_access(request.user, source, scope, doc))
                except (PermissionError, PermissionDenied):
                    continue
                live = [entry for entry in document['entries'] if not entry['deleted']]
                result.append({'source': source, 'scope': scope, 'root_hash': head['digest'], 'generation': root['version'],
                    'messages': len(live), 'latest_at': max((entry['created_at'] for entry in live), key=parse_datetime, default=None)})
                authorized.append(document)
            if _catalog(reader, publisher)[1] != catalog or time.monotonic() >= deadline:
                raise RecoveryChanged()
            for document in authorized:
                _live_access(request.user, document['source'], document['scope'], document)
            return Response({'domain': 'sfera-mesh-recovery-catalog-v1', 'publisher': publisher, 'genesis': genesis,
                'catalog': catalog, 'scopes': result, 'next_after': selected[-1] if len(keys) > len(selected) else None})
    return _translate(operation)


@recovery_view
def messages(request, source, scope):
    def operation():
        publisher = _configuration(request.user)
        query = _parameters(request, {'root', 'before', 'limit'})
        root, before = query.get('root'), query.get('before')
        try:
            limit = int(query.get('limit', 32))
        except ValueError as exc:
            raise ParseError('invalid_history_limit') from exc
        if (not 1 <= limit <= 32 or (root is not None and not digest64(root)) or
                (before is not None and (not _uuid(before) or root is None))):
            raise ParseError('invalid_history_cursor')
        _live_access(request.user, source, str(scope))
        with open_reader(read_config()) as reader:
            result = read_index_messages(reader, publisher, source, str(scope), request.user.pk, limit=limit,
                before=before, expected_root=root, authorize=lambda doc: _live_access(request.user, source, str(scope), doc))
            result.update(publisher=publisher, genesis=reader.publication.directory.pin)
            for message in result['messages']:
                for file in message['attachments']:
                    file['url'] = f"/api/mesh/recovery/{source}/{scope}/messages/{message['id']}/attachments/{file['id']}/?root={result['root_hash']}"
        return Response(result)
    return _translate(operation)


@recovery_view
def entries(request, source, scope):
    """Bounded UUID-ordered v2 metadata, including terminal deletion markers."""
    def operation():
        publisher = _configuration(request.user)
        query = _parameters(request, {'root', 'before', 'limit', 'order'})
        before = query.get('before')
        try:
            limit = int(query.get('limit', 32))
        except ValueError as exc:
            raise ParseError('invalid_history_limit') from exc
        order = query.get('order', 'uuid')
        if (order not in ('uuid', 'time') or not digest64(query.get('root')) or not 1 <= limit <= 32 or
                (before is not None and not _uuid(before))):
            raise ParseError('invalid_history_cursor')
        _live_access(request.user, source, str(scope))
        def authorize(paged):
            _live_access(request.user, source, str(scope), paged.document, paged=paged)
            _session_current(request)
        with open_reader(read_config()) as reader:
            read = PagedRecoveryRead(reader, publisher, source, str(scope), request.user.pk,
                expected_root=query['root'], authorize_paged=authorize)
            if order == 'time':
                selected, next_before = read.reader.chronological(before=before, limit=limit)
            else:
                selected = read.reader.enumerate(before=before, limit=limit)
                next_before = selected[-1]['message_id'] if len(selected) == limit else None
            finality = read.finish()
            return Response({'domain': 'sfera-mesh-recovery-entries-v2', 'publisher': publisher,
                'genesis': reader.publication.directory.pin, 'source': source, 'scope': str(scope),
                'root_hash': read.head['digest'], 'generation': read.root['version'], 'order': 'time_desc' if order == 'time' else 'uuid_desc',
                'count': read.root['count'], 'deleted_count': read.root['deleted_count'],
                'entries': selected, 'next_before': next_before,
                'finality': finality})
    return _translate(operation)


@recovery_view
def bodies(request, source, scope):
    """Explicit UUID lookup in v2; does not pretend UUID order is chronology."""
    def operation():
        publisher = _configuration(request.user)
        query = _parameters(request, {'root', 'ids'})
        identities = query.get('ids', '').split(',')
        if (not digest64(query.get('root')) or not 1 <= len(identities) <= 32 or
                any(not _uuid(identity) for identity in identities) or len(set(identities)) != len(identities)):
            raise ParseError('history_root_and_message_ids_required')
        _live_access(request.user, source, str(scope))
        def authorize(paged):
            _live_access(request.user, source, str(scope), paged.document, paged=paged)
            _session_current(request)
        with open_reader(read_config()) as reader:
            result = read_paged_bodies(reader, publisher, source, str(scope), request.user.pk, identities,
                expected_root=query['root'], authorize_paged=authorize)
            result.update(publisher=publisher, genesis=reader.publication.directory.pin)
        return Response(result)
    return _translate(operation)


def _session_current(request):
    from sfera_auth.mesh_sessions import CLAIM, sessions
    from rest_framework.exceptions import AuthenticationFailed
    if CLAIM in request.auth:
        try:
            sessions().require(str(request.user.pk), request.auth[CLAIM])
        except ValueError as exc:
            raise AuthenticationFailed('mesh_device_session_revoked') from exc


@recovery_view
def deletion_pages(request, source, scope):
    """Signed complete terminal ranges of one pinned v2 head, at most 256 IDs."""
    def operation():
        from sfera_auth.mesh_sessions import CLAIM, sessions
        publisher = _configuration(request.user)
        query = _parameters(request, {'root', 'nonce', 'before'})
        before = query.get('before')
        if not digest64(query.get('root')) or not digest64(query.get('nonce')) or (before is not None and not _uuid(before)):
            raise ParseError('invalid_history_deletion_cursor')
        if CLAIM not in request.auth: raise PermissionDenied('mesh_device_session_required')
        backend, claim = sessions(), request.auth[CLAIM]
        backend.require(str(request.user.pk), claim)
        if backend.entry_key is None: raise RecoveryUnavailable('entry_signing_identity_required')
        _live_access(request.user, source, str(scope))
        def authorize(index):
            _live_access(request.user, source, str(scope), index.document, paged=index)
            _session_current(request)
        with open_reader(read_config()) as reader:
            read = PagedRecoveryRead(reader, publisher, source, str(scope), request.user.pk,
                expected_root=query['root'], authorize_paged=authorize)
            directory = reader.publication.directory
            if (directory.pin, directory.network) != (backend.directory.pin, backend.directory.network):
                raise RecoveryUnavailable('entry_recovery_network_mismatch')
            found = read.reader.deletions(before=before)
            selected = found[:256]
            read.finish()
            now = int(time.time())
            body = {'domain': 'sfera-mesh-archive-deletion-page-v2', 'network': directory.network,
                'genesis': directory.pin, 'entry': backend.entry, 'user': str(request.user.pk),
                'owner': claim['owner'], 'publisher': publisher, 'source': source, 'scope': str(scope),
                'root': read.head['digest'], 'version': read.root['version'], 'deleted': selected,
                'before': before, 'next_before': selected[-1] if len(found) > 256 else None,
                'total_deleted': read.root['deleted_count'], 'nonce': query['nonce'], 'issued_at': now,
                'expires_at': now + 15, 'authority': 'selected_entry_verified_consensus'}
            return Response({'body': body, 'signature': backend.entry_key.sign(canonical(body)).hex()})
    return _translate(operation)


@recovery_view
def deletions(request, source, scope):
    """Pinned entry attestation; the browser does not independently verify BFT."""
    def operation():
        from sfera_auth.mesh_sessions import CLAIM, sessions
        publisher = _configuration(request.user)
        query = _parameters(request, {'root', 'nonce'})
        if not digest64(query.get('root')) or not digest64(query.get('nonce')):
            raise ParseError('history_root_and_nonce_required')
        if CLAIM not in request.auth:
            raise PermissionDenied('mesh_device_session_required')
        backend = sessions()
        claim = request.auth[CLAIM]
        backend.require(str(request.user.pk), claim)
        if backend.entry_key is None:
            raise RecoveryUnavailable('entry_signing_identity_required')
        _live_access(request.user, source, str(scope))
        deadline = time.monotonic() + 15
        with open_reader(read_config()) as reader:
            head, document, _ = _index(reader, publisher, source, str(scope), request.user.pk,
                query['root'], deadline, authorize=lambda doc: _live_access(request.user, source, str(scope), doc))
            directory = reader.publication.directory
            if (directory.pin, directory.network) != (backend.directory.pin, backend.directory.network):
                raise RecoveryUnavailable('entry_recovery_network_mismatch')
            if hasattr(reader, 'refresh'):
                reader.refresh()
            if current_root(directory, publisher, source, str(scope))['digest'] != head['digest']:
                raise RecoveryChanged()
            _live_access(request.user, source, str(scope), document)
            backend.require(str(request.user.pk), claim)
            if time.monotonic() >= deadline:
                raise RecoveryUnavailable()
            now = int(time.time())
            root = head['record']['body']
            body = {'domain': 'sfera-mesh-archive-deletions-v1', 'network': directory.network,
                'genesis': directory.pin, 'entry': backend.entry, 'user': str(request.user.pk),
                'owner': claim['owner'], 'publisher': publisher, 'source': source, 'scope': str(scope),
                'root': head['digest'], 'version': root['version'], 'deleted': list(root['deleted']),
                'nonce': query['nonce'], 'issued_at': now, 'expires_at': now + 15,
                'authority': 'selected_entry_verified_consensus'}
            return Response({'body': body, 'signature': backend.entry_key.sign(canonical(body)).hex()})
    return _translate(operation)


@recovery_view
def attachment(request, source, scope, message_id, attachment_id):
    def operation():
        publisher = _configuration(request.user)
        query = _parameters(request, {'root'})
        if not digest64(query.get('root')):
            raise ParseError('history_root_required')
        _live_access(request.user, source, str(scope))
        with open_reader(read_config()) as reader:
            from sfera_mesh.recovery_roots import namespace
            directory = reader.publication.directory
            with directory.lock:
                directory.anchor()
                paged = namespace(publisher, source, str(scope)) in directory.current['state'].get('recovery_trees', {})
            if paged:
                def authorize(index):
                    _live_access(request.user, source, str(scope), index.document, paged=index)
                    _session_current(request)
                result = read_paged_attachment(reader, publisher, source, str(scope), request.user.pk,
                    str(message_id), str(attachment_id), expected_root=query['root'], authorize_paged=authorize)
            else:
                result = read_index_attachment(reader, publisher, source, str(scope), request.user.pk, str(message_id), str(attachment_id),
                    expected_root=query['root'], authorize=lambda doc: _live_access(request.user, source, str(scope), doc))
        response = HttpResponse(result['content'], content_type='application/octet-stream')
        filename = re.sub(r'[\x00-\x1f\x7f/\\]', '_', result['filename'])[:200] or 'recovered-file'
        response['Content-Disposition'] = content_disposition_header(True, filename)
        response['Content-Length'] = len(result['content'])
        response['X-Recovery-Root'] = result['root_hash']
        response['Access-Control-Expose-Headers'] = 'X-Recovery-Root'
        return response
    return _translate(operation)
