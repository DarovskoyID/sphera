from django.apps import AppConfig


class SferaDiaryConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'sfera_diary'
    verbose_name = 'Personal diaries'

    def ready(self):
        from sfera_modules import hooks
        from . import receivers

        hooks.register(hooks.DATA_EXPORT, 'diary', receivers.export)
        hooks.register(hooks.METRICS, 'diary', receivers.metrics)
        hooks.register(hooks.HAS_DATA, 'diary', receivers.has_data)
