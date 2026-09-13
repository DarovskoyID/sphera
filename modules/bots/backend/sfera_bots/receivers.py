"""Core hook receivers: the only way messaging reaches the bot layer."""


def on_message_created(sender, kind, message, **kwargs):
    """Queue a stored message for the bots that can see it (and let Сфероник reply)."""
    from . import outbound

    if kind == 'dm':
        outbound.dispatch_dm_message(message)
    elif kind == 'channel':
        outbound.dispatch_channel_message(message)


def on_conversation_opened(sender, user, peer_id, **kwargs):
    """A DM list is built from friendships; a bot can't accept a request, so
    starting a chat with one adds the contact directly."""
    from sfera_auth.models import User
    from .outbound import ensure_contact

    peer = User.objects.filter(id=peer_id, account_type='bot').first()
    if peer is not None:
        ensure_contact(user, peer)
