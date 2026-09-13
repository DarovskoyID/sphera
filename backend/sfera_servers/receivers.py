"""Servers receivers for core hooks (profile, block audit, export, metrics, services)."""
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
            'guilds': guild_qs.count(),
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


class PrivateGuildService:
    """servers.private_guild: a non-discoverable server another module manages (family)."""

    @staticmethod
    def exists(guild_id):
        from .models import Guild
        return Guild.objects.filter(id=guild_id).exists()

    @staticmethod
    def create(name, owner, channels):
        from .models import Guild, GuildChannel, GuildMembership
        guild = Guild.objects.create(name=name, owner=owner, is_discoverable=False)
        for ch_name, ch_type, position in channels:
            GuildChannel.objects.create(guild=guild, name=ch_name, channel_type=ch_type, position=position)
        GuildMembership.objects.get_or_create(guild=guild, user=owner, defaults={'role': 'owner'})
        return guild.id

    @staticmethod
    def add_member(guild_id, user, role):
        from .models import GuildMembership
        GuildMembership.objects.get_or_create(guild_id=guild_id, user=user, defaults={'role': role})

    @staticmethod
    def remove_member(guild_id, user):
        from .models import GuildMembership
        GuildMembership.objects.filter(guild_id=guild_id, user=user).exclude(role='owner').delete()


def _ws_authorize(user, ws_type, data):
    """The Rust gateway asks before letting a socket into a guild channel room."""
    if ws_type != 'guild_channel':
        return None
    from sfera_modules.permissions import has_module
    if not has_module(user, 'servers'):
        return False
    from .models import GuildChannel, GuildMembership
    try:
        return (GuildChannel.objects.filter(id=data.get('channel_id'), guild_id=data.get('guild_id')).exists()
                and GuildMembership.objects.filter(guild_id=data.get('guild_id'), user=user).exists())
    except (ValueError, TypeError):
        return False


def _kafka_handlers():
    from .kafka import handlers
    return handlers()


def _encrypted_data():
    from .models import GuildAttachment, GuildMessage, GuildPostComment, GuildScheduledMessage
    return {'text': [GuildMessage, GuildScheduledMessage, GuildPostComment], 'files': [GuildAttachment]}


_block_receiver = _log_block('member_block')
_unblock_receiver = _log_block('member_unblock')


def connect():
    hooks.register(hooks.PROFILE_EXTRAS, 'servers', _mutual_guilds)
    hooks.register(hooks.DATA_EXPORT, 'servers', _export)
    hooks.register(hooks.METRICS, 'servers', _metrics)
    hooks.register(hooks.WS_AUTHORIZE, 'servers', _ws_authorize)
    hooks.register(hooks.KAFKA_HANDLERS, 'servers', _kafka_handlers)
    hooks.register(hooks.ENCRYPTED_DATA, 'servers', _encrypted_data)
    hooks.provide('servers.private_guild', PrivateGuildService)
    hooks.user_blocked.connect(_block_receiver, dispatch_uid='guild.block')
    hooks.user_unblocked.connect(_unblock_receiver, dispatch_uid='guild.unblock')
