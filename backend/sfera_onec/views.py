"""1C integration API (mounted at /api/onec/)."""
import hmac
import json
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

from .client import OneCClient, OneCError, check_entity, check_field, clean_base_url
from .models import Connection, Event

MODULE = 'onec'
SECRET_MASK = '••••••'


def _err(code, status=400, **extra):
    return Response({'error': code, **extra}, status=status)


def _can_act(user, conn):
    return user.is_superuser or not conn.allowed_users.exists() or conn.allowed_users.filter(id=user.id).exists()


def _log(direction, kind, summary, *, ok=True, entity_id='', payload=None, user=None):
    Event.objects.create(direction=direction, kind=kind, summary=summary[:300], ok=ok, entity_id=str(entity_id or '')[:64],
                         payload=payload or {}, user=user if user and user.is_authenticated else None)
    stale = list(Event.objects.order_by('-created_at').values_list('id', flat=True)[2000:2100])
    if stale:
        Event.objects.filter(id__in=stale).delete()


def _api_error(e: OneCError, conn=None):
    code = str(e)
    if code in ('bad_entity', 'bad_field', 'bad_key'):
        return _err(code)
    if conn is not None:
        conn.last_error = code[:1000]
        conn.save(update_fields=['last_error'])
    if code == 'not_configured':
        return _err('not_configured', 409)
    return _err('onec_error', 502, detail=code[:500])


def _guard(request):
    conn = Connection.load()
    if not _can_act(request.user, conn):
        return conn, _err('forbidden', 403)
    return conn, None


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def status(request):
    conn = Connection.load()
    return Response({
        'configured': conn.configured,
        'can_act': conn.configured and _can_act(request.user, conn),
        'can_manage': request.user.is_superuser,
        'entities': {'counterparty': conn.counterparty_entity, 'product': conn.product_entity, 'document': conn.document_entity},
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
        try:
            if 'base_url' in d:
                conn.base_url = clean_base_url(d['base_url'])
            for field in ('counterparty_entity', 'product_entity', 'document_entity'):
                if d.get(field):
                    setattr(conn, field, check_entity(str(d[field]).strip()))
            for field in ('document_counterparty_field', 'inn_field'):
                if d.get(field):
                    setattr(conn, field, check_field(str(d[field]).strip()))
        except OneCError as e:
            return _err(str(e))
        if 'username' in d:
            conn.username = str(d['username']).strip()[:150]
        if d.get('password') not in (None, SECRET_MASK):
            conn.password = str(d['password'])
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
                conn.entity_sets = OneCClient(conn).entity_sets()
                conn.last_error = ''
            except OneCError as e:
                conn.last_error = str(e)[:1000]
            conn.save(update_fields=['entity_sets', 'last_error'])
    return Response({
        'base_url': conn.base_url,
        'username': conn.username,
        'password': SECRET_MASK if conn.encrypted_password else '',
        'counterparty_entity': conn.counterparty_entity,
        'product_entity': conn.product_entity,
        'document_entity': conn.document_entity,
        'document_counterparty_field': conn.document_counterparty_field,
        'inn_field': conn.inn_field,
        'inbound_path': f'/api/onec/webhook/{conn.inbound_secret}/',
        'notify_users': [_author_brief(u) for u in conn.notify_users.all()],
        'allowed_users': [_author_brief(u) for u in conn.allowed_users.all()],
        'entity_sets': conn.entity_sets,
        'configured': conn.configured,
        'last_error': conn.last_error,
    })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def entity_sets(request):
    conn, denied = _guard(request)
    if denied:
        return denied
    return Response(conn.entity_sets)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def search(request):
    conn, denied = _guard(request)
    if denied:
        return denied
    entity = request.query_params.get('entity') or conn.counterparty_entity
    fields = ('Number',) if entity.startswith('Document_') else ('Description', 'Code')
    try:
        return Response(OneCClient(conn).search(entity, request.query_params.get('q', ''), fields=fields))
    except OneCError as e:
        return _api_error(e, conn)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def record(request, entity, key):
    conn, denied = _guard(request)
    if denied:
        return denied
    client = OneCClient(conn)
    try:
        data = client.record(entity, key)
        if entity == conn.counterparty_entity:
            try:
                data['documents'] = client.documents_of(key)
            except OneCError:
                data['documents'] = []
        return Response(data)
    except OneCError as e:
        return _api_error(e, conn)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def create_counterparty(request):
    conn, denied = _guard(request)
    if denied:
        return denied
    name = str(request.data.get('name', '')).strip()[:150]
    if not name:
        return _err('name_required')
    inn = ''.join(ch for ch in str(request.data.get('inn', '')) if ch.isdigit())[:12]
    comment = str(request.data.get('comment', '')).strip()[:1000]
    author = request.user.nickname or request.user.username
    try:
        brief = OneCClient(conn).create_counterparty(name, inn, f'{comment} (Сфера, {author})'.strip())
    except OneCError as e:
        _log('out', 'counterparty', f'Контрагент «{name}» не создан', ok=False, payload={'error': str(e)[:500]}, user=request.user)
        return _api_error(e, conn)
    _log('out', 'counterparty', f'Контрагент «{name}»', entity_id=brief['key'], user=request.user)
    return Response(brief, status=201)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def events(request):
    conn, denied = _guard(request)
    if denied:
        return denied
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
    scope = 'onec_webhook'


@api_view(['POST'])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([WebhookThrottle])
def webhook(request, secret):
    """Notifications from 1C: POST JSON {title, text, url?, to?: [login or email, …]} to /api/onec/webhook/<secret>/."""
    if MODULE not in installed_ids():
        return _err('not_found', 404)
    conn = Connection.load()
    if not hmac.compare_digest(str(secret), conn.inbound_secret):
        return _err('not_found', 404)
    data = request.data
    if not hasattr(data, 'get'):
        try:
            data = json.loads(request.body.decode('utf-8-sig'))
        except (ValueError, UnicodeDecodeError):
            return _err('bad_json')
    title = str(data.get('title', '')).strip()[:200]
    text = str(data.get('text', '')).strip()[:2000]
    url = str(data.get('url', '')).strip()[:500]
    if not (title or text):
        return _err('text_required')
    if url and not url.startswith(('http://', 'https://', 'e1c://')):
        url = ''
    to = data.get('to') or []
    if isinstance(to, str):
        to = [to]
    users = get_user_model().objects.filter(is_active=True)
    if to:
        names = [str(x).strip() for x in to[:200] if str(x).strip()]
        recipients = list(users.filter(Q(username__in=names) | Q(email__in=names)).values_list('id', flat=True))
    else:
        recipients = list(conn.notify_users.values_list('id', flat=True))
    summary = f'{title}: {text}' if title and text else (title or text)
    _log('in', 'notification', summary, payload={'title': title, 'text': text, 'url': url, 'to': to, 'delivered': len(recipients)})
    for uid in recipients:
        try:
            push_to_user(uid, 'onec.event', {'summary': summary[:300], 'url': url})
        except Exception:
            pass
    return Response({'ok': True, 'delivered': len(recipients)})
