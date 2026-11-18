from django.apps import AppConfig


class SferaOfficeConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'sfera_office'
    verbose_name = 'Documents'

    def ready(self):
        from sfera_modules import hooks
        from . import receivers

        hooks.register(hooks.DATA_EXPORT, 'office', receivers.export)
        hooks.register(hooks.METRICS, 'office', receivers.metrics)
        hooks.register(hooks.HAS_DATA, 'office', receivers.has_data)
