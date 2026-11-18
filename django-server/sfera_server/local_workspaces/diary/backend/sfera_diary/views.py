"""Personal diaries API (mounted at /api/diary/). Owner-only everywhere."""
import uuid

from django.core.files.base import ContentFile
from django.db import transaction
from django.http import HttpResponse
from django.utils.dateparse import parse_datetime
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from sfera_messages.encryption import decrypt_bytes, encrypt_bytes
from sfera_messages.models import MESSAGE_TYPE_LOCATION, MESSAGE_TYPE_POLL, MESSAGE_TYPE_TODO
from sfera_messages.rich import RichError, _poll_expired, location_view, poll_view, rich_fields, todo_view
from sfera_messages.services import (
    GUILD_RICH_TYPES, MAX_UPLOAD_SIZE, _apply_location_update, _apply_message_edit, _author_brief,
    _build_rich, _clean_tags, _id_list, _safe_upload, _scan_upload, _toggle_todo_item,
)
from sfera_modules.hooks import push_to_user
from sfera_modules.permissions import requires_module

from .models import MAX_DIARIES, Diary, DiaryAttachment, DiaryEntry, DiaryPollVote, DiaryTodoCheck

MODULE = 'diary'
PAGE_MAX = 200


def _not_found():
    return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)


def _diary_data(d):
    return {'id': str(d.id), 'name': d.name, 'created_at': d.created_at.isoformat()}


def _attachment_data(att):
    return {
        'id': str(att.id),
        'filename': att.original_filename,
        'content_type': att.content_type,
        'file_size': att.file_size,
        'url': f'/api/diary/attachments/{att.id}/',
    }


def entry_data(e, user=None):
    return {
        'id': str(e.id),
        'diary_id': str(e.diary_id),
        'author': _author_brief(e.author),
        'content': e.content,
        'created_at': e.created_at.isoformat(),
        'edited': e.edited,
        'tags': e.tags or [],
        'attachments': [_attachment_data(a) for a in e.attachments.all()],
        **rich_fields(e, user),
    }


def _entries_qs():
    return DiaryEntry.objects.select_related('author').prefetch_related(
        'attachments', 'poll_votes__user', 'todo_checks__user',
    )


def _push(user, event, payload):
    # Keep the owner's other devices in sync (signaling socket → wsBus).
    try:
        push_to_user(user.id, event, payload)
    except Exception:
        pass


def _own_entry(request, entry_id, **filters):
    return _entries_qs().get(id=entry_id, diary__owner=request.user, **filters)


# ── Diaries ──────────────────────────────────────────────────────────────────

@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def diary_list_create(request):
    mine = Diary.objects.filter(owner=request.user)
    if request.method == 'GET':
        return Response([_diary_data(d) for d in mine])
    name = (request.data.get('name') or '').strip()[:100]
    if not name:
        return Response({'error': 'name required'}, status=status.HTTP_400_BAD_REQUEST)
    if mine.count() >= MAX_DIARIES:
        return Response({'error': 'limit reached', 'limit': MAX_DIARIES}, status=status.HTTP_409_CONFLICT)
    d = Diary.objects.create(owner=request.user, name=name)
    _push(request.user, 'diary.changed', {})
    return Response(_diary_data(d), status=status.HTTP_201_CREATED)


@api_view(['PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def diary_detail(request, diary_id):
    d = Diary.objects.filter(id=diary_id, owner=request.user).first()
    if d is None:
        return _not_found()
    if request.method == 'PATCH':
        name = (request.data.get('name') or '').strip()[:100]
        if not name:
            return Response({'error': 'name required'}, status=status.HTTP_400_BAD_REQUEST)
        d.name = name
        d.save(update_fields=['name'])
        _push(request.user, 'diary.changed', {})
        return Response(_diary_data(d))
    # Deleting a whole diary is irreversible: confirm with the account password.
    password = request.data.get('password', '')
    if not password or not request.user.check_password(password):
        return Response({'error': 'invalid password'}, status=status.HTTP_403_FORBIDDEN)
    files = [a.file for a in d.attachments.all()]
    d.delete()
    for f in files:
        try:
            f.delete(save=False)
        except Exception:
            pass
    _push(request.user, 'diary.changed', {})
    return Response(status=status.HTTP_204_NO_CONTENT)


# ── Entries ──────────────────────────────────────────────────────────────────

@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def entry_list_create(request, diary_id):
    d = Diary.objects.filter(id=diary_id, owner=request.user).first()
    if d is None:
        return _not_found()

    if request.method == 'GET':
        try:
            limit = min(max(int(request.GET.get('limit', 50)), 1), PAGE_MAX)
        except ValueError:
            limit = 50
        qs = _entries_qs().filter(diary=d).order_by('-created_at')
        before = parse_datetime(request.GET.get('before_ts') or '')
        if before:
            qs = qs.filter(created_at__lt=before)
        rows = list(qs[:limit])
        rows.reverse()
        return Response([entry_data(e, request.user) for e in rows])

    content = (request.data.get('content') or '').strip()
    try:
        ids = _id_list(request.data.get('attachment_ids'))
    except ValueError:
        return Response({'error': 'invalid attachment'}, status=status.HTTP_400_BAD_REQUEST)
    atts = DiaryAttachment.objects.filter(id__in=ids, diary=d, uploader=request.user, entry__isnull=True)
    if atts.count() != len(set(ids)):
        return Response({'error': 'invalid attachment'}, status=status.HTTP_400_BAD_REQUEST)
    if not content and not ids:
        return Response({'error': 'empty entry'}, status=status.HTTP_400_BAD_REQUEST)

    with transaction.atomic():
        e = DiaryEntry(diary=d, author=request.user, tags=_clean_tags(request.data.get('tags')))
        e.content = content
        e.save()
        atts.update(entry=e)
    data = entry_data(_entries_qs().get(id=e.id), request.user)
    _push(request.user, 'diary.entry', {'entry': data})
    return Response(data, status=status.HTTP_201_CREATED)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def entry_rich_create(request, diary_id):
    d = Diary.objects.filter(id=diary_id, owner=request.user).first()
    if d is None:
        return _not_found()
    kind = (request.data.get('type') or '').strip()
    if kind not in GUILD_RICH_TYPES:
        return Response({'error': 'unsupported message type'}, status=status.HTTP_400_BAD_REQUEST)
    try:
        payload, live_until = _build_rich(kind, request.data.get('payload') or {})
    except RichError as exc:
        return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    e = DiaryEntry(
        diary=d, author=request.user, message_type=kind, live_until=live_until,
        tags=_clean_tags(request.data.get('tags')),
    )
    e.content = (request.data.get('content') or '').strip()[:2000]
    e.payload = payload
    e.save()
    data = entry_data(_entries_qs().get(id=e.id), request.user)
    _push(request.user, 'diary.entry', {'entry': data})
    return Response(data, status=status.HTTP_201_CREATED)


@api_view(['PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def entry_detail(request, entry_id):
    try:
        e = _own_entry(request, entry_id)
    except DiaryEntry.DoesNotExist:
        return _not_found()
    if request.method == 'PATCH':
        try:
            _apply_message_edit(e, request.data)
            if 'tags' in request.data:
                e.tags = _clean_tags(request.data.get('tags'))
                e.save(update_fields=['tags'])
        except RichError as exc:
            return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        data = entry_data(_entries_qs().get(id=e.id), request.user)
        _push(request.user, 'diary.entry_updated', {'entry': data})
        return Response(data)
    files = [a.file for a in e.attachments.all()]
    diary_id = str(e.diary_id)
    e.attachments.all().delete()
    e.delete()
    for f in files:
        try:
            f.delete(save=False)
        except Exception:
            pass
    _push(request.user, 'diary.entry_deleted', {'entry_id': str(entry_id), 'diary_id': diary_id})
    return Response(status=status.HTTP_204_NO_CONTENT)


# ── Rich interactions ────────────────────────────────────────────────────────

def _rich_reply(request, e, event_key, view_fn):
    e = _entries_qs().get(id=e.id)
    _push(request.user, 'diary.entry_updated', {'entry': entry_data(e, request.user)})
    return Response({event_key: view_fn(e, request.user)})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def poll_vote(request, entry_id):
    try:
        e = _own_entry(request, entry_id, message_type=MESSAGE_TYPE_POLL)
    except DiaryEntry.DoesNotExist:
        return _not_found()
    poll = e.payload
    if poll.get('closed') or _poll_expired(poll):
        return Response({'error': 'poll is closed'}, status=status.HTTP_409_CONFLICT)
    option_ids = request.data.get('option_ids')
    if not isinstance(option_ids, list):
        return Response({'error': 'option_ids must be a list'}, status=status.HTTP_400_BAD_REQUEST)
    valid = {o['id'] for o in poll.get('options', [])}
    chosen = list(dict.fromkeys(o for o in option_ids if o in valid))
    if not poll.get('multiple') and len(chosen) > 1:
        return Response({'error': 'this poll allows a single choice'}, status=status.HTTP_400_BAD_REQUEST)
    with transaction.atomic():
        DiaryPollVote.objects.filter(message=e, user=request.user).delete()
        DiaryPollVote.objects.bulk_create([DiaryPollVote(message=e, user=request.user, option_id=o) for o in chosen])
    return _rich_reply(request, e, 'poll', poll_view)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def poll_close(request, entry_id):
    try:
        e = _own_entry(request, entry_id, message_type=MESSAGE_TYPE_POLL)
    except DiaryEntry.DoesNotExist:
        return _not_found()
    payload = e.payload
    payload['closed'] = True
    e.payload = payload
    e.save(update_fields=['encrypted_payload'])
    return _rich_reply(request, e, 'poll', poll_view)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def todo_toggle(request, entry_id):
    try:
        e = _own_entry(request, entry_id, message_type=MESSAGE_TYPE_TODO)
        _toggle_todo_item(e, DiaryTodoCheck, request.user, request.data.get('item_id'))
    except DiaryEntry.DoesNotExist:
        return _not_found()
    except RichError as exc:
        return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return _rich_reply(request, e, 'todo', todo_view)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def location_update(request, entry_id):
    try:
        e = _own_entry(request, entry_id, message_type=MESSAGE_TYPE_LOCATION)
        _apply_location_update(e, request.data, stop=bool(request.data.get('stop')))
    except DiaryEntry.DoesNotExist:
        return _not_found()
    except RichError as exc:
        return Response({'error': str(exc)}, status=status.HTTP_409_CONFLICT)
    return _rich_reply(request, e, 'location', location_view)


# ── Attachments ──────────────────────────────────────────────────────────────

@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def upload(request, diary_id):
    d = Diary.objects.filter(id=diary_id, owner=request.user).first()
    if d is None:
        return _not_found()
    uploaded = request.FILES.get('file')
    if not uploaded:
        return Response({'error': 'no file provided'}, status=status.HTTP_400_BAD_REQUEST)
    if uploaded.size > MAX_UPLOAD_SIZE:
        return Response({'error': 'file too large (max 50 MB)'}, status=status.HTTP_400_BAD_REQUEST)
    ok, content_type = _safe_upload(uploaded)
    if not ok:
        return Response({'error': 'file type not allowed'}, status=status.HTTP_400_BAD_REQUEST)
    raw = uploaded.read()
    if not _scan_upload(raw):
        return Response({'error': 'file rejected by scanner'}, status=status.HTTP_400_BAD_REQUEST)
    att = DiaryAttachment(
        diary=d, uploader=request.user, original_filename=uploaded.name,
        content_type=content_type, file_size=len(raw),
    )
    att.file.save(f'{uuid.uuid4().hex}.enc', ContentFile(encrypt_bytes(raw)), save=True)
    return Response(_attachment_data(att), status=status.HTTP_201_CREATED)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def download(request, attachment_id):
    att = DiaryAttachment.objects.filter(id=attachment_id, diary__owner=request.user).first()
    if att is None:
        return _not_found()
    try:
        with att.file.open('rb') as f:
            data = decrypt_bytes(f.read())
    except FileNotFoundError:
        return _not_found()
    response = HttpResponse(data, content_type=att.content_type)
    filename = att.original_filename.replace('"', '\\"')
    response['Content-Disposition'] = f'attachment; filename="{filename}"'
    response['Content-Length'] = att.file_size
    response['X-Content-Type-Options'] = 'nosniff'
    return response
