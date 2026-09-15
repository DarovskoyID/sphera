from django.apps import AppConfig


class SferaOnecConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'sfera_onec'
    verbose_name = '1C integration'

    def ready(self):
        from sfera_modules import hooks
        from . import receivers

        hooks.register(hooks.METRICS, 'onec', receivers.metrics)
