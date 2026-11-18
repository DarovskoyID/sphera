from django.apps import AppConfig


class SferaPlannerConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'sfera_planner'
    verbose_name = 'Task planner'

    def ready(self):
        from sfera_modules import hooks
        from . import receivers

        hooks.register(hooks.DATA_EXPORT, 'planner', receivers.export)
        hooks.register(hooks.METRICS, 'planner', receivers.metrics)
        hooks.register(hooks.HAS_DATA, 'planner', receivers.has_data)
