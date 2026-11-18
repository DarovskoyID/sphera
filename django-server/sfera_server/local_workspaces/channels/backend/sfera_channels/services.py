"""Serialization, realtime fanout and post delivery for channels."""
from collections import defaultdict

from django.db import transaction
from django.utils import timezone

from sfera_messages.rich import rich_fields
from sfera_messages.services import _author_brief, _fanout, _fanout_user_notifs, emit_message_created

from . import search
from .models import Channel, Post, PostAttachment, ScheduledPost, Subscription


def group(channel_id):
    return f'feed_{channel_id}'


def broadcast(channel_id, frame):
    """Push a frame to every open ws/channels/<id>/ socket (fire-and-forget)."""
    _fanout(group(channel_id), {'type': 'feed.event', 'data': frame}, None)


def channel_data(ch, user, subscription=None, subscriber_count=None):
    if subscription is None and user is not None:
        subscription = Subscription.objects.filter(channel=ch, user=user).first()
    if subscriber_count is None:
        subscriber_count = ch.subscriptions.count()
    return {
        'id': str(ch.id),
        'name': ch.name,
        'description': ch.description,
        'tags': ch.tags or [],
        'icon': ch.icon.url if ch.icon else '',
        'banner': ch.banner.url if ch.banner else '',
        'owner_id': str(ch.owner_id),
        'invite_code': ch.invite_code,
        'is_discoverable': ch.is_discoverable,
        'comments_enabled': ch.comments_enabled,
        'is_official': ch.is_official,
        'subscriber_count': subscriber_count,
        'my_role': subscription.role if subscription else '',
        'my_notifications_muted': subscription.notifications_muted if subscription else False,
        'created_at': ch.created_at.isoformat(),
    }


def attachment_data(att):
    return {
        'id': str(att.id),
        'filename': att.original_filename,
        'content_type': att.content_type,
        'file_size': att.file_size,
        'url': f'/api/channels/attachments/{att.id}/',
    }


def aggregate_reactions(reactions, user):
    grouped = defaultdict(lambda: {'count': 0, 'me': False})
    for r in reactions:
        grouped[r.emoji]['count'] += 1
        if user is not None and r.user_id == user.id:
            grouped[r.emoji]['me'] = True
    return [{'emoji': k, 'count': v['count'], 'me': v['me']} for k, v in grouped.items()]


def posts_qs():
    return Post.objects.select_related('author').prefetch_related(
        'attachments', 'reactions', 'views', 'comments', 'poll_votes__user', 'todo_checks__user',
    )


def post_data(p, user=None):
    """Same shape as a guild channel message, so the feed UI renders it unchanged."""
    return {
        'id': str(p.id),
        'channel_id': str(p.channel_id),
        'author': _author_brief(p.author),
        'content': p.content,
        'created_at': p.created_at.isoformat(),
        'is_pinned': p.is_pinned,
        'edited': p.edited,
        'reply_to': None,
        'attachments': [attachment_data(a) for a in p.attachments.all()],
        'reactions': aggregate_reactions(p.reactions.all(), user),
        'views': len(p.views.all()),
        'comments_count': len(p.comments.all()),
        'tags': p.tags or [],
        **rich_fields(p, user),
    }


def publish(post):
    """After a post is stored: index, realtime, subscriber notifications, bots."""
    post = posts_qs().get(id=post.id)
    search.index_post(post)
    broadcast(post.channel_id, {'type': 'post_created', 'post': post_data(post, None)})
    ch = post.channel
    recipients = list(
        Subscription.objects.filter(channel=ch, notifications_muted=False)
        .exclude(user_id=post.author_id).values_list('user_id', flat=True)
    )
    body = post.content or ('📎' if post.attachments.exists() else '')
    _fanout_user_notifs([str(u) for u in recipients], {
        'type': 'new_message_notification',
        'sender_name': ch.name,
        'content': body[:200],
        'channel_id': str(ch.id),
    })
    emit_message_created('feed_post', post)
    return post


def deliver_due(channel_id=None):
    """Publish scheduled posts whose time has come. Idempotent under concurrency."""
    qs = ScheduledPost.objects.filter(is_sent=False, send_at__lte=timezone.now())
    if channel_id is not None:
        qs = qs.filter(channel_id=channel_id)
    delivered = []
    for sched_id in list(qs.values_list('id', flat=True)[:50]):
        with transaction.atomic():
            sched = ScheduledPost.objects.select_for_update().filter(id=sched_id, is_sent=False).first()
            if sched is None:
                continue
            post = Post.objects.create(channel_id=sched.channel_id, author_id=sched.author_id,
                                       encrypted_content=sched.encrypted_content)
            if sched.attachment_ids:
                PostAttachment.objects.filter(
                    id__in=sched.attachment_ids, channel_id=sched.channel_id,
                    uploader_id=sched.author_id, post__isnull=True,
                ).update(post=post)
            sched.is_sent = True
            sched.save(update_fields=['is_sent'])
        delivered.append(publish(post))
    return delivered


def ensure_channel_visible(ch, user):
    """Subscribers see everything; others may preview a discoverable channel."""
    if Subscription.objects.filter(channel=ch, user=user).exists():
        return True
    return ch.is_discoverable


__all__ = [
    'Channel', 'broadcast', 'channel_data', 'post_data', 'posts_qs', 'publish', 'deliver_due',
    'attachment_data', 'aggregate_reactions', 'ensure_channel_visible',
]
