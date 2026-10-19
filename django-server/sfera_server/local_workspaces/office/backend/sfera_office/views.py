"""Documents API (mounted at /api/office/).

Edits arrive as small ops, by socket normally and over HTTP when the socket is
down. Both paths go through ``commit_ops``, which patches one JSON row under a
row lock, so concurrent authors serialise per document and never per server.
"""
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Q
from django.http import HttpResponse
from django.utils import timezone
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from sfera_messages.services import _author_brief
from sfera_modules.permissions import requires_module
from sfera_server.metrics import inc as metrics_inc

from . import export as exporters
from .models import (
    KIND_DECK, KIND_DOC, KIND_SHEET, MAX_COMMENTS, MAX_DOCS_PER_USER, REVISION_EVERY, REVISIONS_KEPT,
    ROLE_EDITOR, ROLE_OWNER, ROLE_VIEWER, Doc, DocComment, DocMember, DocRevision, empty_doc,
)
from .ops import OpError, apply_ops

MODULE = 'office'
KINDS = (KIND_DOC, KIND_SHEET, KIND_DECK)
PAGE = 60


def _err(code, status=400, **extra):
    return Response({'error': code, **extra}, status=status)


def group_name(doc_id):
    return f'office_{doc_id}'


def broadcast(doc_id, message: dict):
    layer = get_channel_layer()
    if layer is None:
        return
    try:
        async_to_sync(layer.group_send)(group_name(doc_id), {'type': 'doc.event', 'message': message})
    except Exception:
        pass


def role_of(user, doc_id):
    m = DocMember.objects.filter(doc_id=doc_id, user=user).only('role').first()
    return m.role if m else None


def _size(doc):
    data = doc.data or {}
    if doc.kind == KIND_SHEET:
        return len(data.get('cells') or {})
    if doc.kind == KIND_DECK:
        return len(data.get('slides') or {})
    return len(data.get('blocks') or {})


def _brief(doc, role):
    return {
        'id': str(doc.id), 'kind': doc.kind, 'title': doc.title, 'role': role, 'version': doc.version,
        'size': _size(doc), 'owner': _author_brief(doc.owner) if doc.owner_id else None,
        'created_at': doc.created_at.isoformat(), 'updated_at': doc.updated_at.isoformat(),
    }


def _full(doc, role):
    return {
        **_brief(doc, role),
        'data': doc.data,
        'members': [{**_author_brief(m.user), 'role': m.role} for m in doc.members.select_related('user')],
    }


def _comment_data(c):
    return {
        'id': str(c.id), 'anchor': c.anchor, 'text': c.text, 'resolved': c.resolved,
        'author': _author_brief(c.author), 'created_at': c.created_at.isoformat(),
    }


def commit_ops(doc_id, user, ops, client_id=''):
    """Apply ops under a row lock; returns (version, error code)."""
    from sfera_modules.workspace_access import require
    from sfera_modules.commercial import CommercialError
    try: require('office', 'commit_ops', user=user)
    except CommercialError: return None, 'subscription_required'
    snapshot = None
    with transaction.atomic():
        doc = Doc.objects.select_for_update().filter(id=doc_id).first()
        if not doc:
            return None, 'not_found'
        try:
            doc.data = apply_ops(doc.kind, doc.data, ops)
        except OpError as e:
            metrics_inc('office_op_errors')
            return None, str(e)
        doc.version += 1
        doc.save(update_fields=['data', 'version', 'updated_at'])
        version = doc.version
        if version % REVISION_EVERY == 0:
            snapshot = (doc.data, version)
    if snapshot:
        _keep_revision(doc_id, user, *snapshot)
    metrics_inc('office_ops', len(ops) if isinstance(ops, list) else 1)
    return version, None


def _keep_revision(doc_id, user, data, version):
    """History without storing every keystroke: a snapshot every REVISION_EVERY versions."""
    try:
        DocRevision.objects.create(doc_id=doc_id, version=version, data=data,
                                   author=user if getattr(user, 'is_authenticated', False) else None)
        extra = list(DocRevision.objects.filter(doc_id=doc_id).order_by('-version')
                     .values_list('id', flat=True)[REVISIONS_KEPT:])
        if extra:
            DocRevision.objects.filter(id__in=extra).delete()
        metrics_inc('office_revisions')
    except Exception:
        pass


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def doc_list_create(request):
    if request.method == 'GET':
        members = (DocMember.objects.filter(user=request.user).select_related('doc', 'doc__owner')
                   .order_by('-doc__updated_at'))
        kind = request.query_params.get('kind')
        if kind in KINDS:
            members = members.filter(doc__kind=kind)
        offset = max(0, int(request.query_params.get('offset') or 0))
        return Response([_brief(m.doc, m.role) for m in members[offset:offset + PAGE]])

    kind = request.data.get('kind', KIND_DOC)
    if kind not in KINDS:
        return _err('bad_kind')
    title = str(request.data.get('title', '')).strip()[:160]
    if not title:
        return _err('title_required')
    if DocMember.objects.filter(user=request.user, role=ROLE_OWNER).count() >= MAX_DOCS_PER_USER:
        return _err('limit', 409)
    data = request.data.get('data')
    with transaction.atomic():
        doc = Doc.objects.create(kind=kind, title=title, owner=request.user, data=empty_doc(kind))
        DocMember.objects.create(doc=doc, user=request.user, role=ROLE_OWNER)
        if isinstance(data, dict):
            # Duplicate or import: validate by replaying the content as ops.
            try:
                doc.data = _replay(kind, data)
            except OpError:
                transaction.set_rollback(True)
                return _err('bad_data')
            doc.save(update_fields=['data'])
    metrics_inc('office_docs_created')
    return Response(_full(doc, ROLE_OWNER), status=201)


def _replay(kind, data):
    """Rebuild a document from untrusted content by pushing it through the validator."""
    if kind == KIND_DOC:
        blocks = data.get('blocks') or {}
        order = [b for b in (data.get('order') or list(blocks)) if b in blocks]
        ops = [{'op': 'block.put', 'block': blocks[b]} for b in order]
    elif kind == KIND_SHEET:
        cells = data.get('cells') or {}
        ops = [{'op': 'cell.set', 'ref': ref, 'cell': cell} for ref, cell in list(cells.items())[:5000]]
        ops.append({'op': 'size', 'rows': int(data.get('rows') or 50), 'cols': int(data.get('cols') or 12)})
    else:
        slides = data.get('slides') or {}
        order = [s for s in (data.get('order') or list(slides)) if s in slides]
        ops = [{'op': 'slide.put', 'slide': slides[s]} for s in order]
        if data.get('theme'):
            ops.append({'op': 'theme', 'theme': data['theme']})
    return apply_ops(kind, empty_doc(kind), ops) if ops else empty_doc(kind)


@api_view(['GET', 'PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def doc_detail(request, doc_id):
    role = role_of(request.user, doc_id)
    if not role:
        return _err('not_found', 404)
    doc = Doc.objects.select_related('owner').get(id=doc_id)
    if request.method == 'GET':
        DocMember.objects.filter(doc_id=doc_id, user=request.user).update(opened_at=timezone.now())
        return Response(_full(doc, role))
    if request.method == 'DELETE':
        if role != ROLE_OWNER:
            return _err('forbidden', 403)
        broadcast(doc_id, {'type': 'removed'})
        doc.delete()
        return Response(status=204)
    if role == ROLE_VIEWER:
        return _err('forbidden', 403)
    title = str(request.data.get('title', '')).strip()[:160]
    if title:
        doc.title = title
        doc.save(update_fields=['title', 'updated_at'])
        broadcast(doc_id, {'type': 'renamed', 'title': title})
    return Response(_brief(doc, role))


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def doc_ops(request, doc_id):
    """HTTP path for edits, used when the socket is down; the socket does the same."""
    role = role_of(request.user, doc_id)
    if not role:
        return _err('not_found', 404)
    if role == ROLE_VIEWER:
        return _err('forbidden', 403)
    ops = request.data.get('ops')
    client_id = str(request.data.get('client_id', ''))[:40]
    version, error = commit_ops(doc_id, request.user, ops, client_id)
    if error:
        return _err(error, 404 if error == 'not_found' else 400)
    broadcast(doc_id, {'type': 'ops', 'ops': ops, 'version': version, 'client_id': client_id,
                       'user_id': str(request.user.id)})
    return Response({'version': version})


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def doc_download(request, doc_id, fmt):
    role = role_of(request.user, doc_id)
    if not role:
        return _err('not_found', 404)
    doc = Doc.objects.select_related('owner').get(id=doc_id)
    author = doc.owner.nickname or doc.owner.username if doc.owner_id else ''
    name = ''.join(ch for ch in doc.title if ch.isalnum() or ch in ' -_').strip()[:60] or 'document'
    if fmt == 'html':
        return HttpResponse(exporters.to_html(doc, author), content_type='text/html; charset=utf-8')
    if fmt == 'md' and doc.kind == KIND_DOC:
        body, mime = exporters.to_markdown(doc), 'text/markdown; charset=utf-8'
    elif fmt == 'csv' and doc.kind == KIND_SHEET:
        body, mime = exporters.to_csv(doc), 'text/csv; charset=utf-8'
    else:
        return _err('bad_format')
    response = HttpResponse(body.encode('utf-8-sig' if fmt == 'csv' else 'utf-8'), content_type=mime)
    response['Content-Disposition'] = f'attachment; filename="{name}.{fmt}"'
    return response


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def doc_history(request, doc_id):
    if not role_of(request.user, doc_id):
        return _err('not_found', 404)
    rows = (DocRevision.objects.filter(doc_id=doc_id).select_related('author')
            .only('id', 'version', 'created_at', 'author')[:REVISIONS_KEPT])
    return Response([{
        'id': str(r.id), 'version': r.version, 'created_at': r.created_at.isoformat(),
        'author': _author_brief(r.author) if r.author_id else None,
    } for r in rows])


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def doc_restore(request, doc_id, revision_id):
    """Put a stored snapshot back as the current content."""
    if role_of(request.user, doc_id) != ROLE_OWNER:
        return _err('forbidden', 403)
    revision = DocRevision.objects.filter(id=revision_id, doc_id=doc_id).first()
    if not revision:
        return _err('not_found', 404)
    with transaction.atomic():
        doc = Doc.objects.select_for_update().get(id=doc_id)
        try:
            doc.data = _replay(doc.kind, revision.data)
        except OpError:
            return _err('bad_data')
        doc.version += 1
        doc.save(update_fields=['data', 'version', 'updated_at'])
    broadcast(doc_id, {'type': 'replaced', 'version': doc.version, 'data': doc.data})
    return Response(_full(doc, ROLE_OWNER))


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def comments(request, doc_id):
    role = role_of(request.user, doc_id)
    if not role:
        return _err('not_found', 404)
    if request.method == 'GET':
        rows = DocComment.objects.filter(doc_id=doc_id).select_related('author')
        if request.query_params.get('open') == '1':
            rows = rows.filter(resolved=False)
        return Response([_comment_data(c) for c in rows[:MAX_COMMENTS]])
    text = str(request.data.get('text', '')).strip()[:4000]
    anchor = str(request.data.get('anchor', ''))[:48]
    if not text:
        return _err('text_required')
    if DocComment.objects.filter(doc_id=doc_id).count() >= MAX_COMMENTS:
        return _err('limit', 409)
    c = DocComment.objects.create(doc_id=doc_id, anchor=anchor, author=request.user, text=text)
    metrics_inc('office_comments')
    broadcast(doc_id, {'type': 'comment', 'comment': _comment_data(c)})
    return Response(_comment_data(c), status=201)


@api_view(['PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def comment_detail(request, doc_id, comment_id):
    role = role_of(request.user, doc_id)
    if not role:
        return _err('not_found', 404)
    c = DocComment.objects.filter(id=comment_id, doc_id=doc_id).select_related('author').first()
    if not c:
        return _err('not_found', 404)
    mine = c.author_id == request.user.id
    if request.method == 'DELETE':
        if not mine and role != ROLE_OWNER:
            return _err('forbidden', 403)
        c.delete()
        broadcast(doc_id, {'type': 'comment_removed', 'id': str(comment_id)})
        return Response(status=204)
    if role == ROLE_VIEWER and not mine:
        return _err('forbidden', 403)
    c.resolved = bool(request.data.get('resolved'))
    c.save(update_fields=['resolved'])
    broadcast(doc_id, {'type': 'comment', 'comment': _comment_data(c)})
    return Response(_comment_data(c))


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def member_add(request, doc_id):
    if role_of(request.user, doc_id) != ROLE_OWNER:
        return _err('forbidden', 403)
    new_role = request.data.get('role', ROLE_EDITOR)
    if new_role not in (ROLE_EDITOR, ROLE_VIEWER):
        return _err('bad_role')
    user = get_user_model().objects.filter(id=request.data.get('user_id'), is_active=True).first()
    if not user:
        return _err('user_not_found', 404)
    DocMember.objects.update_or_create(doc_id=doc_id, user=user, defaults={'role': new_role})
    doc = Doc.objects.select_related('owner').get(id=doc_id)
    try:
        from sfera_modules.hooks import push_to_user

        push_to_user(user.id, 'office.shared', {'doc_id': str(doc.id), 'title': doc.title, 'kind': doc.kind,
                                                'from': request.user.nickname or request.user.username})
    except Exception:
        pass
    return Response(_full(doc, ROLE_OWNER), status=201)


@api_view(['PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def member_detail(request, doc_id, user_id):
    role = role_of(request.user, doc_id)
    leaving = str(user_id) == str(request.user.id) and request.method == 'DELETE'
    if role != ROLE_OWNER and not (role and leaving):
        return _err('forbidden', 403)
    m = DocMember.objects.filter(doc_id=doc_id, user_id=user_id).first()
    if not m:
        return _err('not_found', 404)
    if m.role == ROLE_OWNER:
        return _err('owner_stays', 409)
    if request.method == 'DELETE':
        m.delete()
        broadcast(doc_id, {'type': 'access_changed', 'user_id': str(user_id)})
        return Response(status=204)
    if request.data.get('role') not in (ROLE_EDITOR, ROLE_VIEWER):
        return _err('bad_role')
    m.role = request.data['role']
    m.save(update_fields=['role'])
    broadcast(doc_id, {'type': 'access_changed', 'user_id': str(user_id)})
    return Response(_full(Doc.objects.select_related('owner').get(id=doc_id), role))


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def user_search(request):
    q = str(request.query_params.get('q', '')).strip()[:64]
    if not q:
        return Response([])
    users = (get_user_model().objects.filter(is_active=True)
             .filter(Q(username__icontains=q) | Q(nickname__icontains=q))
             .exclude(account_type='bot').exclude(id=request.user.id).order_by('username')[:20])
    return Response([_author_brief(u) for u in users])
