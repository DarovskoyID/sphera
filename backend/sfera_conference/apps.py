from django.apps import AppConfig


class SferaConferenceConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'sfera_conference'
    verbose_name = 'Conferences'

    def ready(self):
        from sfera_modules import hooks
        from . import receivers

        hooks.register(hooks.DATA_EXPORT, 'conference', receivers.export)
        hooks.register(hooks.METRICS, 'conference', receivers.metrics)
        hooks.register(hooks.HAS_DATA, 'conference', receivers.has_data)
