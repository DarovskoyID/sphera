import json
import os
from pathlib import Path
import sqlite3
import subprocess

from django.core.management.base import BaseCommand, CommandError

from sfera_messages.mesh_inventory import inventory_page
from sfera_messages.mesh_read import read_config
from sfera_messages.mesh_reader import open_reader


class Command(BaseCommand):
    help = 'Export one verified recovery inventory page without reading or restoring application message rows.'

    def add_arguments(self, parser):
        parser.add_argument('--cluster', required=True)
        parser.add_argument('--output', required=True)
        parser.add_argument('--limit', type=int, default=16)
        parser.add_argument('--after', default='')
        parser.add_argument('--manifest', default=None)
        parser.add_argument('--allow-unavailable', action='store_true')

    def handle(self, *args, **options):
        path = Path(options['output'])
        if not path.is_absolute() or not path.parent.is_dir() or path.exists():
            raise CommandError('output must be a new absolute path in an existing operator-controlled directory')
        try:
            with open_reader(read_config(), clusters={options['cluster']}) as reader:
                result = inventory_page(reader, options['cluster'], after=options['after'],
                                        manifest=options['manifest'], limit=options['limit'],
                                        allow_unavailable=options['allow_unavailable'])
            # An exclusive open also closes the check/write race: never truncate
            # another export or an application database supplied as output.
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'w', encoding='utf-8') as destination:
                json.dump(result, destination, ensure_ascii=False, sort_keys=True)
                destination.flush()
                os.fsync(destination.fileno())
        except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError) as exc:
            raise CommandError('mesh inventory failed; no message rows were restored') from exc
        self.stdout.write(json.dumps({'scanned': result['scanned'],
            'revisions': len(result['revisions']), 'unclassified': result['unclassified'],
            'unavailable': len(result['unavailable']), 'all_blocks_available': result['all_blocks_available'],
            'next_after': result['next_after'], 'manifest': result['manifest'],
            'live_history_recovered': False}))
