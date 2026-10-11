from django.apps import AppConfig


class SferaTotpConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'sfera_totp'
    verbose_name = 'Two-factor authentication'

    def ready(self):
        from sfera_modules import hooks
        from . import guard, receivers

        # The core asks these three on sign-in, on the second step, and on every
        # request of an account that is already signed in.
        hooks.register(hooks.LOGIN_GUARD, 'totp', guard.login_guard)
        hooks.register(hooks.SECOND_FACTOR, 'totp', guard.second_factor)
        hooks.register(hooks.ACCESS_GUARD, 'totp', guard.access_guard)
        hooks.register(hooks.METRICS, 'totp', receivers.metrics)
        hooks.register(hooks.DATA_EXPORT, 'totp', receivers.export)
        hooks.register(hooks.HAS_DATA, 'totp', receivers.has_data)
        hooks.register(hooks.ENCRYPTED_DATA, 'totp', receivers.encrypted_data)
        hooks.register(hooks.CAN_UNINSTALL, 'totp', receivers.can_uninstall)
