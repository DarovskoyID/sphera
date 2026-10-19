from django.apps import AppConfig


class SferaLegalConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'sfera_legal'
    verbose_name = 'Legal evidence'

    def ready(self):
        from sfera_modules import hooks
        from . import chain, receivers

        hooks.register(hooks.DATA_EXPORT, 'legal', receivers.export)
        hooks.register(hooks.METRICS, 'legal', receivers.metrics)
        hooks.register(hooks.HAS_DATA, 'legal', receivers.has_data)
        hooks.register(hooks.ENCRYPTED_DATA, 'legal', receivers.encrypted_data)
        # Every message gets a place in the hash chain, off the request thread.
        hooks.message_created.connect(chain.on_message_created, dispatch_uid='sfera_legal_chain')
