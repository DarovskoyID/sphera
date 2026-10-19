"""Whiteboards API (mounted at /api/whiteboard/)."""
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Q
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from sfera_messages.services import _author_brief
from sfera_modules.permissions import requires_module
from sfera_server.metrics import inc as metrics_inc

from .models import MAX_BOARDS_PER_USER, ROLE_EDITOR, ROLE_OWNER, ROLE_VIEWER, Board, BoardMember
from .ops import OpError, apply_ops

MODULE = 'whiteboard'


def _err(code, status=400):
    return Response({'error': code}, status=status)


def group_name(board_id):
    return f'whiteboard_{board_id}'


def broadcast(board_id, message: dict):
    layer = get_channel_layer()
    if layer is None:
        return
    try:
        async_to_sync(layer.group_send)(group_name(board_id), {'type': 'board.event', 'message': message})
    except Exception:
        pass


def role_of(user, board_id):
    m = BoardMember.objects.filter(board_id=board_id, user=user).only('role').first()
    return m.role if m else None


def _brief(board, role):
    return {
        'id': str(board.id), 'name': board.name, 'role': role, 'version': board.version,
        'shapes': len((board.doc or {}).get('shapes') or {}),
        'created_at': board.created_at.isoformat(), 'updated_at': board.updated_at.isoformat(),
    }


def _full(board, role):
    return {
        **_brief(board, role),
        'doc': board.doc,
        'members': [{**_author_brief(m.user), 'role': m.role} for m in board.members.select_related('user')],
    }


def commit_ops(board_id, user, ops, client_id=''):
    """Apply ops under a row lock; returns (version, error code)."""
    from sfera_modules.workspace_access import require
    from sfera_modules.commercial import CommercialError
    try: require('whiteboard', 'commit_ops', user=user)
    except CommercialError: return None, 'subscription_required'
    with transaction.atomic():
        board = Board.objects.select_for_update().filter(id=board_id).first()
        if not board:
            return None, 'not_found'
        try:
            board.doc = apply_ops(board.doc, ops)
        except OpError as e:
            metrics_inc('whiteboard_op_errors')
            return None, str(e)
        board.version += 1
        board.save(update_fields=['doc', 'version', 'updated_at'])
        version = board.version
    metrics_inc('whiteboard_ops', len(ops) if isinstance(ops, list) else 1)
    return version, None


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def board_list_create(request):
    if request.method == 'GET':
        members = BoardMember.objects.filter(user=request.user).select_related('board').order_by('-board__updated_at')
        return Response([_brief(m.board, m.role) for m in members])
    name = str(request.data.get('name', '')).strip()[:120]
    if not name:
        return _err('name_required')
    if BoardMember.objects.filter(user=request.user, role=ROLE_OWNER).count() >= MAX_BOARDS_PER_USER:
        return _err('limit', 409)
    doc = request.data.get('doc')
    with transaction.atomic():
        board = Board.objects.create(name=name, owner=request.user)
        BoardMember.objects.create(board=board, user=request.user, role=ROLE_OWNER)
        if isinstance(doc, dict) and doc.get('shapes'):
            # Import / duplicate: validate by replaying the shapes as ops.
            try:
                shapes = doc['shapes']
                ops = [{'op': 'put', 'shape': shapes[i]} for i in doc.get('order') or shapes.keys() if i in shapes]
                board.doc = apply_ops(board.doc, ops) if ops else board.doc
            except (OpError, TypeError, AttributeError):
                transaction.set_rollback(True)
                return _err('bad_doc')
            board.save(update_fields=['doc'])
    return Response(_full(board, ROLE_OWNER), status=201)


@api_view(['GET', 'PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def board_detail(request, board_id):
    role = role_of(request.user, board_id)
    if not role:
        return _err('not_found', 404)
    board = Board.objects.get(id=board_id)
    if request.method == 'GET':
        return Response(_full(board, role))
    if request.method == 'DELETE':
        if role != ROLE_OWNER:
            return _err('forbidden', 403)
        broadcast(board_id, {'type': 'removed'})
        board.delete()
        return Response(status=204)
    if role == ROLE_VIEWER:
        return _err('forbidden', 403)
    name = str(request.data.get('name', '')).strip()[:120]
    if name:
        board.name = name
        board.save(update_fields=['name', 'updated_at'])
        broadcast(board_id, {'type': 'renamed', 'name': name})
    return Response(_brief(board, role))


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def board_ops(request, board_id):
    """HTTP path for edits (used when the socket is down); the socket does the same."""
    role = role_of(request.user, board_id)
    if not role:
        return _err('not_found', 404)
    if role == ROLE_VIEWER:
        return _err('forbidden', 403)
    ops = request.data.get('ops')
    client_id = str(request.data.get('client_id', ''))[:40]
    version, error = commit_ops(board_id, request.user, ops, client_id)
    if error:
        return _err(error, 404 if error == 'not_found' else 400)
    broadcast(board_id, {'type': 'ops', 'ops': ops, 'version': version, 'client_id': client_id, 'user_id': str(request.user.id)})
    return Response({'version': version})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def member_add(request, board_id):
    if role_of(request.user, board_id) != ROLE_OWNER:
        return _err('forbidden', 403)
    new_role = request.data.get('role', ROLE_EDITOR)
    if new_role not in (ROLE_EDITOR, ROLE_VIEWER):
        return _err('bad_role')
    user = get_user_model().objects.filter(id=request.data.get('user_id'), is_active=True).first()
    if not user:
        return _err('user_not_found', 404)
    BoardMember.objects.update_or_create(board_id=board_id, user=user, defaults={'role': new_role})
    return Response(_full(Board.objects.get(id=board_id), ROLE_OWNER), status=201)


@api_view(['PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def member_detail(request, board_id, user_id):
    role = role_of(request.user, board_id)
    leaving = str(user_id) == str(request.user.id) and request.method == 'DELETE'
    if role != ROLE_OWNER and not (role and leaving):
        return _err('forbidden', 403)
    m = BoardMember.objects.filter(board_id=board_id, user_id=user_id).first()
    if not m:
        return _err('not_found', 404)
    if m.role == ROLE_OWNER:
        return _err('owner_stays', 409)
    if request.method == 'DELETE':
        m.delete()
        broadcast(board_id, {'type': 'access_changed', 'user_id': str(user_id)})
        return Response(status=204)
    if request.data.get('role') not in (ROLE_EDITOR, ROLE_VIEWER):
        return _err('bad_role')
    m.role = request.data['role']
    m.save(update_fields=['role'])
    broadcast(board_id, {'type': 'access_changed', 'user_id': str(user_id)})
    return Response(_full(Board.objects.get(id=board_id), role))


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def user_search(request):
    q = str(request.query_params.get('q', '')).strip()[:64]
    if not q:
        return Response([])
    users = (get_user_model().objects.filter(is_active=True)
             .filter(Q(username__icontains=q) | Q(nickname__icontains=q))
             .exclude(account_type='bot').order_by('username')[:20])
    return Response([_author_brief(u) for u in users])
