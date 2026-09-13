from django.apps import AppConfig


class SferaBotsConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'sfera_bots'

    def ready(self):
        from sfera_modules import hooks
        from . import receivers

        hooks.message_created.connect(receivers.on_message_created, dispatch_uid='sfera_bots.message_created')
        hooks.conversation_opened.connect(receivers.on_conversation_opened, dispatch_uid='sfera_bots.conversation_opened')
