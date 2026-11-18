"""Conferences API (mounted at /api/conference/)."""
from django.contrib.auth import get_user_model
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle

from sfera_messages.services import _author_brief
from sfera_modules.hooks import push_to_user
from sfera_modules.permissions import has_module, installed_ids, requires_module

from .access import (
    clean_name, is_host, issue_guest_pass, livekit_token, media_config, read_guest_pass, user_can_join,
)
from .consumers import live_peers
from .models import KIND_EXTERNAL, KIND_INTERNAL, KINDS, Conference, MediaSettings

MODULE = 'conference'
KIND_IDS = {k for k, _ in KINDS}


def _err(code, status=400):
    return Response({'error': code}, status=status)


def _data(c, user):
    return {
        'id': str(c.id),
        'slug': c.slug,
        'title': c.title,
        'description': c.description,
        'kind': c.kind,
        'owner': _author_brief(c.owner),
        'invited': [_author_brief(u) for u in c.invited.all()] if is_host(user, c) else [],
        'starts_at': c.starts_at.isoformat() if c.starts_at else None,
        'guest_lobby': c.guest_lobby,
        'created_at': c.created_at.isoformat(),
        'ended_at': c.ended_at.isoformat() if c.ended_at else None,
        'is_host': is_host(user, c),
        'participants': live_peers(c.id).count() if c.active else 0,
    }


def _parse_dt(value):
    if not value:
        return None
    dt = parse_datetime(str(value))
    if dt is None:
        raise ValueError
    return dt if timezone.is_aware(dt) else timezone.make_aware(dt)


def _notify_invited(conf, user_ids):
    for uid in user_ids:
        try:
            push_to_user(uid, 'conference.invited', {
                'slug': conf.slug, 'title': conf.title, 'from': conf.owner.nickname or conf.owner.username,
            })
        except Exception:
            pass


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def conference_list_create(request):
    user = request.user
    if request.method == 'GET':
        # Mine, the private ones I am invited to, and every open internal/external one.
        scope = request.query_params.get('scope', 'active')
        qs = Conference.objects.filter(Q(owner=user) | Q(invited=user) | Q(kind__in=[KIND_INTERNAL, KIND_EXTERNAL]))
        qs = qs.filter(ended_at__isnull=scope == 'active') if scope in ('active', 'ended') else qs
        if scope == 'ended':
            qs = qs.filter(Q(owner=user) | Q(invited=user))
        qs = qs.distinct().select_related('owner').prefetch_related('invited').order_by('-created_at')[:200]
        return Response([_data(c, user) for c in qs])

    title = str(request.data.get('title', '')).strip()[:160]
    kind = request.data.get('kind', KIND_INTERNAL)
    if not title:
        return _err('title_required')
    if kind not in KIND_IDS:
        return _err('bad_kind')
    try:
        starts_at = _parse_dt(request.data.get('starts_at'))
    except ValueError:
        return _err('bad_datetime')
    conf = Conference.objects.create(
        title=title, kind=kind, owner=user, starts_at=starts_at,
        description=str(request.data.get('description', ''))[:4000],
        guest_lobby=bool(request.data.get('guest_lobby')) and kind == KIND_EXTERNAL,
    )
    ids = [str(i) for i in (request.data.get('invitee_ids') or [])][:500]
    if ids:
        users = list(get_user_model().objects.filter(id__in=ids, is_active=True).exclude(id=user.id))
        conf.invited.set(users)
        _notify_invited(conf, [u.id for u in users])
    return Response(_data(conf, user), status=201)


@api_view(['GET', 'PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def conference_detail(request, slug):
    conf = Conference.objects.select_related('owner').filter(slug=slug).first()
    if not conf or not (is_host(request.user, conf) or user_can_join(request.user, conf) or conf.invited.filter(id=request.user.id).exists()):
        return _err('not_found', 404)
    if request.method == 'GET':
        return Response(_data(conf, request.user))
    if not is_host(request.user, conf):
        return _err('forbidden', 403)
    if request.method == 'DELETE':
        conf.delete()
        return Response(status=204)
    data = request.data
    if 'title' in data:
        title = str(data['title']).strip()[:160]
        if title:
            conf.title = title
    if 'description' in data:
        conf.description = str(data['description'])[:4000]
    if 'kind' in data:
        if data['kind'] not in KIND_IDS:
            return _err('bad_kind')
        conf.kind = data['kind']
    if 'guest_lobby' in data:
        conf.guest_lobby = bool(data['guest_lobby'])
    if 'starts_at' in data:
        try:
            conf.starts_at = _parse_dt(data['starts_at'])
        except ValueError:
            return _err('bad_datetime')
    if data.get('reopen'):
        conf.ended_at = None
    conf.save()
    if 'invitee_ids' in data:
        before = set(conf.invited.values_list('id', flat=True))
        users = list(get_user_model().objects.filter(id__in=[str(i) for i in data['invitee_ids']][:500], is_active=True).exclude(id=request.user.id))
        conf.invited.set(users)
        _notify_invited(conf, [u.id for u in users if u.id not in before])
    return Response(_data(conf, request.user))


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def conference_end(request, slug):
    conf = Conference.objects.filter(slug=slug).first()
    if not conf or not is_host(request.user, conf):
        return _err('not_found', 404)
    conf.ended_at = timezone.now()
    conf.save(update_fields=['ended_at'])
    return Response(_data(conf, request.user))


def _open_to_guests():
    # Guests have no account to check the module against: the instance must have it.
    return MODULE in installed_ids()


def _join_payload(conf, identity, name, host):
    cfg = media_config()
    media = {'mode': 'mesh'}
    if cfg:
        media = {'mode': 'livekit', 'url': cfg['url'], 'token': livekit_token(cfg, f'sfera-{conf.id}', identity, name, host)}
    return {
        'conference': {'id': str(conf.id), 'slug': conf.slug, 'title': conf.title, 'kind': conf.kind},
        'identity': identity,
        'name': name,
        'host': host,
        'media': media,
        'ws_path': f'/ws/m/conference/{conf.slug}/',
    }


@api_view(['POST'])
@permission_classes([AllowAny])
def conference_join(request, slug):
    """Credentials for the room: a signed-in member, or a guest with a pass from `guest/`."""
    conf = Conference.objects.select_related('owner').filter(slug=slug).first()
    if not conf or not conf.active:
        return _err('not_found', 404)
    user = request.user
    if user and user.is_authenticated:
        if not has_module(user, MODULE):
            return Response({'error': 'module_not_installed', 'module': MODULE}, status=403)
        if not user_can_join(user, conf):
            return _err('forbidden', 403)
        return Response(_join_payload(conf, f'user-{user.id}', user.nickname or user.username, is_host(user, conf)))
    guest = read_guest_pass(str(request.data.get('guest_pass', '')), conf) if _open_to_guests() else None
    if not guest:
        return _err('login_required', 401)
    return Response(_join_payload(conf, guest['guest_id'], guest['name'], False))


@api_view(['GET'])
@permission_classes([AllowAny])
def conference_public(request, slug):
    """What the link page may show before sign-in; nothing about private rooms."""
    conf = Conference.objects.select_related('owner').filter(slug=slug).first() if _open_to_guests() else None
    if not conf:
        return _err('not_found', 404)
    if conf.kind != KIND_EXTERNAL:
        return Response({'slug': conf.slug, 'kind': conf.kind, 'active': conf.active, 'login_required': True})
    return Response({
        'slug': conf.slug, 'kind': conf.kind, 'active': conf.active, 'login_required': False,
        'title': conf.title, 'owner': conf.owner.nickname or conf.owner.username,
        'starts_at': conf.starts_at.isoformat() if conf.starts_at else None, 'guest_lobby': conf.guest_lobby,
    })


class GuestThrottle(AnonRateThrottle):
    rate = '20/hour'
    scope = 'conference_guest'


@api_view(['POST'])
@permission_classes([AllowAny])
@throttle_classes([GuestThrottle])
def conference_guest(request, slug):
    """A guest pass for an external conference: anyone with the link, under a name they give."""
    conf = Conference.objects.filter(slug=slug).first() if _open_to_guests() else None
    if not conf or not conf.active or conf.kind != KIND_EXTERNAL:
        return _err('not_found', 404)
    name = clean_name(request.data.get('name'))
    if len(name) < 2:
        return _err('name_required')
    token, guest_id = issue_guest_pass(conf, name)
    return Response({'guest_pass': token, 'guest_id': guest_id, 'name': name})


@api_view(['GET', 'PUT'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def media_settings(request):
    """LiveKit server for large rooms; only the superuser sees or changes it."""
    if not request.user.is_superuser:
        return _err('forbidden', 403)
    s = MediaSettings.load()
    if request.method == 'PUT':
        s.livekit_url = str(request.data.get('livekit_url', '')).strip()[:300]
        s.livekit_api_key = str(request.data.get('livekit_api_key', '')).strip()[:200]
        secret = request.data.get('livekit_api_secret')
        if secret is not None and secret != '••••••':
            s.api_secret = str(secret).strip()
        s.save()
    cfg = media_config()
    return Response({
        'livekit_url': s.livekit_url,
        'livekit_api_key': s.livekit_api_key,
        'livekit_api_secret': '••••••' if s.encrypted_api_secret else '',
        'mode': 'livekit' if cfg else 'mesh',
        'from_env': bool(cfg) and cfg['url'] != s.livekit_url,
    })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def user_search(request):
    q = str(request.query_params.get('q', '')).strip()[:64]
    if not q:
        return Response([])
    users = (get_user_model().objects.filter(is_active=True)
             .filter(Q(username__icontains=q) | Q(nickname__icontains=q))
             .exclude(account_type='bot').exclude(id=request.user.id).order_by('username')[:20])
    return Response([_author_brief(u) for u in users])
