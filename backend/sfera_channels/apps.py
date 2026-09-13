from django.apps import AppConfig


class SferaChannelsConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'sfera_channels'
    verbose_name = 'Channels'

    def ready(self):
        from sfera_modules import hooks
        from . import receivers

        hooks.register(hooks.DATA_EXPORT, 'channels', receivers.export)
        hooks.register(hooks.METRICS, 'channels', receivers.metrics)
        hooks.register(hooks.HAS_DATA, 'channels', receivers.has_data)
        hooks.user_blocked.connect(receivers.on_user_blocked, dispatch_uid='sfera_channels.user_blocked')
