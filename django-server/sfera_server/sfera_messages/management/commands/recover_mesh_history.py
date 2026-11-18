import json
import os
from pathlib import Path
import sqlite3
import subprocess
from cryptography.fernet import InvalidToken

from django.core.management.base import BaseCommand, CommandError

from sfera_messages.mesh_read import read_config
from sfera_messages.mesh_reader import open_reader
from sfera_messages.mesh_recovery_index import read_index_messages


class Command(BaseCommand):
    help = 'Export one typed history page as an operator, without source rows or account restoration.'

    def add_arguments(self, parser):
        parser.add_argument('--publisher', required=True)
        parser.add_argument('--source', choices=('dm', 'guild'), required=True)
        parser.add_argument('--scope', required=True)
        parser.add_argument('--user', required=True)
        parser.add_argument('--output', required=True)
        parser.add_argument('--limit', type=int, default=32)
        parser.add_argument('--before', default=None)
        parser.add_argument('--root', default=None)

    def handle(self, *args, **options):
        path = Path(options['output'])
        if not path.is_absolute() or not path.parent.is_dir() or path.exists():
            raise CommandError('output must be a new absolute path in an operator-controlled directory')
        try:
            with open_reader(read_config()) as reader:
                result = read_index_messages(reader, options['publisher'], options['source'], options['scope'],
                    options['user'], limit=options['limit'], before=options['before'], expected_root=options['root'])
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'w', encoding='utf-8') as destination:
                json.dump(result, destination, ensure_ascii=False, sort_keys=True)
                destination.flush()
                os.fsync(destination.fileno())
        except (ValueError, PermissionError, OSError, InvalidToken, sqlite3.Error, subprocess.SubprocessError) as exc:
            raise CommandError('mesh history recovery failed; no source or account rows were restored') from exc
        self.stdout.write(json.dumps({'messages': len(result['messages']), 'deleted': len(result['deleted_ids']),
            'root_hash': result['root_hash'], 'generation': result['generation'], 'next_before': result['next_before'],
            'source_rows_required': False, 'account_profiles_restored': False}, sort_keys=True))
