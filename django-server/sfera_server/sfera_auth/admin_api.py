"""Superuser admin panel: reports on messages and system-wide bans.

Unlike BlockedUser (one person hiding another), a ban here applies to the whole
instance: the account is deactivated, its sessions are revoked, and it cannot
sign in until the superuser lifts the ban.
"""
from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.response import Response

from .models import User, UserBan


class IsSuperuser(BasePermission):
    message = {'error': 'superuser_only'}

    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and request.user.is_superuser)


def _brief(user):
    if user is None:
        return None
    return {
        'id': str(user.id),
        'username': user.username,
        'nickname': user.nickname,
        'avatar': user.avatar.url if user.avatar else '',
        'is_active': user.is_active,
    }


def _revoke_sessions(user):
    try:
        from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
    except ImportError:  # blacklist app not installed
        return
    for token in OutstandingToken.objects.filter(user=user):
        BlacklistedToken.objects.get_or_create(token=token)


# ── Reports ─────────────────────────────────────────────────────────────────

@api_view(['GET'])
@permission_classes([IsAuthenticated, IsSuperuser])
def reports(request):
    """Reported messages, newest first. ?status=open|resolved|all (default open)."""
    from sfera_messages.models import MessageReport

    qs = MessageReport.objects.select_related('reporter', 'message', 'message__author', 'resolved_by')
    state = request.GET.get('status', 'open')
    if state == 'open':
        qs = qs.filter(resolved_at__isnull=True)
    elif state == 'resolved':
        qs = qs.filter(resolved_at__isnull=False)
    qs = qs.order_by('-created_at')[:200]

    banned = set(UserBan.objects.values_list('user_id', flat=True))
    out = []
    for r in qs:
        msg = r.message
        try:
            content = msg.content
        except Exception:  # noqa: BLE001 — undecryptable
            content = ''
        out.append({
            'id': str(r.id),
            'created_at': r.created_at,
            'reporter': _brief(r.reporter),
            'message': {
                'id': str(msg.id),
                'content': content,
                'created_at': msg.created_at,
                'conversation_id': str(msg.conversation_id),
                'attachments': msg.attachments.count(),
            },
            'author': {**_brief(msg.author), 'banned': msg.author_id in banned},
            'resolved_at': r.resolved_at,
            'resolved_by': _brief(r.resolved_by),
            'resolution': r.resolution,
            'reports_on_author': MessageReport.objects.filter(message__author=msg.author).count(),
        })
    open_count = MessageReport.objects.filter(resolved_at__isnull=True).count()
    return Response({'reports': out, 'open_count': open_count})


@api_view(['POST'])
@permission_classes([IsAuthenticated, IsSuperuser])
def resolve_report(request, report_id):
    """Close a report. resolution: 'dismissed' | 'deleted' (also deletes the message)."""
    from sfera_messages.models import MessageReport

    try:
        report = MessageReport.objects.select_related('message').get(id=report_id)
    except (MessageReport.DoesNotExist, ValueError):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    resolution = request.data.get('resolution', 'dismissed')
    if resolution not in ('dismissed', 'deleted'):
        return Response({'error': 'bad resolution'}, status=status.HTTP_400_BAD_REQUEST)

    now = timezone.now()
    if resolution == 'deleted':
        msg = report.message
        # Every report on that message goes with it (cascade), so answer first.
        msg.delete()
        return Response({'id': str(report_id), 'resolution': 'deleted', 'resolved_at': now})
    MessageReport.objects.filter(message_id=report.message_id, resolved_at__isnull=True).update(
        resolved_at=now, resolved_by=request.user, resolution=resolution,
    )
    return Response({'id': str(report.id), 'resolution': resolution, 'resolved_at': now})


# ── Bans ────────────────────────────────────────────────────────────────────

@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated, IsSuperuser])
def bans(request):
    if request.method == 'GET':
        rows = UserBan.objects.select_related('user', 'banned_by').order_by('-created_at')
        return Response({'bans': [
            {'user': _brief(b.user), 'reason': b.reason, 'created_at': b.created_at, 'banned_by': _brief(b.banned_by)}
            for b in rows
        ]})

    try:
        target = User.objects.get(id=request.data.get('user_id'))
    except (User.DoesNotExist, ValueError, TypeError):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    if target.is_superuser or target.id == request.user.id:
        return Response({'error': 'cannot_ban_superuser'}, status=status.HTTP_400_BAD_REQUEST)
    reason = str(request.data.get('reason') or '')[:500]
    with transaction.atomic():
        ban, _ = UserBan.objects.update_or_create(user=target, defaults={'reason': reason, 'banned_by': request.user})
        target.is_active = False
        target.save(update_fields=['is_active'])
        _revoke_sessions(target)
    return Response({'user': _brief(target), 'reason': ban.reason, 'created_at': ban.created_at}, status=201)


@api_view(['DELETE'])
@permission_classes([IsAuthenticated, IsSuperuser])
def unban(request, user_id):
    try:
        target = User.objects.get(id=user_id)
    except (User.DoesNotExist, ValueError):
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    with transaction.atomic():
        UserBan.objects.filter(user=target).delete()
        target.is_active = True
        target.save(update_fields=['is_active'])
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['GET'])
@permission_classes([IsAuthenticated, IsSuperuser])
def users(request):
    """Find any account (including banned ones, which normal search hides)."""
    q = (request.GET.get('q') or '').strip()
    if len(q) < 2:
        return Response({'users': []})
    banned = set(UserBan.objects.values_list('user_id', flat=True))
    rows = (
        User.objects.filter(Q(username__icontains=q) | Q(nickname__icontains=q) | Q(email__iexact=q))
        .annotate(report_count=Count('sent_messages__reports', distinct=True))
        .order_by('username')[:20]
    )
    return Response({'users': [
        {**_brief(u), 'is_superuser': u.is_superuser, 'banned': u.id in banned, 'reports': u.report_count}
        for u in rows
    ]})
