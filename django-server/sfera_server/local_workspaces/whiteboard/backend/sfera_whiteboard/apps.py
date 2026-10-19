from django.apps import AppConfig


class SferaWhiteboardConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'sfera_whiteboard'
    verbose_name = 'Whiteboards'

    def ready(self):
        from sfera_modules import hooks
        from . import receivers

        hooks.register(hooks.DATA_EXPORT, 'whiteboard', receivers.export)
        hooks.register(hooks.METRICS, 'whiteboard', receivers.metrics)
        hooks.register(hooks.HAS_DATA, 'whiteboard', receivers.has_data)
