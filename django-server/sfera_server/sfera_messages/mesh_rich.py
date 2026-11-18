"""Rich DM views built exclusively from an authenticated immutable snapshot."""
import json
import re

from django.utils import timezone
from django.utils.dateparse import parse_datetime
from .encryption import decrypt_text


def capture_state(message):
    if message.message_type == 'poll':
        from .rich import _user_brief
        votes = list(message.poll_votes.select_related('user').order_by('created_at', 'pk')[:257])
        if len(votes) > 256:
            raise ValueError('mesh_poll_vote_snapshot_limit')
        return {'votes': [{'option_id': vote.option_id, 'user': _user_brief(vote.user),
                           'created_at': vote.created_at.isoformat()} for vote in votes]}
    if message.message_type != 'todo':
        return None
    from .rich import _user_brief
    return {'checks': [{'item_id': check.item_id, 'user': _user_brief(check.user),
                        'created_at': check.created_at.isoformat()}
                       for check in message.todo_checks.filter(item_id__in=[item['id'] for item in message.payload.get('items', [])]).select_related('user').order_by('item_id')]}


def snapshot_fields(body, viewer=None):
    kind = body.get('message_type')
    if kind == 'cipher':
        from .dm_cipher import parse
        if (body.get('domain') != 'sfera-mesh-django-message-v2' or body.get('attachments') != [] or
                body.get('reply_to_id') is not None or body.get('live_until') is not None or body.get('edited') is not False or
                decrypt_text(body['encrypted_content']) != ''):
            raise ValueError('cipher_message_snapshot_corrupt')
        payload = parse(json.loads(decrypt_text(body['encrypted_payload'])), body['conversation_id'],
            identity=body['message_id'], author=body['author_id'])
        return {'message_type': 'cipher', 'payload': payload}
    if kind == 'text':
        return {'message_type': 'text', 'payload': None}
    if kind not in ('todo', 'contact', 'location', 'poll'):
        raise ValueError('unsupported_message_mesh_rich_type')
    payload = json.loads(decrypt_text(body['encrypted_payload']))
    if not isinstance(payload, dict):
        raise ValueError('message_mesh_rich_payload_corrupt')
    if kind == 'poll':
        from .rich import _poll_expired
        state = body.get('rich_state')
        options = payload.get('options')
        if (not isinstance(options, list) or not 2 <= len(options) <= 10 or not isinstance(payload.get('question'), str)
                or not all(type(payload.get(key)) is bool for key in ('multiple', 'anonymous', 'closed'))
                or not isinstance(state, dict) or set(state) != {'votes'} or not isinstance(state['votes'], list) or len(state['votes']) > 256):
            raise ValueError('mesh_poll_snapshot_corrupt')
        identifiers = set()
        for option in options:
            if not isinstance(option, dict) or set(option) != {'id', 'text'} or not isinstance(option['id'], str) or option['id'] in identifiers or not isinstance(option['text'], str):
                raise ValueError('mesh_poll_option_corrupt')
            identifiers.add(option['id'])
        votes, seen, mine = {identity: [] for identity in identifiers}, set(), set()
        for vote in state['votes']:
            if (not isinstance(vote, dict) or set(vote) != {'option_id', 'user', 'created_at'} or
                    vote['option_id'] not in identifiers or not isinstance(vote['user'], dict) or
                    set(vote['user']) != {'id', 'username', 'nickname', 'avatar'} or not all(isinstance(value, str) for value in vote['user'].values()) or
                    not isinstance(vote['created_at'], str) or parse_datetime(vote['created_at']) is None):
                raise ValueError('mesh_poll_vote_corrupt')
            identity = (vote['option_id'], vote['user']['id'])
            if identity in seen:
                raise ValueError('mesh_poll_duplicate_vote')
            seen.add(identity); votes[vote['option_id']].append(vote['user'])
            if viewer is not None and vote['user']['id'] == str(viewer):
                mine.add(vote['option_id'])
        payload = {'question': payload['question'], 'options': [{**option, 'count': len(votes[option['id']]),
                    'me': option['id'] in mine, 'voters': [] if payload['anonymous'] else votes[option['id']][:8]} for option in options],
                   'multiple': payload['multiple'], 'anonymous': payload['anonymous'], 'closed': payload['closed'] or _poll_expired(payload),
                   'closes_at': payload.get('closes_at'), 'total_votes': len(seen), 'total_voters': len({identity[1] for identity in seen}), 'voted': bool(mine)}
    elif kind == 'todo':
        if set(payload) != {'title', 'items'} or not isinstance(payload['title'], str) or len(payload['title']) > 200 or not isinstance(payload['items'], list) or not 1 <= len(payload['items']) <= 25:
            raise ValueError('message_mesh_checklist_corrupt')
        items, seen = [], set()
        state = body.get('rich_state')
        if not isinstance(state, dict) or set(state) != {'checks'} or not isinstance(state['checks'], list) or len(state['checks']) > 25:
            raise ValueError('message_mesh_checklist_snapshot_required')
        checks = {}
        for check in state['checks']:
            if (not isinstance(check, dict) or set(check) != {'item_id', 'user', 'created_at'} or
                    not isinstance(check['item_id'], str) or check['item_id'] in checks or
                    not isinstance(check['user'], dict) or set(check['user']) != {'id', 'username', 'nickname', 'avatar'} or
                    not all(isinstance(value, str) and len(value) <= 4096 for value in check['user'].values()) or
                    not isinstance(check['created_at'], str) or parse_datetime(check['created_at']) is None):
                raise ValueError('message_mesh_checklist_state_corrupt')
            checks[check['item_id']] = check
        for item in payload['items']:
            if (not isinstance(item, dict) or set(item) != {'id', 'text'} or not isinstance(item['id'], str) or
                    re.fullmatch('[0-9a-f]{12}', item['id']) is None or item['id'] in seen or
                    not isinstance(item['text'], str) or not 1 <= len(item['text']) <= 200):
                raise ValueError('message_mesh_checklist_item_corrupt')
            seen.add(item['id']); check = checks.get(item['id'])
            items.append({**item, 'done': check is not None, 'done_by': check['user'] if check else None,
                          'done_at': check['created_at'] if check else None})
        # Old ticks may remain after the author replaces a checklist's items;
        # they are committed for auditing but do not tick unrelated new items.
        payload = {'title': payload['title'], 'items': items,
                   'done_count': sum(item['done'] for item in items), 'total': len(items)}
    elif kind == 'location':
        if (not set(payload).issubset({'lat', 'lng', 'label', 'live', 'updated_at'}) or
                type(payload.get('lat')) not in (int, float) or not -90 <= payload['lat'] <= 90 or
                type(payload.get('lng')) not in (int, float) or not -180 <= payload['lng'] <= 180 or
                not isinstance(payload.get('label'), str) or type(payload.get('live')) is not bool):
            raise ValueError('message_mesh_location_corrupt')
        until = parse_datetime(body['live_until']) if body.get('live_until') else None
        payload = {**payload, 'live': bool(payload['live'] and until and until > timezone.now()),
                   'live_until': until.isoformat() if until else None}
    elif payload.get('kind') == 'manual':
        if set(payload) != {'kind', 'name', 'phone'} or not all(isinstance(payload[key], str) for key in ('name', 'phone')):
            raise ValueError('message_mesh_contact_corrupt')
    elif payload.get('kind') == 'user':
        if set(payload) != {'kind', 'user_id', 'username', 'nickname', 'avatar'} or not all(isinstance(value, str) for value in payload.values()):
            raise ValueError('message_mesh_contact_corrupt')
    else:
        raise ValueError('message_mesh_contact_corrupt')
    return {'message_type': kind, 'payload': payload}
