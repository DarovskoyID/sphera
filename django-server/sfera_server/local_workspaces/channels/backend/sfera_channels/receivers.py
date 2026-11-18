def _safe(obj):
    try:
        return obj.content
    except Exception:
        return None


def export(user):
    from .models import Post, PostComment

    posts = [{
        'id': str(p.id), 'channel': p.channel.name, 'content': _safe(p), 'tags': p.tags or [],
        'type': p.message_type, 'created_at': p.created_at.isoformat(),
    } for p in Post.objects.filter(author=user).select_related('channel').order_by('created_at').iterator()]
    comments = [{
        'id': str(c.id), 'post_id': str(c.post_id), 'content': _safe(c), 'created_at': c.created_at.isoformat(),
    } for c in PostComment.objects.filter(author=user).order_by('created_at').iterator()]
    return {'channel_posts': posts, 'channel_comments': comments}


def metrics():
    from .models import Channel, Post, PostAttachment, PostComment, PostReaction, PostView

    return {'tables': {
        'personal_channels': Channel.objects.count(),
        'channel_posts': Post.objects.count(),
        'comments': PostComment.objects.count(),
        'reactions': PostReaction.objects.count(),
        'post_views': PostView.objects.count(),
        'attachments': PostAttachment.objects.count(),
    }}


def has_data(user):
    from .models import Subscription

    return Subscription.objects.filter(user=user).exists()


def on_user_blocked(sender, blocker, blocked, **kwargs):
    """Blocking a channel owner unsubscribes you; blocking a subscriber removes them."""
    from .models import Subscription

    Subscription.objects.filter(user=blocker, channel__owner=blocked).exclude(role='owner').delete()
    Subscription.objects.filter(user=blocked, channel__owner=blocker).exclude(role='owner').delete()
