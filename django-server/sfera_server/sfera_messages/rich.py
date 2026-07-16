"""Rich (non-text) messages: polls, todo checklists, contacts and locations.

Input validation lives in the `build_*` helpers (they return the payload dict to
store, encrypted, on the message). Read-side shaping lives in the `*_view`
helpers, which merge the stored payload with the relational state kept outside it
(poll votes, todo ticks) so counts stay queryable and race-free.
"""
import uuid
from collections import defaultdict
from datetime import timedelta

from django.utils import timezone

from .models import (
    MESSAGE_TYPE_TEXT,
    MESSAGE_TYPE_POLL,
    MESSAGE_TYPE_TODO,
    MESSAGE_TYPE_CONTACT,
    MESSAGE_TYPE_LOCATION,
)

MAX_POLL_OPTIONS = 10
MIN_POLL_OPTIONS = 2
MAX_TODO_ITEMS = 25
MAX_LIVE_MINUTES = 8 * 60          # cap live-location sharing at 8h
MAX_POLL_DURATION_MINUTES = 60 * 24 * 14   # 14 days


class RichError(ValueError):
    """Invalid client input. The message is safe to surface to the caller."""


def _short_id():
    return uuid.uuid4().hex[:12]


def _text(value, limit, field, required=True):
    if value is None:
        value = ''
    if not isinstance(value, str):
        raise RichError(f'{field} must be a string')
    value = value.strip()
    if required and not value:
        raise RichError(f'{field} is required')
    return value[:limit]


def _int(value, field, default=0):
    if value in (None, ''):
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        raise RichError(f'{field} must be a number')


# ──────────────────────────────────────────────────────────────────────────────
# Build (write side)
# ──────────────────────────────────────────────────────────────────────────────

def build_poll(data):
    question = _text(data.get('question'), 300, 'question')

    raw = data.get('options')
    if not isinstance(raw, list):
        raise RichError('options must be a list')
    options, seen = [], set()
    for item in raw:
        text = item.strip() if isinstance(item, str) else ''
        if not text or text.casefold() in seen:
            continue
        seen.add(text.casefold())
        options.append({'id': _short_id(), 'text': text[:100]})
    if len(options) < MIN_POLL_OPTIONS:
        raise RichError(f'a poll needs at least {MIN_POLL_OPTIONS} distinct options')
    if len(options) > MAX_POLL_OPTIONS:
        raise RichError(f'a poll allows at most {MAX_POLL_OPTIONS} options')

    payload = {
        'question': question,
        'options': options,
        'multiple': bool(data.get('multiple')),
        'anonymous': bool(data.get('anonymous')),
        'closed': False,
    }
    minutes = _int(data.get('duration_minutes'), 'duration_minutes')
    if minutes > 0:
        minutes = min(minutes, MAX_POLL_DURATION_MINUTES)
        payload['closes_at'] = (timezone.now() + timedelta(minutes=minutes)).isoformat()
    return payload


def build_todo(data):
    raw = data.get('items')
    if not isinstance(raw, list):
        raise RichError('items must be a list')
    items, seen = [], set()
    for item in raw:
        text = item.strip() if isinstance(item, str) else ''
        if not text or text.casefold() in seen:
            continue
        seen.add(text.casefold())
        items.append({'id': _short_id(), 'text': text[:200]})
    if not items:
        raise RichError('a checklist needs at least one item')
    if len(items) > MAX_TODO_ITEMS:
        raise RichError(f'a checklist allows at most {MAX_TODO_ITEMS} items')
    return {
        'title': _text(data.get('title'), 200, 'title', required=False),
        'items': items,
    }


def build_contact(data, user_model):
    kind = data.get('kind') or 'manual'
    if kind == 'user':
        user_id = data.get('user_id')
        if not user_id:
            raise RichError('user_id is required')
        try:
            u = user_model.objects.get(id=user_id)
        except (user_model.DoesNotExist, ValueError, TypeError):
            raise RichError('user not found')
        return {
            'kind': 'user',
            'user_id': str(u.id),
            'username': u.username,
            'nickname': getattr(u, 'nickname', '') or '',
            'avatar': u.avatar.url if getattr(u, 'avatar', None) else '',
        }
    if kind == 'manual':
        return {
            'kind': 'manual',
            'name': _text(data.get('name'), 100, 'name'),
            'phone': _text(data.get('phone'), 40, 'phone'),
        }
    raise RichError('unknown contact kind')


def build_location(data):
    """Returns (payload, live_until). live_until is None for a static pin."""
    try:
        lat = float(data.get('lat'))
        lng = float(data.get('lng'))
    except (TypeError, ValueError):
        raise RichError('lat and lng are required')
    if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
        raise RichError('coordinates out of range')

    minutes = _int(data.get('live_minutes'), 'live_minutes')
    live_until = None
    if minutes > 0:
        live_until = timezone.now() + timedelta(minutes=min(minutes, MAX_LIVE_MINUTES))

    payload = {
        'lat': round(lat, 6),
        'lng': round(lng, 6),
        'label': _text(data.get('label'), 120, 'label', required=False),
        'live': live_until is not None,
        'updated_at': timezone.now().isoformat(),
    }
    return payload, live_until


# ──────────────────────────────────────────────────────────────────────────────
# View (read side)
# ──────────────────────────────────────────────────────────────────────────────

def _user_brief(u):
    return {
        'id': str(u.id),
        'username': u.username,
        'nickname': getattr(u, 'nickname', '') or '',
        'avatar': u.avatar.url if getattr(u, 'avatar', None) else '',
    }


def _poll_expired(payload):
    closes_at = payload.get('closes_at')
    if not closes_at:
        return False
    try:
        from django.utils.dateparse import parse_datetime
        dt = parse_datetime(closes_at)
    except (TypeError, ValueError):
        return False
    return bool(dt and dt <= timezone.now())


def poll_view(msg, user=None):
    """`user=None` yields a broadcast-safe view: the personal `me`/`voted` flags
    are then always false, so one payload can be fanned out to every client
    without leaking the voter's own selection onto everyone else."""
    payload = msg.payload
    votes = list(msg.poll_votes.all())

    counts = defaultdict(int)
    mine = set()
    voters = defaultdict(list)
    anonymous = bool(payload.get('anonymous'))
    for v in votes:
        counts[v.option_id] += 1
        if user is not None and v.user_id == user.id:
            mine.add(v.option_id)
        if not anonymous:
            voters[v.option_id].append(_user_brief(v.user))

    options = [
        {
            'id': o['id'],
            'text': o['text'],
            'count': counts.get(o['id'], 0),
            'me': o['id'] in mine,
            'voters': voters.get(o['id'], []) if not anonymous else [],
        }
        for o in payload.get('options', [])
    ]
    return {
        'question': payload.get('question', ''),
        'options': options,
        'multiple': bool(payload.get('multiple')),
        'anonymous': anonymous,
        'closed': bool(payload.get('closed')) or _poll_expired(payload),
        'closes_at': payload.get('closes_at'),
        'total_votes': len(votes),
        'total_voters': len({v.user_id for v in votes}),
        'voted': bool(mine),
    }


def todo_view(msg, user=None):
    payload = msg.payload
    checks = {c.item_id: c for c in msg.todo_checks.all()}
    items = []
    for i in payload.get('items', []):
        c = checks.get(i['id'])
        items.append({
            'id': i['id'],
            'text': i['text'],
            'done': c is not None,
            'done_by': _user_brief(c.user) if c else None,
            'done_at': c.created_at.isoformat() if c else None,
        })
    return {
        'title': payload.get('title', ''),
        'items': items,
        'done_count': sum(1 for i in items if i['done']),
        'total': len(items),
    }


def contact_view(msg, user=None):
    return msg.payload


def location_view(msg, user=None):
    payload = msg.payload
    live = bool(payload.get('live')) and bool(msg.live_until) and msg.live_until > timezone.now()
    payload = dict(payload)
    payload['live'] = live
    payload['live_until'] = msg.live_until.isoformat() if msg.live_until else None
    return payload


_VIEWS = {
    MESSAGE_TYPE_POLL: poll_view,
    MESSAGE_TYPE_TODO: todo_view,
    MESSAGE_TYPE_CONTACT: contact_view,
    MESSAGE_TYPE_LOCATION: location_view,
}


def rich_fields(msg, user):
    """Extra JSON keys for any message. Plain text messages stay cheap."""
    kind = msg.message_type or MESSAGE_TYPE_TEXT
    view = _VIEWS.get(kind)
    if view is None:
        return {'message_type': MESSAGE_TYPE_TEXT, 'payload': None}
    return {'message_type': kind, 'payload': view(msg, user)}
