from django.apps import AppConfig


class SferaMessagesConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'sfera_messages'

    def ready(self):
        # SQLite под нагрузкой: включаем WAL и щадящий fsync. Без WAL единственный
        # писатель делает fsync на КАЖДУЮ вставку, и kafka_worker не успевает за
        # потоком сообщений — копит backlog и держит CPU на 100% уже ПОСЛЕ нагрузки,
        # а конкуренция за блокировку БД подвешивает Daphne. WAL + synchronous=NORMAL
        # дают кратный прирост записи и параллельное чтение во время записи.
        from django.db.backends.signals import connection_created
        from django.conf import settings

        def _sqlite_pragmas(sender, connection, **kwargs):
            if connection.vendor != 'sqlite':
                return
            try:
                with connection.cursor() as c:
                    # busy_timeout ПЕРВЫМ: переключение в WAL должно ДОЖДАТЬСЯ
                    # снятия блокировки другим писателем, а не падать с
                    # "database is locked".
                    c.execute('PRAGMA busy_timeout=10000;')
                    c.execute('PRAGMA journal_mode=WAL;')
                    c.execute('PRAGMA synchronous=FULL;' if getattr(settings, 'SFERA_MESH_MESSAGE_CLUSTER', '') else 'PRAGMA synchronous=NORMAL;')
                    c.execute('PRAGMA temp_store=MEMORY;')
                    c.execute('PRAGMA cache_size=-16000;')  # ~16 МБ страничного кэша
            except Exception:
                # Транзиентная блокировка при старте не должна валить приложение:
                # WAL персистентен — выставится при следующем соединении.
                pass

        connection_created.connect(_sqlite_pragmas, dispatch_uid='sfera_sqlite_pragmas', weak=False)

        from django.db.models.signals import post_delete
        from .models import Message, MessageMeshWrite, MessageMeshDelivery, Attachment

        def _cancel_deleted_body(sender, instance, using, **kwargs):
            # The deletion and cancellation share the collector's transaction.
            if getattr(settings, 'SFERA_MESH_MESSAGE_CLUSTER', ''):
                MessageMeshWrite.objects.using(using).filter(message_id=instance.pk, source='dm', state='pending').update(state='cancelled')
                MessageMeshDelivery.objects.using(using).filter(message_id=instance.pk, write__source='dm', state='pending').update(state='cancelled')
                from .mesh_revisions import capture_tombstone
                capture_tombstone(instance, using)

        post_delete.connect(_cancel_deleted_body, sender=Message, dispatch_uid='sfera_cancel_deleted_mesh_body', weak=False)

        def _refresh_deleted_attachment(sender, instance, using, origin=None, **kwargs):
            if not getattr(settings, 'SFERA_MESH_MESSAGE_CLUSTER', '') or not instance.message_id:
                return
            # A parent cascade deletes its messages too; it needs cancellation,
            # not new attachment revisions during the cascade.
            if not isinstance(origin, Attachment) and getattr(origin, 'model', None) is not Attachment:
                return
            message = Message.objects.using(using).filter(pk=instance.message_id).first()
            if message is not None:
                message.save(using=using)

        post_delete.connect(_refresh_deleted_attachment, sender=Attachment, dispatch_uid='sfera_refresh_deleted_mesh_attachment', weak=False)
