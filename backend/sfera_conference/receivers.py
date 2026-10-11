def export(user):
    from .models import Conference, ConferenceMessage

    return {
        'conferences': [
            {'title': c.title, 'kind': c.kind, 'created_at': c.created_at.isoformat(),
             'ended_at': c.ended_at.isoformat() if c.ended_at else None}
            for c in Conference.objects.filter(owner=user).iterator()
        ],
        'conference_messages': [
            {'conference': m.conference.title, 'text': m.text, 'created_at': m.created_at.isoformat()}
            for m in ConferenceMessage.objects.filter(author=user).select_related('conference').iterator()
        ],
    }


def metrics():
    """Rooms, people in them and which media path they use (mesh does not scale)."""
    from sfera_modules.hooks import approx_count
    from sfera_server.metrics import _cval

    from .access import media_config
    from .models import Conference, ConferenceMessage, ConferencePeer

    live = list(ConferencePeer.objects.filter(status=ConferencePeer.STATUS_JOINED)
                .values_list('conference_id', flat=True))
    rooms = len(set(live))
    waiting = ConferencePeer.objects.filter(status=ConferencePeer.STATUS_LOBBY).count()
    sfu = 1 if media_config() else 0
    return {
        'tables': {
            'conferences': approx_count(Conference),
            'conference_peers': approx_count(ConferencePeer),
            'conference_messages': approx_count(ConferenceMessage),
        },
        'prometheus': [
            {'name': 'sfera_conference_active_rooms', 'type': 'gauge', 'value': rooms,
             'help': 'Conferences with at least one participant'},
            {'name': 'sfera_conference_participants', 'type': 'gauge', 'value': len(live),
             'help': 'People currently in conferences'},
            {'name': 'sfera_conference_lobby_waiting', 'type': 'gauge', 'value': waiting,
             'help': 'Guests waiting to be let in'},
            {'name': 'sfera_conference_media_server', 'type': 'gauge', 'value': sfu,
             'help': '1 when a LiveKit media server is configured, 0 for peer-to-peer'},
            {'name': 'sfera_conference_joins_total', 'type': 'counter', 'value': _cval('conference_joins'),
             'help': 'Joins by registered users'},
            {'name': 'sfera_conference_guest_joins_total', 'type': 'counter', 'value': _cval('conference_guest_joins'),
             'help': 'Joins by guests with a link'},
            {'name': 'sfera_conference_chat_messages_total', 'type': 'counter', 'value': _cval('conference_chat_messages'),
             'help': 'Messages sent in conference chats'},
        ],
        'status': {'Конференции': {'Идёт встреч': rooms, 'Участников': len(live), 'Медиасервер': 'LiveKit' if sfu else 'P2P'}},
    }


def has_data(user):
    from .models import Conference

    return Conference.objects.filter(owner=user).exists()
