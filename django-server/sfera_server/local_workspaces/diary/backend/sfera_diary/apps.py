from django.apps import AppConfig


class SferaDiaryConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'sfera_diary'
    verbose_name = 'Personal diaries'

    def ready(self):
        from sfera_modules import hooks
        from . import receivers

        hooks.register(hooks.DATA_EXPORT, 'diary', receivers.export)
        def encrypted_data():
            from .models import DiaryEntry, DiaryAttachment
            return {'text': [DiaryEntry], 'files': [DiaryAttachment]}

        hooks.register(hooks.ENCRYPTED_DATA, 'diary', encrypted_data)
        hooks.register(hooks.METRICS, 'diary', receivers.metrics)
        hooks.register(hooks.HAS_DATA, 'diary', receivers.has_data)
