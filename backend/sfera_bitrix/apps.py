from django.apps import AppConfig


class SferaBitrixConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'sfera_bitrix'
    verbose_name = 'Bitrix24 integration'

    def ready(self):
        from sfera_modules import hooks
        from . import receivers

        hooks.register(hooks.METRICS, 'bitrix', receivers.metrics)
