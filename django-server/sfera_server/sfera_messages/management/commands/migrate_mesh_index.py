"""One explicit immutable v1-to-v2 migration step, with a safe preview."""
import json
from pathlib import Path
import sqlite3
import subprocess

from cryptography.fernet import InvalidToken
from django.core.management.base import BaseCommand, CommandError

from sfera_messages.mesh_index_migration import IndexMigration
from sfera_messages.mesh_paged_worker import page_clusters
from sfera_messages.mesh_worker import open_writer
from sfera_messages.mesh_index_disk import configured


class Command(BaseCommand):
    help = 'Prepare or advance migration of exactly one pinned v1 root; preserve ACL, all UUIDs and terminal deletions.'

    def add_arguments(self, parser):
        for name in ('config', 'scope', 'expected-root', 'job', 'page-cache'):
            parser.add_argument('--' + name, required=True)
        parser.add_argument('--source', choices=('dm', 'guild'), required=True)
        parser.add_argument('--prepare-only', action='store_true', help='Validate and persist the plan without uploading pages or broadcasting a head.')

    def handle(self, *args, **options):
        migration = None
        try:
            configured(required=True)
            with Path(options['config']).open('rb') as source: raw = source.read(16385)
            if len(raw) > 16384: raise ValueError('message_mesh_configuration_limit')
            config = json.loads(raw)
            clusters = page_clusters()
            with open_writer(config, clusters=set(clusters)) as writer:
                migration = IndexMigration(options['job'], writer, options['source'], options['scope'],
                    options['expected_root'], clusters, cache_path=options['page_cache'])
                try: result = migration.step(prepare_only=options.get('prepare_only', False))
                finally: migration.close(); migration = None
        except InvalidToken as exc:
            raise CommandError('index_migration_ciphertext_unreadable') from exc
        except (ValueError, OSError, KeyError, TypeError, sqlite3.Error, subprocess.SubprocessError) as exc:
            raise CommandError(str(exc)) from exc
        finally:
            if migration is not None: migration.close()
        self.stdout.write(json.dumps(result, sort_keys=True))
