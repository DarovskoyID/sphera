import logging

from django.apps import AppConfig

logger = logging.getLogger('sfera.modules')


class SferaTotpConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'sfera_totp'
    verbose_name = 'Two-factor authentication'

    def ready(self):
        from sfera_modules import hooks
        from . import guard, receivers

        # The core asks these three on sign-in, on the second step, and on every
        # request of an account that is already signed in. They arrived with
        # sdkVersion 2; a server still on an older core must not die here — it
        # keeps running without the second factor and says so in the log.
        for name, fn in (('LOGIN_GUARD', guard.login_guard),
                         ('SECOND_FACTOR', guard.second_factor),
                         ('ACCESS_GUARD', guard.access_guard)):
            registry = getattr(hooks, name, None)
            if registry is None:
                logger.error(
                    'sfera_totp: this core has no hooks.%s — two-factor is installed but NOT enforced. '
                    'Update the server to a core with sdkVersion 2.', name,
                )
                continue
            hooks.register(registry, 'totp', fn)

        hooks.register(hooks.METRICS, 'totp', receivers.metrics)
        hooks.register(hooks.DATA_EXPORT, 'totp', receivers.export)
        hooks.register(hooks.HAS_DATA, 'totp', receivers.has_data)
        hooks.register(hooks.ENCRYPTED_DATA, 'totp', receivers.encrypted_data)
        hooks.register(hooks.CAN_UNINSTALL, 'totp', receivers.can_uninstall)
