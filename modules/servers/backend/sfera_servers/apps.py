from django.apps import AppConfig


class SferaServersConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'sfera_servers'
    verbose_name = 'Servers'

    def ready(self):
        from . import receivers
        receivers.connect()
