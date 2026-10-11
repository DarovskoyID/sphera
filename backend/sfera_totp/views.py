"""Two-factor API (mounted at /api/totp/).

These endpoints stay reachable while the gate holds an account (guard.ALLOW):
they are how someone who has just been locked out sets the authenticator up.
"""
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Q
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from sfera_messages.services import _author_brief
from sfera_modules.permissions import requires_module
from sfera_server.metrics import inc as metrics_inc

from . import guard, totp
from .models import BackupCode, TotpDevice, TotpSettings

MODULE = 'totp'


def _err(code, status=400, **extra):
    return Response({'error': code, **extra}, status=status)


def _status_data(user):
    device = TotpDevice.objects.filter(user=user).first()
    row = guard.settings_row()
    return {
        'enabled': bool(device and device.confirmed),
        'pending': bool(device and not device.confirmed),
        'required_for_all': row['required_for_all'],
        'must_enable': row['required_for_all'] and not (device and device.confirmed),
        'backup_codes_left': BackupCode.objects.filter(user=user, used_at__isnull=True).count(),
        'can_manage': bool(user.is_superuser),
        'issuer': row['issuer'],
        'confirmed_at': device.confirmed_at.isoformat() if device and device.confirmed_at else None,
        'last_used_at': device.last_used_at.isoformat() if device and device.last_used_at else None,
    }


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def status(request):
    return Response(_status_data(request.user))


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def setup(request):
    """Hand out a fresh secret and the otpauth link behind the QR code.

    An already confirmed authenticator is not replaced silently: switching to a
    new phone goes through disable/ first, with a code.
    """
    device = TotpDevice.objects.filter(user=request.user).first()
    if device and device.confirmed:
        return _err('already_enabled', 409)
    secret = totp.new_secret()
    if device:
        device.secret = secret
        device.save(update_fields=['encrypted_content'])
    else:
        device = TotpDevice(user=request.user)
        device.secret = secret
        device.save()
    issuer = guard.settings_row()['issuer']
    return Response({
        'secret': secret,
        'uri': totp.provisioning_uri(secret, request.user.username, issuer),
        'digits': totp.DIGITS,
        'period': totp.PERIOD,
        'issuer': issuer,
    })


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def confirm(request):
    """The first correct code proves the app is set up; backup codes follow."""
    device = TotpDevice.objects.filter(user=request.user).first()
    if not device:
        return _err('no_setup', 409)
    if device.confirmed:
        return _err('already_enabled', 409)
    if not guard.spend_attempt(request.user.id):
        return _err('too_many_attempts', 429)
    if not guard.check_code(device, str(request.data.get('code', ''))):
        return _err('bad_code')

    from django.utils import timezone

    codes = totp.new_backup_codes()
    with transaction.atomic():
        device.confirmed_at = timezone.now()
        device.save(update_fields=['confirmed_at'])
        BackupCode.objects.filter(user=request.user).delete()
        BackupCode.objects.bulk_create(
            [BackupCode(user=request.user, code_hash=totp.hash_backup(c)) for c in codes]
        )
    guard.forget_user(request.user.id)
    metrics_inc('totp_enabled')
    # Shown once: they are stored hashed and cannot be printed again.
    return Response({**_status_data(request.user), 'backup_codes': codes}, status=201)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def disable(request):
    """Switching phones or stepping back — with a current code, never without."""
    device = TotpDevice.objects.filter(user=request.user).first()
    if not device or not device.confirmed:
        return _err('not_enabled', 409)
    if not guard.spend_attempt(request.user.id):
        return _err('too_many_attempts', 429)
    code = str(request.data.get('code', ''))
    if not (guard.check_code(device, code) or guard.spend_backup_code(request.user.id, code)):
        return _err('bad_code')
    with transaction.atomic():
        device.delete()
        BackupCode.objects.filter(user=request.user).delete()
    guard.forget_user(request.user.id)
    metrics_inc('totp_disabled')
    # When the superuser requires two-factor, the account is now behind the gate
    # and the client will ask it to set an authenticator up again.
    return Response(_status_data(request.user))


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def backup_codes(request):
    """A new set, with a current code. The old set stops working at once."""
    device = TotpDevice.objects.filter(user=request.user).first()
    if not device or not device.confirmed:
        return _err('not_enabled', 409)
    if not guard.spend_attempt(request.user.id):
        return _err('too_many_attempts', 429)
    if not guard.check_code(device, str(request.data.get('code', ''))):
        return _err('bad_code')
    codes = totp.new_backup_codes()
    with transaction.atomic():
        BackupCode.objects.filter(user=request.user).delete()
        BackupCode.objects.bulk_create(
            [BackupCode(user=request.user, code_hash=totp.hash_backup(c)) for c in codes]
        )
    return Response({'backup_codes': codes}, status=201)


@api_view(['GET', 'PUT'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def settings_view(request):
    """The server-wide switch. Only the superuser, who manages modules."""
    if not request.user.is_superuser:
        return _err('forbidden', 403)
    row = TotpSettings.load()
    if request.method == 'PUT':
        if 'required_for_all' in request.data:
            row.required_for_all = bool(request.data.get('required_for_all'))
        issuer = str(request.data.get('issuer', '')).strip()[:60]
        if issuer:
            row.issuer = issuer
        row.save()
        guard.forget_settings()
        metrics_inc('totp_requirement_changed')
    users = get_user_model().objects.filter(is_active=True).exclude(account_type='bot')
    with_device = TotpDevice.objects.filter(confirmed_at__isnull=False).count()
    return Response({
        'required_for_all': row.required_for_all,
        'issuer': row.issuer,
        'users_total': users.count(),
        'users_with_totp': with_device,
    })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def people(request):
    """Who has an authenticator and who does not — for the superuser's page."""
    if not request.user.is_superuser:
        return _err('forbidden', 403)
    q = str(request.query_params.get('q', '')).strip()[:64]
    rows = get_user_model().objects.filter(is_active=True).exclude(account_type='bot')
    if q:
        rows = rows.filter(Q(username__icontains=q) | Q(nickname__icontains=q))
    rows = rows.order_by('username')[:100]
    enabled = set(
        TotpDevice.objects.filter(user__in=rows, confirmed_at__isnull=False).values_list('user_id', flat=True)
    )
    return Response([{**_author_brief(u), 'totp': u.id in enabled, 'is_superuser': u.is_superuser} for u in rows])


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def reset_user(request, user_id):
    """Lost phone, no backup codes left: the superuser clears the authenticator.

    The account can sign in with its password again, and — while two-factor is
    required — lands straight on the set-up screen.
    """
    if not request.user.is_superuser:
        return _err('forbidden', 403)
    target = get_user_model().objects.filter(id=user_id).first()
    if not target:
        return _err('not_found', 404)
    with transaction.atomic():
        TotpDevice.objects.filter(user=target).delete()
        BackupCode.objects.filter(user=target).delete()
    guard.forget_user(target.id)
    metrics_inc('totp_reset_by_admin')
    return Response({'ok': True, 'user': _author_brief(target)})
