from django.apps import AppConfig


class SferaServersConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'sfera_servers'
    verbose_name = 'Servers'

    def ready(self):
        from . import receivers
        receivers.connect()
        from django.conf import settings
        from django.db.models.signals import post_delete
        from .models import GuildMessage, GuildAttachment

        def cancel_deleted(sender, instance, using, **kwargs):
            if getattr(settings, 'SFERA_MESH_MESSAGE_CLUSTER', ''):
                from sfera_messages.models import MessageMeshWrite, MessageMeshDelivery
                MessageMeshWrite.objects.using(using).filter(message_id=instance.pk, source='guild', state='pending').update(state='cancelled')
                MessageMeshDelivery.objects.using(using).filter(message_id=instance.pk, write__source='guild', state='pending').update(state='cancelled')
                from sfera_messages.mesh_revisions import capture_tombstone
                capture_tombstone(instance, using)

        def refresh_attachment(sender, instance, using, origin=None, **kwargs):
            if not getattr(settings, 'SFERA_MESH_MESSAGE_CLUSTER', '') or not instance.message_id:
                return
            if not isinstance(origin, GuildAttachment) and getattr(origin, 'model', None) is not GuildAttachment:
                return
            message = GuildMessage.objects.using(using).filter(pk=instance.message_id).first()
            if message is not None:
                message.save(using=using)

        post_delete.connect(cancel_deleted, sender=GuildMessage, dispatch_uid='servers_cancel_deleted_mesh', weak=False)
        post_delete.connect(refresh_attachment, sender=GuildAttachment, dispatch_uid='servers_refresh_mesh_attachment', weak=False)
