"""Guild models when the servers module is present on this instance.

Bots work in DMs on any instance; adding a bot to servers, posting to channels
and reacting there are available only when servers are installed.
"""
try:
    from sfera_servers.models import (  # noqa: F401
        Guild, GuildAttachment, GuildChannel, GuildMembership, GuildMessage, GuildMessageReaction,
    )
    HAS_SERVERS = True
except ImportError:  # servers module not deployed
    Guild = GuildAttachment = GuildChannel = GuildMembership = GuildMessage = GuildMessageReaction = None
    HAS_SERVERS = False
