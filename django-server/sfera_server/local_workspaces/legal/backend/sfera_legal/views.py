"""Legal evidence API (mounted at /api/legal/)."""
import json

from django.contrib.auth import get_user_model
from django.db.models import Q
from django.http import HttpResponse
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle

from sfera_messages.models import Conversation
from sfera_messages.services import _author_brief
from sfera_modules.hooks import push_to_user
from sfera_modules.permissions import installed_ids, requires_module
from sfera_server.metrics import inc as metrics_inc

from . import chain as chain_mod
from . import protocol, signing
from .models import ChainEntry, LegalSettings, Package, SignRequest, Signature

MODULE = 'legal'
PAGE = 50


def _err(code, status=400, **extra):
    return Response({'error': code, **extra}, status=status)


def _client(request):
    ip = (request.META.get('HTTP_X_FORWARDED_FOR', '').split(',')[0].strip()
          or request.META.get('REMOTE_ADDR', ''))[:64]
    return ip, request.META.get('HTTP_USER_AGENT', '')[:300]


def _parse_dt(value):
    if not value:
        return None
    dt = parse_datetime(str(value))
    if dt is None:
        raise ValueError
    return dt if timezone.is_aware(dt) else timezone.make_aware(dt)


def _conversation_for(user, scope):
    """The DM conversation behind a scope, if this user takes part in it."""
    if not str(scope).startswith('dm:'):
        return None
    conv_id = str(scope)[3:]
    try:
        return Conversation.objects.filter(id=conv_id, participants=user).first()
    except (ValueError, TypeError):
        return None


def _signature_data(s):
    return {
        'id': str(s.id),
        'name': s.signer_name,
        'email': s.signer_email,
        'method': s.method,
        'signed_at': s.signed_at.isoformat(),
        'signed_hash': s.signed_hash,
        'user_id': str(s.user_id) if s.user_id else None,
        'cert_subject': s.cert_subject,
        'cert_fingerprint': s.cert_fingerprint,
        'cert_valid_to': s.cert_valid_to.isoformat() if s.cert_valid_to else None,
        'note': s.note,
        'matches_protocol': s.signed_hash == s.package.content_hash,
    }


def _package_data(p, user=None, full=False):
    data = {
        'id': str(p.id),
        'code': p.code,
        'title': p.title,
        'scope': p.scope,
        'scope_title': p.scope_title,
        'status': p.status,
        'message_count': p.message_count,
        'participants': p.participants,
        'content_hash': p.content_hash,
        'chain_ok': p.chain_ok,
        'chain_note': p.chain_note,
        'has_timestamp': bool(p.tsa_at),
        'timestamp_at': p.tsa_at.isoformat() if p.tsa_at else None,
        'period_from': p.period_from.isoformat() if p.period_from else None,
        'period_to': p.period_to.isoformat() if p.period_to else None,
        'created_at': p.created_at.isoformat(),
        'sealed_at': p.sealed_at.isoformat() if p.sealed_at else None,
        'owner': _author_brief(p.owner),
        'is_owner': bool(user and p.owner_id == user.id),
        'signatures': [_signature_data(s) for s in p.signatures.all()],
    }
    if full:
        data['requests'] = [
            {'id': str(r.id), 'email': r.email, 'user': _author_brief(r.user) if r.user else None,
             'signed_at': r.signed_at.isoformat() if r.signed_at else None}
            for r in p.requests.select_related('user')
        ]
    return data


def _visible(user):
    """Protocols of this user's own conversations, plus any they were asked to sign."""
    scopes = [f'dm:{cid}' for cid in Conversation.objects.filter(participants=user).values_list('id', flat=True)[:500]]
    return (Package.objects
            .filter(Q(owner=user) | Q(requests__user=user) | Q(signatures__user=user) | Q(scope__in=scopes))
            .distinct().select_related('owner').prefetch_related('signatures'))


def _verify_url(request, code):
    base = f"{'https' if request.is_secure() else 'http'}://{request.get_host()}"
    return f'{base}/?verify={code}'


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def status_view(request):
    s = LegalSettings.load()
    return Response({
        'recording': s.record_chain,
        'can_manage': request.user.is_superuser,
        'org_name': s.org_name,
        'timestamps': bool(s.tsa_url),
    })


@api_view(['GET', 'PUT'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def settings_view(request):
    if not request.user.is_superuser:
        return _err('forbidden', 403)
    s = LegalSettings.load()
    if request.method == 'PUT':
        d = request.data
        if 'record_chain' in d:
            s.record_chain = bool(d['record_chain'])
        for field in ('org_name', 'org_details', 'tsa_url'):
            if field in d:
                setattr(s, field, str(d[field]).strip()[:300])
        if s.tsa_url and not s.tsa_url.startswith(('http://', 'https://')):
            return _err('bad_tsa_url')
        s.save()
        chain_mod.forget_settings()
    return Response({
        'record_chain': s.record_chain, 'org_name': s.org_name, 'org_details': s.org_details,
        'tsa_url': s.tsa_url, 'chain_links': ChainEntry.objects.count(),
    })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def conversations(request):
    """DMs this user can make a protocol of, newest first."""
    rows = (Conversation.objects.filter(participants=request.user)
            .prefetch_related('participants')[:200])
    out = []
    for c in rows:
        others = [u for u in c.participants.all() if u.id != request.user.id]
        out.append({
            'scope': f'dm:{c.id}',
            'title': ', '.join((u.nickname or u.username) for u in others) or 'Избранное',
            'participants': [_author_brief(u) for u in c.participants.all()],
        })
    return Response(out)


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def package_list_create(request):
    if request.method == 'GET':
        try:
            offset = max(0, int(request.query_params.get('offset', 0)))
        except ValueError:
            offset = 0
        rows = _visible(request.user).order_by('-created_at')[offset:offset + PAGE]
        return Response([_package_data(p, request.user) for p in rows])

    scope = str(request.data.get('scope', ''))[:80]
    conv = _conversation_for(request.user, scope)
    if not conv:
        return _err('not_found', 404)
    try:
        period_from = _parse_dt(request.data.get('period_from'))
        period_to = _parse_dt(request.data.get('period_to'))
    except ValueError:
        return _err('bad_datetime')
    others = [u for u in conv.participants.all() if u.id != request.user.id]
    default_title = f"Переписка с {', '.join((u.nickname or u.username) for u in others) or 'собой'}"
    title = str(request.data.get('title', '')).strip()[:200] or default_title
    p = Package.objects.create(
        owner=request.user, title=title, scope=scope, scope_title=default_title,
        period_from=period_from, period_to=period_to, code=Package.new_code(),
        participants=[_author_brief(u) for u in conv.participants.all()],
    )
    return Response(_package_data(p, request.user, full=True), status=201)


def _can_see(user, p):
    return (p.owner_id == user.id
            or p.requests.filter(user=user).exists()
            or p.signatures.filter(user=user).exists()
            or str(p.scope).startswith('dm:') and _conversation_for(user, p.scope) is not None)


@api_view(['GET', 'DELETE'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def package_detail(request, package_id):
    p = Package.objects.filter(id=package_id).select_related('owner').prefetch_related('signatures').first()
    if not p or not _can_see(request.user, p):
        return _err('not_found', 404)
    if request.method == 'DELETE':
        if p.owner_id != request.user.id:
            return _err('forbidden', 403)
        if p.status == Package.STATUS_SEALED and p.signatures.exists():
            return _err('signed_protocol_stays', 409)
        p.delete()
        return Response(status=204)
    return Response(_package_data(p, request.user, full=True))


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def package_seal(request, package_id):
    """Freeze the protocol: snapshot, hash, chain check, optional time stamp."""
    p = Package.objects.filter(id=package_id, owner=request.user).first()
    if not p:
        return _err('not_found', 404)
    if p.status == Package.STATUS_SEALED:
        return _err('already_sealed', 409)
    conv = _conversation_for(request.user, p.scope)
    if not conv:
        return _err('not_found', 404)
    s = LegalSettings.load()
    chain_mod.flush_pending()
    try:
        snapshot = protocol.build_snapshot(
            scope=p.scope, conversation=conv, period_from=p.period_from, period_to=p.period_to,
            title=p.title, author=request.user,
            org={'name': s.org_name, 'details': s.org_details} if s.org_name else {},
        )
    except protocol.ProtocolError as e:
        return _err(str(e), 413)
    p.message_count = snapshot['message_count']
    p.participants = snapshot['participants']
    p.chain_ok = snapshot['chain']['ok']
    p.chain_note = snapshot['chain']['note'][:300]
    p.content_hash = protocol.snapshot_hash(snapshot)
    p.write_snapshot(protocol.snapshot_bytes(snapshot))
    p.status = Package.STATUS_SEALED
    p.sealed_at = timezone.now()
    if s.tsa_url:
        reply = protocol.fetch_timestamp(s.tsa_url, p.content_hash)
        if reply:
            p.tsa_reply = reply
            p.tsa_at = timezone.now()
    p.save()
    metrics_inc('legal_packages_sealed')
    return Response(_package_data(p, request.user, full=True))


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def package_download(request, package_id, fmt):
    p = Package.objects.filter(id=package_id).prefetch_related('signatures').first()
    if not p or not _can_see(request.user, p) or p.status != Package.STATUS_SEALED:
        return _err('not_found', 404)
    raw = p.read_snapshot()
    if fmt == 'json':
        return HttpResponse(raw, content_type='application/json; charset=utf-8', headers={
            'Content-Disposition': f'attachment; filename="protocol-{p.code}.json"'})
    if fmt == 'tsr':
        if not p.tsa_reply:
            return _err('no_timestamp', 404)
        return HttpResponse(bytes(p.tsa_reply), content_type='application/timestamp-reply', headers={
            'Content-Disposition': f'attachment; filename="protocol-{p.code}.tsr"'})
    snapshot = json.loads(raw.decode('utf-8'))
    html_body = protocol.render_html(p, snapshot, _verify_url(request, p.code))
    return HttpResponse(html_body, content_type='text/html; charset=utf-8')


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def sign_request(request, package_id):
    """Ask a party to sign: a user of this server or an outside email."""
    p = Package.objects.filter(id=package_id, owner=request.user).first()
    if not p:
        return _err('not_found', 404)
    if p.status != Package.STATUS_SEALED:
        return _err('seal_first', 409)
    user_id = request.data.get('user_id')
    email = str(request.data.get('email', '')).strip()[:200]
    user = get_user_model().objects.filter(id=user_id, is_active=True).first() if user_id else None
    if not user and '@' not in email:
        return _err('user_or_email_required')
    req, _ = SignRequest.objects.get_or_create(
        package=p, user=user, email='' if user else email,
        defaults={'token': SignRequest._meta.get_field('token').get_default()},
    )
    if user:
        try:
            push_to_user(user.id, 'legal.sign_request', {
                'package_id': str(p.id), 'code': p.code, 'title': p.title,
                'from': request.user.nickname or request.user.username,
            })
        except Exception:
            pass
    else:
        try:
            signing.send_code(p, email, _verify_url(request, p.code))
        except Exception as e:
            return _err('mail_failed', 502, detail=str(e)[:200])
    return Response({'ok': True, 'id': str(req.id)}, status=201)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def sign_code_request(request, package_id):
    """Send the signer a code by email (simple electronic signature)."""
    p = Package.objects.filter(id=package_id).first()
    if not p or not _can_see(request.user, p):
        return _err('not_found', 404)
    if p.status != Package.STATUS_SEALED:
        return _err('seal_first', 409)
    email = (request.user.email or '').strip()
    if '@' not in email:
        return _err('no_email', 409)
    try:
        signing.send_code(p, email, _verify_url(request, p.code))
    except Exception as e:
        return _err('mail_failed', 502, detail=str(e)[:200])
    return Response({'ok': True, 'email': email})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def sign(request, package_id):
    """Sign with the emailed code, or by uploading a detached signature file."""
    p = Package.objects.filter(id=package_id).prefetch_related('signatures').first()
    if not p or not _can_see(request.user, p):
        return _err('not_found', 404)
    if p.status != Package.STATUS_SEALED:
        return _err('seal_first', 409)
    if p.signatures.filter(user=request.user).exists():
        return _err('already_signed', 409)
    ip, agent = _client(request)
    name = request.user.nickname or request.user.username
    upload = request.FILES.get('signature')
    if upload:
        data = upload.read(signing.MAX_SIGNATURE_BYTES + 1)
        if len(data) > signing.MAX_SIGNATURE_BYTES:
            return _err('file_too_big', 413)
        info = signing.inspect_signature(data)
        s = Signature(
            package=p, user=request.user, signer_name=name, signer_email=request.user.email or '',
            method=Signature.METHOD_FILE, signed_hash=p.content_hash, ip=ip, user_agent=agent,
            cert_subject=info['subject'], cert_serial=info['serial'], cert_fingerprint=info['cert_fingerprint'] or info['fingerprint'],
            cert_valid_to=info['valid_to'], note=info['note'],
        )
        from django.core.files.base import ContentFile
        from sfera_messages.encryption import encrypt_bytes

        s.file.save(f'{p.code}-{request.user.id}.sig.enc', ContentFile(encrypt_bytes(data)), save=False)
        s.save()
    else:
        email = (request.user.email or '').strip()
        ok, reason = signing.check_code(p, email, request.data.get('code'))
        if not ok:
            return _err(reason, 400)
        s = Signature.objects.create(
            package=p, user=request.user, signer_name=name, signer_email=email,
            method=Signature.METHOD_CODE, signed_hash=p.content_hash, ip=ip, user_agent=agent,
            note='Простая электронная подпись: код подтверждён по адресу электронной почты.',
        )
    SignRequest.objects.filter(package=p, user=request.user, signed_at__isnull=True).update(signed_at=timezone.now())
    metrics_inc('legal_signatures')
    try:
        push_to_user(p.owner_id, 'legal.signed', {'package_id': str(p.id), 'code': p.code, 'by': name})
    except Exception:
        pass
    return Response(_signature_data(s), status=201)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def chain_status(request):
    """How the chain of one conversation looks right now."""
    scope = str(request.query_params.get('scope', ''))[:80]
    if not _conversation_for(request.user, scope):
        return _err('not_found', 404)
    rows = list(ChainEntry.objects.filter(scope=scope).order_by('seq'))
    ok, note = chain_mod.verify(scope, rows or None)
    return Response({
        'scope': scope, 'ok': ok, 'note': note, 'links': len(rows),
        'first_at': rows[0].sent_at.isoformat() if rows else None,
        'last_at': rows[-1].sent_at.isoformat() if rows else None,
        'recording': LegalSettings.load().record_chain,
    })


class VerifyThrottle(AnonRateThrottle):
    rate = '60/hour'
    scope = 'legal_verify'


@api_view(['GET'])
@permission_classes([AllowAny])
@throttle_classes([VerifyThrottle])
def public_verify(request, code):
    """What anyone with the code can check: hashes, dates and signatures — no content."""
    if MODULE not in installed_ids():
        return _err('not_found', 404)
    p = (Package.objects.filter(code=str(code).upper().strip(), status=Package.STATUS_SEALED)
         .select_related('owner').prefetch_related('signatures').first())
    if not p:
        return _err('not_found', 404)
    given = str(request.query_params.get('hash', '')).strip().lower()
    return Response({
        'code': p.code,
        'title': p.title,
        'sealed_at': p.sealed_at.isoformat() if p.sealed_at else None,
        'content_hash': p.content_hash,
        'message_count': p.message_count,
        'period_from': p.period_from.isoformat() if p.period_from else None,
        'period_to': p.period_to.isoformat() if p.period_to else None,
        'chain_ok': p.chain_ok,
        'chain_note': p.chain_note,
        'has_timestamp': bool(p.tsa_at),
        'timestamp_at': p.tsa_at.isoformat() if p.tsa_at else None,
        'participants': [{'name': x.get('name', ''), 'username': x.get('username', '')} for x in p.participants],
        'signatures': [{
            'name': s.signer_name, 'signed_at': s.signed_at.isoformat(), 'method': s.method,
            'matches_protocol': s.signed_hash == p.content_hash,
            'cert_subject': s.cert_subject, 'note': s.note,
        } for s in p.signatures.all()],
        'hash_matches': (given == p.content_hash) if given else None,
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
             .exclude(account_type='bot').exclude(id=request.user.id)[:20])
    return Response([_author_brief(u) for u in users])
