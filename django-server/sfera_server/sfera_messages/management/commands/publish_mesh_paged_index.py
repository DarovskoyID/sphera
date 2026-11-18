import json
import sqlite3
from pathlib import Path

from cryptography.fernet import InvalidToken
from django.core.management.base import BaseCommand, CommandError

from sfera_messages.mesh_paged_publication import PagedIndexPublication
from sfera_messages.mesh_worker import open_writer
from sfera_messages.mesh_index_disk import configured


class Command(BaseCommand):
    help = 'Advance one immutable paged history generation; commit every page before the v2 BFT head.'

    def add_arguments(self, parser):
        for name in ('config', 'document', 'previous', 'job', 'page-cache'):
            parser.add_argument('--' + name, required=True)
        parser.add_argument('--allow-migration', action='store_true', help='Explicit laboratory v1 migration; legacy readers and fanout do not support the migrated namespace.')

    def handle(self, *args, **options):
        def read(path, limit):
            with Path(path).open('rb') as source: raw = source.read(limit + 1)
            if len(raw) > limit: raise ValueError('paged_index_input_byte_limit')
            return json.loads(raw)
        try:
            configured(required=True)
            config = read(options['config'], 16384)
            document = read(options['document'], 32 * 1048576)
            previous = read(options['previous'], 32 * 1048576)
            if not isinstance(document, dict) or not isinstance(document.get('page_clusters'), list):
                raise ValueError('invalid_paged_index_input')
            from sfera_mesh.directory import digest64
            clusters = document['page_clusters']
            if not clusters or any(not digest64(cluster) for cluster in clusters): raise ValueError('invalid_paged_index_clusters')
            with open_writer(config, clusters=set(clusters)) as writer:
                job = PagedIndexPublication(options['job'], writer, document, previous_messages=previous,
                    cache_path=options['page_cache'], allow_migration=options.get('allow_migration', False))
                try: result = job.step()
                finally: job.close()
        except InvalidToken as exc:
            raise CommandError('paged_index_ciphertext_unreadable') from exc
        except (ValueError, OSError, KeyError, TypeError, sqlite3.Error) as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write(json.dumps(result, sort_keys=True))
