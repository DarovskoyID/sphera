from django.apps import AppConfig


class SferaAmocrmConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'sfera_amocrm'
    verbose_name = 'amoCRM integration'

    def ready(self):
        from sfera_modules import hooks
        from . import receivers

        hooks.register(hooks.METRICS, 'amocrm', receivers.metrics)
