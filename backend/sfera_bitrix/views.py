"""Bitrix24 integration API (mounted at /api/bitrix/)."""
import hmac
import secrets

from django.contrib.auth import get_user_model
from django.db.models import Q
from rest_framework.decorators import api_view, authentication_classes, permission_classes, throttle_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle

from sfera_messages.services import _author_brief
from sfera_modules.hooks import push_to_user
from sfera_modules.permissions import installed_ids, requires_module

from .client import BitrixClient, BitrixError, describe_event, parse_webhook_url
from .models import Connection, Event

MODULE = 'bitrix'
SECRET_MASK = '••••••'
ENTITIES = {'lead', 'deal', 'contact', 'company'}


def _err(code, status=400, **extra):
    return Response({'error': code, **extra}, status=status)


def _can_act(user, conn):
    return user.is_superuser or not conn.allowed_users.exists() or conn.allowed_users.filter(id=user.id).exists()


def _log(direction, kind, summary, *, ok=True, entity_id='', payload=None, user=None):
    Event.objects.create(direction=direction, kind=kind, summary=summary[:300], ok=ok, entity_id=str(entity_id or '')[:40],
                         payload=payload or {}, user=user if user and user.is_authenticated else None)
    stale = list(Event.objects.order_by('-created_at').values_list('id', flat=True)[2000:2100])
    if stale:
        Event.objects.filter(id__in=stale).delete()


def _api_error(e: BitrixError, conn=None):
    if conn is not None:
        conn.last_error = str(e)[:1000]
        conn.save(update_fields=['last_error'])
    if str(e) == 'not_configured':
        return _err('not_configured', 409)
    return _err('bitrix_error', 502, detail=str(e)[:500])


def _signature(user):
    return f'\n\n— {user.nickname or user.username}, Сфера'


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def status(request):
    conn = Connection.load()
    return Response({
        'configured': conn.configured, 'portal': conn.portal, 'scopes': conn.scopes,
        'can_act': conn.configured and _can_act(request.user, conn), 'can_manage': request.user.is_superuser,
    })


@api_view(['GET', 'PUT'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def settings_view(request):
    if not request.user.is_superuser:
        return _err('forbidden', 403)
    conn = Connection.load()
    if request.method == 'PUT':
        d = request.data
        if d.get('webhook_url') not in (None, SECRET_MASK):
            if d['webhook_url']:
                try:
                    conn.webhook_url, conn.portal = parse_webhook_url(d['webhook_url'])
                except BitrixError:
                    return _err('bad_webhook_url')
            else:
                conn.webhook_url, conn.portal, conn.scopes = '', '', []
        if d.get('application_token') not in (None, SECRET_MASK):
            conn.application_token = str(d['application_token']).strip()
        if 'default_responsible_id' in d:
            conn.default_responsible_id = int(d['default_responsible_id']) if d['default_responsible_id'] else None
        if d.get('regenerate_inbound'):
            conn.inbound_secret = secrets.token_urlsafe()
        conn.save()
        users = get_user_model().objects.filter(is_active=True)
        if 'notify_user_ids' in d:
            conn.notify_users.set(users.filter(id__in=[str(x) for x in d['notify_user_ids']][:200]))
        if 'allowed_user_ids' in d:
            conn.allowed_users.set(users.filter(id__in=[str(x) for x in d['allowed_user_ids']][:500]))
        if conn.configured:
            try:
                conn.scopes = BitrixClient(conn).scopes()
                conn.last_error = ''
            except BitrixError as e:
                conn.last_error = str(e)[:1000]
            conn.save(update_fields=['scopes', 'last_error'])
    return Response({
        'webhook_url': SECRET_MASK if conn.encrypted_webhook_url else '',
        'portal': conn.portal,
        'application_token': SECRET_MASK if conn.encrypted_application_token else '',
        'default_responsible_id': conn.default_responsible_id,
        'inbound_path': f'/api/bitrix/webhook/{conn.inbound_secret}/',
        'notify_users': [_author_brief(u) for u in conn.notify_users.all()],
        'allowed_users': [_author_brief(u) for u in conn.allowed_users.all()],
        'scopes': conn.scopes,
        'configured': conn.configured,
        'last_error': conn.last_error,
    })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def portal_users(request):
    conn = Connection.load()
    if not _can_act(request.user, conn):
        return _err('forbidden', 403)
    try:
        return Response(BitrixClient(conn).users(str(request.query_params.get('q', ''))[:64]))
    except BitrixError as e:
        return _api_error(e)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def create(request, kind):
    """kind: lead | deal | task."""
    conn = Connection.load()
    if not _can_act(request.user, conn):
        return _err('forbidden', 403)
    d = request.data
    title = str(d.get('title', '')).strip()[:250]
    if not title:
        return _err('title_required')
    text = str(d.get('comment', '')).strip()
    text = f'{text}{_signature(request.user)}' if text else ''
    responsible = d.get('responsible_id') or conn.default_responsible_id
    client = BitrixClient(conn)
    labels = {'lead': 'Лид', 'deal': 'Сделка', 'task': 'Задача'}
    try:
        if kind == 'lead':
            result = client.create_lead(title=title, name=str(d.get('name', ''))[:100], phone=str(d.get('phone', ''))[:50],
                                        email=str(d.get('email', ''))[:200], comment=text, amount=d.get('amount'), responsible_id=responsible)
        elif kind == 'deal':
            result = client.create_deal(title=title, comment=text, amount=d.get('amount'), responsible_id=responsible)
        elif kind == 'task':
            result = client.create_task(title=title, description=text, responsible_id=responsible, deadline=d.get('deadline') or None)
        else:
            return _err('bad_kind', 404)
    except BitrixError as e:
        _log('out', kind, f'{labels.get(kind, kind)} «{title}» не создан(а)', ok=False, payload={'error': str(e)[:500]}, user=request.user)
        return _api_error(e, conn)
    except (TypeError, ValueError):
        return _err('bad_input')
    _log('out', kind, f'{labels[kind]} «{title}»', entity_id=result['id'], payload={'url': result['url']}, user=request.user)
    return Response(result, status=201)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def comment(request, entity, entity_id):
    conn = Connection.load()
    if not _can_act(request.user, conn):
        return _err('forbidden', 403)
    if entity not in ENTITIES:
        return _err('bad_entity', 404)
    text = str(request.data.get('text', '')).strip()
    if not text:
        return _err('text_required')
    try:
        BitrixClient(conn).comment(entity, entity_id, f'{text}{_signature(request.user)}')
    except BitrixError as e:
        return _api_error(e, conn)
    _log('out', 'comment', f'Комментарий: {entity} #{entity_id}', entity_id=entity_id, user=request.user)
    return Response({'ok': True}, status=201)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def search(request):
    conn = Connection.load()
    if not _can_act(request.user, conn):
        return _err('forbidden', 403)
    q = str(request.query_params.get('q', '')).strip()
    if len(q) < 2:
        return Response({'leads': [], 'deals': [], 'contacts': []})
    try:
        return Response(BitrixClient(conn).search(q))
    except BitrixError as e:
        return _api_error(e, conn)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def events(request):
    conn = Connection.load()
    if not _can_act(request.user, conn):
        return _err('forbidden', 403)
    qs = Event.objects.select_related('user')
    if request.query_params.get('direction') in ('in', 'out'):
        qs = qs.filter(direction=request.query_params['direction'])
    return Response([{
        'id': e.id, 'direction': e.direction, 'kind': e.kind, 'summary': e.summary, 'ok': e.ok, 'entity_id': e.entity_id,
        'user': _author_brief(e.user) if e.user else None, 'created_at': e.created_at.isoformat(),
    } for e in qs[:200]])


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def user_search(request):
    if not request.user.is_superuser:
        return _err('forbidden', 403)
    q = str(request.query_params.get('q', '')).strip()[:64]
    users = get_user_model().objects.filter(is_active=True).filter(Q(username__icontains=q) | Q(nickname__icontains=q)).exclude(account_type='bot')[:20]
    return Response([_author_brief(u) for u in users] if q else [])


class WebhookThrottle(AnonRateThrottle):
    rate = '600/minute'
    scope = 'bitrix_webhook'


@api_view(['POST'])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([WebhookThrottle])
def webhook(request, secret):
    """Outgoing webhook of the portal → /api/bitrix/webhook/<secret>/."""
    if MODULE not in installed_ids():
        return _err('not_found', 404)
    conn = Connection.load()
    if not hmac.compare_digest(str(secret), conn.inbound_secret):
        return _err('not_found', 404)
    info = describe_event(request.data if hasattr(request.data, 'get') else {})
    expected = conn.application_token
    if expected and not hmac.compare_digest(str(info['token']), expected):
        return _err('bad_token', 403)
    client = BitrixClient(conn)
    url = client.link(info['entity'], info['id']) if info['entity'] else ''
    _log('in', info['event'].lower()[:40] or 'event', info['summary'], entity_id=info['id'], payload={'url': url, 'domain': info['domain']})
    for uid in conn.notify_users.values_list('id', flat=True):
        try:
            push_to_user(uid, 'bitrix.event', {'summary': info['summary'], 'url': url})
        except Exception:
            pass
    return Response({'ok': True})
