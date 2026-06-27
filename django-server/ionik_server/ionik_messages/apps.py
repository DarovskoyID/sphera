from django.apps import AppConfig


class IonikMessagesConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'ionik_messages'

    def ready(self):
        # SQLite под нагрузкой: включаем WAL и щадящий fsync. Без WAL единственный
        # писатель делает fsync на КАЖДУЮ вставку, и kafka_worker не успевает за
        # потоком сообщений — копит backlog и держит CPU на 100% уже ПОСЛЕ нагрузки,
        # а конкуренция за блокировку БД подвешивает Daphne. WAL + synchronous=NORMAL
        # дают кратный прирост записи и параллельное чтение во время записи.
        from django.db.backends.signals import connection_created

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
                    c.execute('PRAGMA synchronous=NORMAL;')
                    c.execute('PRAGMA temp_store=MEMORY;')
                    c.execute('PRAGMA cache_size=-16000;')  # ~16 МБ страничного кэша
            except Exception:
                # Транзиентная блокировка при старте не должна валить приложение:
                # WAL персистентен — выставится при следующем соединении.
                pass

        connection_created.connect(_sqlite_pragmas, dispatch_uid='ionik_sqlite_pragmas')
