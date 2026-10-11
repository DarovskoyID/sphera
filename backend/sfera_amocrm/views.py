"""amoCRM integration API (mounted at /api/amocrm/)."""
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
from sfera_server.metrics import inc as metrics_inc
from sfera_modules.permissions import installed_ids, requires_module

from .client import AmoClient, AmoError, clean_domain, now_ts, parse_webhook
from .models import Connection, Event

MODULE = 'amocrm'
SECRET_MASK = '••••••'


def _err(code, status=400, **extra):
    return Response({'error': code, **extra}, status=status)


def _can_act(user, conn):
    return user.is_superuser or not conn.allowed_users.exists() or conn.allowed_users.filter(id=user.id).exists()


def _log(direction, kind, summary, *, ok=True, entity_id='', payload=None, user=None):
    ev = Event.objects.create(direction=direction, kind=kind, summary=summary[:300], ok=ok, entity_id=str(entity_id or '')[:40],
                              payload=payload or {}, user=user if user and user.is_authenticated else None)
    # Keep the log bounded.
    stale = Event.objects.order_by('-created_at').values_list('id', flat=True)[2000:2100]
    if stale:
        Event.objects.filter(id__in=list(stale)).delete()
    return ev


def _event_data(e):
    return {
        'id': e.id, 'direction': e.direction, 'kind': e.kind, 'summary': e.summary, 'ok': e.ok, 'entity_id': e.entity_id,
        'user': _author_brief(e.user) if e.user else None, 'created_at': e.created_at.isoformat(),
    }


def _api_error(e: AmoError, conn=None):
    if conn is not None:
        conn.last_error = str(e)[:1000]
        conn.save(update_fields=['last_error'])
    if str(e) == 'not_configured':
        return _err('not_configured', 409)
    return _err('amocrm_error', 502, detail=str(e)[:500])


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def status(request):
    conn = Connection.load()
    return Response({
        'configured': conn.configured,
        'account_name': conn.account_name,
        'domain': conn.domain,
        'can_act': conn.configured and _can_act(request.user, conn),
        'can_manage': request.user.is_superuser,
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
            if 'domain' in d:
                conn.domain = clean_domain(d['domain'])
        except AmoError:
            return _err('bad_domain')
        for field in ('client_id', 'redirect_uri'):
            if field in d:
                setattr(conn, field, str(d[field]).strip()[:300])
        if d.get('client_secret') not in (None, SECRET_MASK):
            conn.client_secret = str(d['client_secret']).strip()
        if d.get('access_token') not in (None, SECRET_MASK):
            conn.access_token = str(d['access_token']).strip()
            # A pasted long-lived token replaces OAuth tokens.
            conn.refresh_token = ''
            conn.token_expires_at = None
        if 'pipeline_id' in d:
            conn.pipeline_id = int(d['pipeline_id']) if d['pipeline_id'] else None
        if d.get('regenerate_webhook'):
            conn.webhook_secret = secrets.token_urlsafe()
        conn.save()
        users = get_user_model().objects.filter(is_active=True)
        if 'notify_user_ids' in d:
            conn.notify_users.set(users.filter(id__in=[str(x) for x in d['notify_user_ids']][:200]))
        if 'allowed_user_ids' in d:
            conn.allowed_users.set(users.filter(id__in=[str(x) for x in d['allowed_user_ids']][:500]))
        if d.get('auth_code'):
            try:
                AmoClient(conn).exchange_code(str(d['auth_code']).strip())
            except AmoError as e:
                return _api_error(e, conn)
        if conn.configured:
            try:
                account = AmoClient(conn).account()
                conn.account_name = str(account.get('name', ''))[:200]
                conn.last_error = ''
            except AmoError as e:
                conn.last_error = str(e)[:1000]
            conn.save(update_fields=['account_name', 'last_error'])
    return Response({
        'domain': conn.domain,
        'access_token': SECRET_MASK if conn.encrypted_access_token else '',
        'oauth': bool(conn.encrypted_refresh_token),
        'client_id': conn.client_id,
        'client_secret': SECRET_MASK if conn.encrypted_client_secret else '',
        'redirect_uri': conn.redirect_uri,
        'pipeline_id': conn.pipeline_id,
        'webhook_path': f'/api/amocrm/webhook/{conn.webhook_secret}/',
        'notify_users': [_author_brief(u) for u in conn.notify_users.all()],
        'allowed_users': [_author_brief(u) for u in conn.allowed_users.all()],
        'account_name': conn.account_name,
        'configured': conn.configured,
        'last_error': conn.last_error,
    })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def pipelines(request):
    conn = Connection.load()
    try:
        return Response(AmoClient(conn).pipelines())
    except AmoError as e:
        return _api_error(e, conn)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def create_lead(request):
    conn = Connection.load()
    if not _can_act(request.user, conn):
        return _err('forbidden', 403)
    d = request.data
    name = str(d.get('name', '')).strip()[:250]
    if not name:
        return _err('name_required')
    author = request.user.nickname or request.user.username
    note = str(d.get('note', '')).strip()
    note = f'{note}\n\n— {author}, Сфера' if note else ''
    try:
        lead = AmoClient(conn).create_lead(
            name=name, price=d.get('price'), contact_name=str(d.get('contact_name', ''))[:250],
            phone=str(d.get('phone', ''))[:50], email=str(d.get('email', ''))[:200], note=note,
            pipeline_id=d.get('pipeline_id') or conn.pipeline_id,
        )
        if d.get('task_text') and d.get('task_due'):
            AmoClient(conn).add_task(lead['id'], str(d['task_text']), int(d['task_due']))
    except AmoError as e:
        _log('out', 'lead', f'Сделка «{name}» не создана', ok=False, payload={'error': str(e)[:500]}, user=request.user)
        return _api_error(e, conn)
    except (TypeError, ValueError):
        return _err('bad_input')
    _log('out', 'lead', f'Сделка «{name}»', entity_id=lead['id'], payload={'url': lead['url']}, user=request.user)
    return Response(lead, status=201)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def add_note(request, lead_id):
    conn = Connection.load()
    if not _can_act(request.user, conn):
        return _err('forbidden', 403)
    text = str(request.data.get('text', '')).strip()
    if not text:
        return _err('text_required')
    try:
        AmoClient(conn).add_note(lead_id, f'{text}\n\n— {request.user.nickname or request.user.username}, Сфера')
    except AmoError as e:
        return _api_error(e, conn)
    _log('out', 'note', f'Примечание к сделке #{lead_id}', entity_id=lead_id, user=request.user)
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
        return Response({'leads': [], 'contacts': []})
    try:
        return Response(AmoClient(conn).search(q))
    except AmoError as e:
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
    return Response([_event_data(e) for e in qs[:200]])


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
    scope = 'amocrm_webhook'


ACTIONS_RU = {'add': 'создан(а)', 'update': 'изменён(а)', 'delete': 'удалён(а)', 'status': 'сменил(а) этап', 'responsible': 'сменил(а) ответственного', 'restore': 'восстановлен(а)', 'note': 'новое примечание'}
ENTITIES_RU = {'leads': 'Сделка', 'contacts': 'Контакт', 'companies': 'Компания', 'tasks': 'Задача', 'customers': 'Покупатель', 'unsorted': 'Неразобранное', 'message': 'Сообщение'}


@api_view(['POST'])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([WebhookThrottle])
def webhook(request, secret):
    """Events amoCRM sends to /api/amocrm/webhook/<secret>/ (set up in amoCRM → Settings → Webhooks)."""
    if MODULE not in installed_ids():
        return _err('not_found', 404)
    conn = Connection.load()
    if not hmac.compare_digest(str(secret), conn.webhook_secret):
        return _err('not_found', 404)
    items = parse_webhook(request.data if hasattr(request.data, 'keys') else {})
    metrics_inc('amocrm_events_in', len(items))
    recipients = list(conn.notify_users.values_list('id', flat=True))
    domain = conn.domain
    for item in items[:100]:
        entity, action = item['entity'], item['action']
        entity_id = item.get('id', '')
        name = item.get('name') or item.get('text') or ''
        summary = f"{ENTITIES_RU.get(entity, entity)} {('«' + name + '» ') if name else ''}#{entity_id} {ACTIONS_RU.get(action, action)}".strip()
        url = f'https://{domain}/{entity}/detail/{entity_id}' if domain and entity in ('leads', 'contacts', 'companies') and entity_id else ''
        _log('in', f'{entity}.{action}', summary, entity_id=entity_id, payload={**item, 'url': url})
        for uid in recipients:
            try:
                push_to_user(uid, 'amocrm.event', {'summary': summary, 'url': url, 'entity': entity, 'action': action})
            except Exception:
                pass
    return Response({'ok': True, 'received': len(items)})
