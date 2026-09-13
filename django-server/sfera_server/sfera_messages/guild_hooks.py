"""Guild receivers for core hooks (profile, block audit, data export).

Transitional: these move into the servers / channels modules.
"""
from sfera_modules import hooks


def _mutual_guilds(viewer, target):
    from .models import Guild

    # Private guilds are somebody's diary and are never shared.
    return {'mutual_guilds': list(
        Guild.objects
        .filter(memberships__user=viewer)
        .filter(memberships__user=target)
        .exclude(is_private=True)
        .distinct()
        .values('id', 'name')[:20]
    )}


def _log_block(action):
    def receiver(sender, blocker, blocked, **kwargs):
        from .models import GuildAuditLog, GuildMembership

        shared = GuildMembership.objects.filter(user=blocker).values_list('guild_id', flat=True)
        for m in GuildMembership.objects.filter(user=blocked, guild_id__in=shared).select_related('guild'):
            GuildAuditLog.objects.create(
                guild=m.guild, action=action,
                actor_id=str(blocker.id), actor_username=blocker.username,
                target_id=str(blocked.id), target_username=blocked.username,
                details={},
            )
    return receiver


def _safe_content(obj):
    try:
        return obj.content
    except Exception:
        return None


def _export(user):
    from .models import GuildMessage, GuildPostComment

    server_messages = [{
        'id': str(m.id),
        'channel_id': str(m.channel_id),
        'channel_name': getattr(m.channel, 'name', ''),
        'content': _safe_content(m),
        'reply_to': str(m.reply_to_id) if m.reply_to_id else None,
        'is_pinned': m.is_pinned,
        'created_at': m.created_at.isoformat(),
    } for m in GuildMessage.objects.filter(author=user).select_related('channel').order_by('created_at').iterator()]
    post_comments = [{
        'id': str(c.id),
        'post_id': str(c.message_id),
        'content': _safe_content(c),
        'created_at': c.created_at.isoformat(),
    } for c in GuildPostComment.objects.filter(author=user).order_by('created_at').iterator()]
    return {'server_messages': server_messages, 'post_comments': post_comments}


def _metrics():
    from .models import (
        Guild, GuildAttachment, GuildChannel, GuildMessage, GuildMessageReaction,
        GuildMessageView, GuildPostComment, GuildScheduledMessage,
    )
    from .voice_state import _voice_channels

    guild_qs = Guild.objects.all()
    return {
        'tables': {
            'guilds': guild_qs.filter(is_personal_channel=False).count(),
            'personal_channels': guild_qs.filter(is_personal_channel=True).count(),
            'guild_channels': GuildChannel.objects.count(),
            'guild_messages': GuildMessage.objects.count(),
            'comments': GuildPostComment.objects.count(),
            'reactions': GuildMessageReaction.objects.count(),
            'post_views': GuildMessageView.objects.count(),
            'attachments': GuildAttachment.objects.count(),
            'scheduled': GuildScheduledMessage.objects.count(),
        },
        'ws': {
            'voice_channels_active': len(_voice_channels),
            'voice_users': sum(len([k for k in ch if k != '_guild_id']) for ch in _voice_channels.values()),
        },
    }


_block_receiver = _log_block('member_block')
_unblock_receiver = _log_block('member_unblock')


def connect():
    hooks.register(hooks.PROFILE_EXTRAS, 'servers', _mutual_guilds)
    hooks.register(hooks.DATA_EXPORT, 'servers', _export)
    hooks.register(hooks.METRICS, 'servers', _metrics)
    hooks.user_blocked.connect(_block_receiver, dispatch_uid='guild.block')
    hooks.user_unblocked.connect(_unblock_receiver, dispatch_uid='guild.unblock')
