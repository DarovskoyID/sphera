"""Upgrade the earlier, core-only entry schema without faking migrations.

Older entries did not install workspace apps. Their retrospective run_before
edges cannot be satisfied once the core state move is recorded. Only empty
legacy guild tables permit that ordering constraint to be relaxed.
"""
import sqlite3
import time


def main():
    import django
    django.setup()
    from django.conf import settings
    from django.db import connection
    from django.db.migrations.loader import MigrationLoader
    from django.core.management import call_command
    loader = MigrationLoader(connection, load=False)
    loader.load_disk()
    from django.db.migrations.recorder import MigrationRecorder
    applied = MigrationRecorder(connection).applied_migrations()
    target = ('sfera_messages', '0023_move_guilds_to_servers_module')
    deferred = [migration for key, migration in loader.disk_migrations.items()
                if key not in applied and target in migration.run_before]
    if target in applied and deferred:
        with connection.cursor() as cursor:
            tables = connection.introspection.table_names(cursor)
            for table in tables:
                if table.startswith(('sfera_messages_guild', 'sfera_servers_guild')):
                    cursor.execute('SELECT 1 FROM ' + connection.ops.quote_name(table) + ' LIMIT 1')
                    if cursor.fetchone():
                        raise RuntimeError('Legacy guild data requires a dedicated workspace migration; database unchanged.')
        # A consistent SQLite backup includes committed WAL contents. It stays
        # private beside the original database and is never a release artifact.
        path = str(settings.DATABASES['default']['NAME'])
        backup = path + '.before-workspaces-' + str(time.time_ns()) + '.sqlite'
        with sqlite3.connect(backup) as destination:
            connection.connection.backup(destination)
        for migration in deferred:
            # MigrationLoader constructs fresh instances of these classes.
            type(migration).run_before = [edge for edge in migration.run_before if edge != target]
        print('Empty legacy workspace ordering reconciled; private database backup created.', flush=True)
    call_command('migrate', interactive=False, verbosity=0)


if __name__ == '__main__':
    main()
