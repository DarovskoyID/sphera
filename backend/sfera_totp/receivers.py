def export(user):
    from .models import BackupCode, TotpDevice

    device = TotpDevice.objects.filter(user=user).first()
    return {
        'totp': [{
            'enabled': bool(device and device.confirmed),
            # The secret itself is never exported: it would be a second factor
            # sitting in a downloaded archive.
            'confirmed_at': device.confirmed_at.isoformat() if device and device.confirmed_at else None,
            'last_used_at': device.last_used_at.isoformat() if device and device.last_used_at else None,
            'backup_codes_left': BackupCode.objects.filter(user=user, used_at__isnull=True).count(),
        }] if device else [],
    }


def metrics():
    """How much of the server is behind a second factor."""
    from django.contrib.auth import get_user_model
    from sfera_modules.hooks import approx_count
    from sfera_server.metrics import _cval

    from .guard import settings_row
    from .models import BackupCode, TotpDevice

    people = get_user_model().objects.filter(is_active=True).exclude(account_type='bot').count()
    enabled = TotpDevice.objects.filter(confirmed_at__isnull=False).count()
    required = settings_row()['required_for_all']
    return {
        'tables': {'totp_devices': approx_count(TotpDevice), 'totp_backup_codes': approx_count(BackupCode)},
        'prometheus': [
            {'name': 'sfera_totp_required', 'type': 'gauge', 'value': 1 if required else 0,
             'help': '1 when two-factor is required of every account'},
            {'name': 'sfera_totp_users', 'type': 'gauge', 'value': people,
             'help': 'Active accounts, bots excluded'},
            {'name': 'sfera_totp_enabled', 'type': 'gauge', 'value': enabled,
             'help': 'Accounts with a confirmed authenticator'},
            {'name': 'sfera_totp_blocked', 'type': 'gauge', 'value': max(people - enabled, 0) if required else 0,
             'help': 'Accounts held on the set-up screen by the requirement'},
            {'name': 'sfera_totp_logins_total', 'type': 'counter', 'value': _cval('totp_logins'),
             'help': 'Sign-ins finished with a one-time code'},
            {'name': 'sfera_totp_backup_logins_total', 'type': 'counter', 'value': _cval('totp_backup_logins'),
             'help': 'Sign-ins finished with a backup code'},
            {'name': 'sfera_totp_failures_total', 'type': 'counter', 'value': _cval('totp_failures'),
             'help': 'Rejected codes'},
            {'name': 'sfera_totp_enabled_total', 'type': 'counter', 'value': _cval('totp_enabled'),
             'help': 'Authenticators connected'},
            {'name': 'sfera_totp_reset_by_admin_total', 'type': 'counter', 'value': _cval('totp_reset_by_admin'),
             'help': 'Authenticators cleared by the superuser'},
        ],
        'status': {'Двухфакторная аутентификация': {
            'Обязательна для всех': 'да' if required else 'нет',
            'Подключили': f'{enabled} из {people}',
        }},
    }


def has_data(user):
    from .models import TotpDevice

    return TotpDevice.objects.filter(user=user).exists()


def encrypted_data():
    from .models import TotpDevice

    return {'text': [TotpDevice]}


def can_uninstall(user):
    """Removing the module while it is mandatory would quietly drop two-factor
    for everyone, so the requirement has to be turned off first."""
    from .guard import settings_row

    if settings_row()['required_for_all']:
        return 'Сначала выключите обязательную двухфакторную аутентификацию в настройках модуля.'
    return None
