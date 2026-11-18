"""Channels API (mounted at /api/channels/)."""
import json
import uuid
from datetime import timedelta

from django.core.cache import cache
from django.core.files.base import ContentFile
from django.db import transaction
from django.db.models import Count, Q
from django.http import HttpResponse
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from sfera_auth.models import BlockedUser
from sfera_messages.encryption import decrypt_bytes, encrypt_bytes, encrypt_text
from sfera_messages.models import MESSAGE_TYPE_LOCATION, MESSAGE_TYPE_POLL, MESSAGE_TYPE_TODO
from sfera_messages.rich import RichError, _poll_expired, location_view, poll_view, todo_view
from sfera_messages.services import (
    GUILD_RICH_TYPES, MAX_UPLOAD_SIZE, _apply_location_update, _apply_message_edit, _author_brief,
    _build_rich, _clean_tags, _id_list, _safe_upload, _scan_upload, _toggle_todo_item,
)
from sfera_modules.permissions import requires_module

from . import search
from .models import (
    MAX_OWNED_CHANNELS, MAX_SUBSCRIPTIONS, Channel, Post, PostAttachment, PostComment, PostPollVote,
    PostReaction, PostTodoCheck, PostView, ScheduledPost, Subscription,
)
from .services import (
    aggregate_reactions, attachment_data, broadcast, channel_data, deliver_due, post_data, posts_qs, publish,
)

MODULE = 'channels'
MAX_REACTIONS_PER_USER = 3


def _nf():
    return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)


def _forbidden(msg='forbidden'):
    return Response({'error': msg}, status=status.HTTP_403_FORBIDDEN)


def _bool(v):
    return v in (True, 'true', '1', 1)


def _sub(ch, user):
    return Subscription.objects.filter(channel=ch, user=user).first()


def _readable(ch, user):
    return _sub(ch, user) is not None or ch.is_discoverable


def _post_for_member(request, post_id, **filters):
    """A post in a channel the user is subscribed to (or owns)."""
    post = posts_qs().select_related('channel').filter(id=post_id, **filters).first()
    if post is None:
        return None, None
    sub = _sub(post.channel, request.user)
    return post, sub


# ── Channels ────────────────────────────────────────────────────────────────

@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def channel_list_create(request):
    if request.method == 'GET':
        subs = (Subscription.objects.filter(user=request.user).select_related('channel')
                .annotate(n=Count('channel__subscriptions')))
        return Response([channel_data(s.channel, request.user, s, s.n) for s in subs])

    name = (request.data.get('name') or '').strip()[:100]
    if not name:
        return Response({'error': 'name required'}, status=status.HTTP_400_BAD_REQUEST)
    if Channel.objects.filter(owner=request.user).count() >= MAX_OWNED_CHANNELS:
        return Response({'error': 'limit reached', 'limit': MAX_OWNED_CHANNELS}, status=status.HTTP_409_CONFLICT)
    with transaction.atomic():
        ch = Channel.objects.create(owner=request.user, name=name, description=request.data.get('description', ''))
        sub = Subscription.objects.create(channel=ch, user=request.user, role='owner')
    return Response(channel_data(ch, request.user, sub, 1), status=status.HTTP_201_CREATED)


@api_view(['GET', 'PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def channel_detail(request, channel_id):
    ch = Channel.objects.filter(id=channel_id).first()
    if ch is None or not _readable(ch, request.user):
        return _nf()
    if request.method == 'GET':
        return Response(channel_data(ch, request.user))
    if ch.owner_id != request.user.id:
        return _forbidden()

    if request.method == 'PATCH':
        for field in ('name', 'description'):
            if field in request.data:
                setattr(ch, field, str(request.data[field])[:100 if field == 'name' else 5000])
        for field in ('is_discoverable', 'comments_enabled'):
            if field in request.data:
                setattr(ch, field, _bool(request.data[field]))
        if 'tags' in request.data:
            raw = request.data['tags']
            if isinstance(raw, str):
                try:
                    raw = json.loads(raw)
                except ValueError:
                    raw = [t.strip() for t in raw.split(',') if t.strip()]
            ch.tags = [str(t)[:24] for t in raw[:10]] if isinstance(raw, list) else []
        for field in ('icon', 'banner'):
            if field in request.FILES:
                getattr(ch, field).delete(save=False) if getattr(ch, field) else None
                setattr(ch, field, request.FILES[field])
            if _bool(request.data.get(f'remove_{field}')) and getattr(ch, field):
                getattr(ch, field).delete(save=False)
                setattr(ch, field, None)
        if not ch.name.strip():
            return Response({'error': 'name required'}, status=status.HTTP_400_BAD_REQUEST)
        ch.save()
        data = channel_data(ch, request.user)
        broadcast(ch.id, {'type': 'channel_updated', 'channel': {**data, 'my_role': '', 'my_notifications_muted': False}})
        return Response(data)

    password = request.data.get('password', '')
    if not password or not request.user.check_password(password):
        return Response({'error': 'invalid password'}, status=status.HTTP_403_FORBIDDEN)
    files = [a.file for a in ch.attachments.all()]
    post_ids = list(ch.posts.values_list('id', flat=True))
    ch_id = str(ch.id)
    ch.delete()
    for pid in post_ids:
        search.unindex_post(pid)
    for f in files:
        try:
            f.delete(save=False)
        except Exception:
            pass
    broadcast(ch_id, {'type': 'channel_deleted', 'channel_id': ch_id})
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def channel_join(request):
    code = (request.data.get('invite_code') or '').strip()
    channel_id = request.data.get('channel_id')
    ch = None
    if code:
        ch = Channel.objects.filter(invite_code=code).first()
    elif channel_id:
        ch = Channel.objects.filter(id=channel_id, is_discoverable=True).first()
    if ch is None:
        return Response({'error': 'invalid invite code'}, status=status.HTTP_404_NOT_FOUND)
    if BlockedUser.objects.filter(
        Q(blocker=request.user, blocked_id=ch.owner_id) | Q(blocker_id=ch.owner_id, blocked=request.user)
    ).exists():
        return _forbidden('You cannot join this channel')
    sub = _sub(ch, request.user)
    created = sub is None
    if created:
        if Subscription.objects.filter(user=request.user).exclude(role='owner').count() >= MAX_SUBSCRIPTIONS:
            return Response({'error': 'limit reached', 'limit': MAX_SUBSCRIPTIONS}, status=status.HTTP_409_CONFLICT)
        sub = Subscription.objects.create(channel=ch, user=request.user)
    return Response(channel_data(ch, request.user, sub), status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def channel_leave(request, channel_id):
    sub = Subscription.objects.filter(channel_id=channel_id, user=request.user).first()
    if sub is None:
        return _nf()
    if sub.role == 'owner':
        return Response({'error': 'owner cannot leave — delete the channel'}, status=status.HTTP_400_BAD_REQUEST)
    sub.delete()
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def channel_notifications(request, channel_id):
    sub = Subscription.objects.filter(channel_id=channel_id, user=request.user).first()
    if sub is None:
        return _nf()
    sub.notifications_muted = not sub.notifications_muted
    sub.save(update_fields=['notifications_muted'])
    return Response({'notifications_muted': sub.notifications_muted})


# ── Discovery ───────────────────────────────────────────────────────────────

def _explore_row(ch):
    return {
        'id': str(ch.id), 'name': ch.name, 'description': ch.description,
        'icon': ch.icon.url if ch.icon else '', 'banner': ch.banner.url if ch.banner else '',
        'subscriber_count': ch.n, 'invite_code': ch.invite_code, 'tags': ch.tags or [],
        'is_official': ch.is_official,
    }


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def channel_explore(request):
    q = request.query_params.get('q', '').strip()[:80]
    mine = {str(i) for i in Subscription.objects.filter(user=request.user).values_list('channel_id', flat=True)}
    base = (Channel.objects.filter(is_discoverable=True).annotate(n=Count('subscriptions')).order_by('-is_official', '-n'))
    norm = ' '.join(q.lower().split())
    key = f'channels_explore_v1:{norm}'
    rows = cache.get(key)
    if rows is None:
        if not q:
            qs = base
        elif q.startswith('#'):
            qs = base.filter(tags__icontains=q[1:].strip())
        else:
            cond = Q()
            for term in q.split()[:5]:
                cond &= Q(name__icontains=term) | Q(description__icontains=term) | Q(tags__icontains=term)
            qs = base.filter(cond)
        rows = [_explore_row(ch) for ch in qs[:100 if not q else 50]]
        cache.set(key, rows, 30 if not q else 15)
    return Response([{**r, 'is_member': r['id'] in mine} for r in rows])


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def post_search(request):
    q = request.query_params.get('q', '').strip()[:80]
    hits = search.search(q) if q else None
    if not hits:
        return Response([])
    visible = {str(i) for i in Channel.objects.filter(
        id__in={h[1] for h in hits}, is_discoverable=True).values_list('id', flat=True)}
    ordered = [h[0] for h in hits if h[1] in visible][:30]
    mine = {str(i) for i in Subscription.objects.filter(user=request.user, channel_id__in=visible)
            .values_list('channel_id', flat=True)}
    posts = {str(p.id): p for p in Post.objects.filter(id__in=ordered).select_related('author', 'channel')}
    out = []
    for pid in ordered:
        p = posts.get(pid)
        if not p:
            continue
        ch = p.channel
        out.append({
            'id': pid, 'content': (p.content or '')[:200], 'created_at': p.created_at.isoformat(),
            'channel': {'id': str(ch.id), 'name': ch.name, 'icon': ch.icon.url if ch.icon else '',
                        'invite_code': ch.invite_code, 'is_member': str(ch.id) in mine},
            'author': {'username': p.author.username, 'nickname': p.author.nickname or ''},
        })
    return Response(out)


# ── Posts ───────────────────────────────────────────────────────────────────

def _owned_channel(request, channel_id):
    ch = Channel.objects.filter(id=channel_id).first()
    if ch is None or not _readable(ch, request.user):
        return None, _nf()
    if ch.owner_id != request.user.id:
        return None, _forbidden('only the channel owner can post')
    return ch, None


def _claim(ch, user, raw_ids):
    ids = _id_list(raw_ids)
    qs = PostAttachment.objects.filter(id__in=ids, channel=ch, uploader=user, post__isnull=True)
    if qs.count() != len(set(ids)):
        raise ValueError('invalid attachment')
    return ids, qs


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def post_list_create(request, channel_id):
    if request.method == 'GET':
        ch = Channel.objects.filter(id=channel_id).first()
        if ch is None or not _readable(ch, request.user):
            return _nf()
        deliver_due(ch.id)
        try:
            limit = min(max(int(request.GET.get('limit', 50)), 1), 200)
        except ValueError:
            limit = 50
        qs = posts_qs().filter(channel=ch).order_by('-created_at')
        before = parse_datetime(request.GET.get('before_ts') or '')
        if before:
            qs = qs.filter(created_at__lt=before)
        rows = list(qs[:limit])
        rows.reverse()
        return Response([post_data(p, request.user) for p in rows])

    ch, err = _owned_channel(request, channel_id)
    if err:
        return err
    content = (request.data.get('content') or '').strip()
    try:
        ids, atts = _claim(ch, request.user, request.data.get('attachment_ids'))
    except ValueError:
        return Response({'error': 'invalid attachment'}, status=status.HTTP_400_BAD_REQUEST)
    if not content and not ids:
        return Response({'error': 'empty message'}, status=status.HTTP_400_BAD_REQUEST)
    with transaction.atomic():
        post = Post(channel=ch, author=request.user, tags=_clean_tags(request.data.get('tags')))
        post.content = content
        post.save()
        atts.update(post=post)
    post = publish(post)
    return Response(post_data(post, request.user), status=status.HTTP_201_CREATED)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def post_rich_create(request, channel_id):
    ch, err = _owned_channel(request, channel_id)
    if err:
        return err
    kind = (request.data.get('type') or '').strip()
    if kind not in GUILD_RICH_TYPES:
        return Response({'error': 'unsupported message type'}, status=status.HTTP_400_BAD_REQUEST)
    try:
        payload, live_until = _build_rich(kind, request.data.get('payload') or {})
    except RichError as exc:
        return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    post = Post(channel=ch, author=request.user, message_type=kind, live_until=live_until,
                tags=_clean_tags(request.data.get('tags')))
    post.content = (request.data.get('content') or '').strip()[:2000]
    post.payload = payload
    post.save()
    post = publish(post)
    return Response(post_data(post, request.user), status=status.HTTP_201_CREATED)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def post_schedule(request, channel_id):
    ch, err = _owned_channel(request, channel_id)
    if err:
        return err
    content = (request.data.get('content') or '').strip()
    try:
        ids, _ = _claim(ch, request.user, request.data.get('attachment_ids'))
        delay = int(request.data.get('delay_seconds', 60))
    except ValueError:
        return Response({'error': 'invalid request'}, status=status.HTTP_400_BAD_REQUEST)
    if not content and not ids:
        return Response({'error': 'content or attachments required'}, status=status.HTTP_400_BAD_REQUEST)
    send_at = timezone.now() + timedelta(seconds=max(5, min(delay, 86400)))
    sched = ScheduledPost.objects.create(channel=ch, author=request.user, encrypted_content=encrypt_text(content),
                                         attachment_ids=[str(i) for i in ids], send_at=send_at)
    broadcast(ch.id, {'type': 'post_scheduled', 'scheduled_id': str(sched.id), 'send_at': send_at.isoformat()})
    return Response({'id': str(sched.id), 'send_at': send_at.isoformat()}, status=status.HTTP_201_CREATED)


@api_view(['PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def post_detail(request, post_id):
    post, sub = _post_for_member(request, post_id)
    if post is None or sub is None:
        return _nf()
    if request.method == 'PATCH':
        if post.author_id != request.user.id:
            return _forbidden()
        try:
            _apply_message_edit(post, request.data)
        except RichError as exc:
            return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        post = posts_qs().get(id=post.id)
        search.index_post(post)
        data = post_data(post, None)
        broadcast(post.channel_id, {'type': 'post_updated', 'post': data})
        return Response(post_data(post, request.user))
    if post.author_id != request.user.id and sub.role != 'owner':
        return _forbidden()
    files = [a.file for a in post.attachments.all()]
    channel_id = post.channel_id
    post.attachments.all().delete()
    post.delete()
    search.unindex_post(post_id)
    for f in files:
        try:
            f.delete(save=False)
        except Exception:
            pass
    broadcast(channel_id, {'type': 'post_deleted', 'post_id': str(post_id)})
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def post_reaction(request, post_id):
    emoji = (request.data.get('emoji') or '').strip()[:50]
    if not emoji:
        return Response({'error': 'emoji required'}, status=status.HTTP_400_BAD_REQUEST)
    post, sub = _post_for_member(request, post_id)
    if post is None or sub is None:
        return _nf()
    mine = PostReaction.objects.filter(post=post, user=request.user)
    same = mine.filter(emoji=emoji).first()
    if same:
        same.delete()
        added = False
    else:
        if mine.count() >= MAX_REACTIONS_PER_USER:
            return Response({'error': 'reaction limit reached'}, status=status.HTTP_409_CONFLICT)
        PostReaction.objects.create(post=post, user=request.user, emoji=emoji)
        added = True
    all_reactions = list(PostReaction.objects.filter(post=post))
    broadcast(post.channel_id, {'type': 'reaction_update', 'post_id': str(post.id),
                                'reactions': aggregate_reactions(all_reactions, None)})
    return Response({'added': added, 'reactions': aggregate_reactions(all_reactions, request.user)})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def post_view(request, post_id):
    post, sub = _post_for_member(request, post_id)
    if post is None:
        return _nf()
    # Non-subscribers previewing a channel get a harmless no-op.
    if sub is not None:
        PostView.objects.get_or_create(post=post, user=request.user)
    return Response({'views': PostView.objects.filter(post=post).count()})


def _comment_data(c):
    return {
        'id': str(c.id),
        'author': {k: v for k, v in _author_brief(c.author).items() if k in ('id', 'username', 'nickname', 'avatar')},
        'content': c.content,
        'created_at': c.created_at.isoformat(),
    }


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def post_comments(request, post_id):
    post, sub = _post_for_member(request, post_id)
    if post is None or (sub is None and not post.channel.is_discoverable):
        return _nf()
    if request.method == 'GET':
        return Response([_comment_data(c) for c in post.comments.select_related('author')])
    if sub is None:
        return _forbidden('subscribe to comment')
    if not post.channel.comments_enabled:
        return _forbidden('comments disabled')
    content = (request.data.get('content') or '').strip()
    if not content:
        return Response({'error': 'content required'}, status=status.HTTP_400_BAD_REQUEST)
    c = PostComment(post=post, author=request.user)
    c.content = content[:2000]
    c.save()
    data = _comment_data(c)
    broadcast(post.channel_id, {'type': 'comment_added', 'post_id': str(post.id), 'comment': data})
    return Response(data, status=status.HTTP_201_CREATED)


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def comment_delete(request, comment_id):
    c = PostComment.objects.select_related('post').filter(id=comment_id, author=request.user).first()
    if c is None:
        return _nf()
    post_id, channel_id = str(c.post_id), c.post.channel_id
    c.delete()
    broadcast(channel_id, {'type': 'comment_deleted', 'post_id': post_id, 'comment_id': str(comment_id)})
    return Response(status=status.HTTP_204_NO_CONTENT)


# ── Rich interactions ───────────────────────────────────────────────────────

@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def poll_vote(request, post_id):
    post, sub = _post_for_member(request, post_id, message_type=MESSAGE_TYPE_POLL)
    if post is None or sub is None:
        return _nf()
    poll = post.payload
    if poll.get('closed') or _poll_expired(poll):
        return Response({'error': 'poll is closed'}, status=status.HTTP_409_CONFLICT)
    option_ids = request.data.get('option_ids')
    if not isinstance(option_ids, list):
        return Response({'error': 'option_ids must be a list'}, status=status.HTTP_400_BAD_REQUEST)
    valid = {o['id'] for o in poll.get('options', [])}
    chosen = list(dict.fromkeys(o for o in option_ids if o in valid))
    if option_ids and not chosen:
        return Response({'error': 'invalid options'}, status=status.HTTP_400_BAD_REQUEST)
    if not poll.get('multiple') and len(chosen) > 1:
        return Response({'error': 'this poll allows a single choice'}, status=status.HTTP_400_BAD_REQUEST)
    with transaction.atomic():
        PostPollVote.objects.filter(message=post, user=request.user).delete()
        PostPollVote.objects.bulk_create([PostPollVote(message=post, user=request.user, option_id=o) for o in chosen])
    post = Post.objects.prefetch_related('poll_votes__user').get(id=post.id)
    broadcast(post.channel_id, {'type': 'poll_update', 'post_id': str(post.id), 'poll': poll_view(post, None)})
    return Response({'poll': poll_view(post, request.user)})


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def poll_voters(request, post_id):
    post, sub = _post_for_member(request, post_id, message_type=MESSAGE_TYPE_POLL)
    if post is None or sub is None:
        return _nf()
    if post.payload.get('anonymous'):
        return _forbidden('anonymous poll')
    option_id = request.GET.get('option', '')
    if option_id not in {o['id'] for o in post.payload.get('options', [])}:
        return Response({'error': 'unknown option'}, status=status.HTTP_400_BAD_REQUEST)
    try:
        offset = max(0, int(request.GET.get('offset', 0)))
        limit = min(max(1, int(request.GET.get('limit', 50))), 100)
    except ValueError:
        offset, limit = 0, 50
    base = PostPollVote.objects.filter(message=post, option_id=option_id)
    rows = base.select_related('user').order_by('created_at')[offset:offset + limit]
    voters = [{k: v for k, v in _author_brief(r.user).items() if k in ('id', 'username', 'nickname', 'avatar')} for r in rows]
    return Response({'voters': voters, 'total': base.count(), 'offset': offset, 'limit': limit})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def poll_close(request, post_id):
    post, sub = _post_for_member(request, post_id, message_type=MESSAGE_TYPE_POLL)
    if post is None or sub is None:
        return _nf()
    if post.author_id != request.user.id and sub.role != 'owner':
        return _forbidden()
    payload = post.payload
    payload['closed'] = True
    post.payload = payload
    post.save(update_fields=['encrypted_payload'])
    post = Post.objects.prefetch_related('poll_votes__user').get(id=post.id)
    broadcast(post.channel_id, {'type': 'poll_update', 'post_id': str(post.id), 'poll': poll_view(post, None)})
    return Response({'poll': poll_view(post, request.user)})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def todo_toggle(request, post_id):
    post, sub = _post_for_member(request, post_id, message_type=MESSAGE_TYPE_TODO)
    if post is None or sub is None:
        return _nf()
    # A post is broadcast content: only its author and the channel owner tick items.
    if post.author_id != request.user.id and sub.role != 'owner':
        return _forbidden()
    try:
        _toggle_todo_item(post, PostTodoCheck, request.user, request.data.get('item_id'))
    except RichError as exc:
        return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    view = todo_view(Post.objects.prefetch_related('todo_checks__user').get(id=post.id))
    broadcast(post.channel_id, {'type': 'todo_update', 'post_id': str(post.id), 'todo': view})
    return Response({'todo': view})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def location_update(request, post_id):
    post, sub = _post_for_member(request, post_id, message_type=MESSAGE_TYPE_LOCATION)
    if post is None or sub is None:
        return _nf()
    if post.author_id != request.user.id:
        return _forbidden()
    try:
        _apply_location_update(post, request.data, stop=bool(request.data.get('stop')))
    except RichError as exc:
        return Response({'error': str(exc)}, status=status.HTTP_409_CONFLICT)
    view = location_view(post)
    broadcast(post.channel_id, {'type': 'location_update', 'post_id': str(post.id), 'location': view})
    return Response({'location': view})


# ── Attachments ─────────────────────────────────────────────────────────────

@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def upload(request, channel_id):
    ch, err = _owned_channel(request, channel_id)
    if err:
        return err
    f = request.FILES.get('file')
    if not f:
        return Response({'error': 'no file provided'}, status=status.HTTP_400_BAD_REQUEST)
    if f.size > MAX_UPLOAD_SIZE:
        return Response({'error': 'file too large (max 50 MB)'}, status=status.HTTP_400_BAD_REQUEST)
    ok, content_type = _safe_upload(f)
    if not ok:
        return Response({'error': 'file type not allowed'}, status=status.HTTP_400_BAD_REQUEST)
    raw = f.read()
    if not _scan_upload(raw):
        return Response({'error': 'file rejected by scanner'}, status=status.HTTP_400_BAD_REQUEST)
    att = PostAttachment(channel=ch, uploader=request.user, original_filename=f.name,
                         content_type=content_type, file_size=len(raw))
    att.file.save(f'{uuid.uuid4().hex}.enc', ContentFile(encrypt_bytes(raw)), save=True)
    return Response(attachment_data(att), status=status.HTTP_201_CREATED)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def download(request, attachment_id):
    att = PostAttachment.objects.select_related('channel').filter(id=attachment_id).first()
    if att is None or not _readable(att.channel, request.user):
        return _nf()
    try:
        with att.file.open('rb') as fh:
            data = decrypt_bytes(fh.read())
    except FileNotFoundError:
        return _nf()
    response = HttpResponse(data, content_type=att.content_type)
    response['Content-Disposition'] = 'attachment; filename="{}"'.format(att.original_filename.replace('"', '\\"'))
    response['Content-Length'] = att.file_size
    response['X-Content-Type-Options'] = 'nosniff'
    return response
