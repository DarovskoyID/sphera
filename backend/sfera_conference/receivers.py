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
    from .models import Conference, ConferencePeer

    return {
        'tables': {'conferences': Conference.objects.count(), 'conference_peers': ConferencePeer.objects.count()},
        'prometheus': [{
            'name': 'sfera_conference_active_rooms', 'type': 'gauge',
            'value': Conference.objects.filter(ended_at__isnull=True, peers__isnull=False).distinct().count(),
            'help': 'Conferences with at least one participant', 'labels': {},
        }],
    }


def has_data(user):
    from .models import Conference

    return Conference.objects.filter(owner=user).exists()
