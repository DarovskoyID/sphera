import json
import sqlite3
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from sfera_messages.mesh_index_publication import IndexPublication
from sfera_messages.mesh_worker import open_writer
from sfera_messages.mesh_index_disk import configured


class Command(BaseCommand):
    help = 'Advance one explicit complete typed history index through storage and BFT confirmation.'

    def add_arguments(self, parser):
        parser.add_argument('--config', required=True)
        parser.add_argument('--document', required=True)
        parser.add_argument('--job', required=True)

    def handle(self, *args, **options):
        def read(path, limit):
            with Path(path).open('rb') as source:
                raw = source.read(limit + 1)
            if len(raw) > limit:
                raise ValueError('message_mesh_index_input_byte_limit')
            return json.loads(raw)
        try:
            configured(required=True)
            config = read(options['config'], 16384)
            document = read(options['document'], 97000)
            with open_writer(config, clusters={document['cluster']}) as writer:
                job = IndexPublication(options['job'], writer, document)
                try:
                    result = job.step()
                finally:
                    job.close()
        except (ValueError, OSError, KeyError, sqlite3.Error) as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write(json.dumps(result, sort_keys=True))
