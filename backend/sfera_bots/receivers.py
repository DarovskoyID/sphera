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


def metrics():
    """Bot API load (cross-process totals from Redis), two-tier throughput."""
    from sfera_server.metrics import _cval

    total = _cval('bot_api_requests_total')
    standard = _cval('bot_api_requests_standard')
    premium = _cval('bot_api_requests_premium')
    throttled = _cval('bot_api_throttled_total')
    return {
        'prometheus': [
            {'name': 'sfera_bot_api_requests_total', 'type': 'counter', 'value': total, 'help': 'Total bot API requests'},
            {'name': 'sfera_bot_api_requests_standard_total', 'type': 'counter', 'value': standard,
             'help': 'Bot API requests on the standard tier'},
            {'name': 'sfera_bot_api_requests_premium_total', 'type': 'counter', 'value': premium,
             'help': 'Bot API requests on the premium tier'},
            {'name': 'sfera_bot_api_throttled_total', 'type': 'counter', 'value': throttled,
             'help': 'Bot API requests rejected by rate limiting (429)'},
        ],
        'status': {'Bot API': {
            'Total Requests': total, 'Standard tier': standard, 'Premium tier': premium, 'Throttled (429)': throttled,
        }},
    }
