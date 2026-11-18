import json
import os
from pathlib import Path
import sqlite3
import subprocess

from cryptography.fernet import InvalidToken
from django.core.management.base import BaseCommand, CommandError
from sfera_messages.mesh_read import read_config
from sfera_messages.mesh_reader import open_reader
from sfera_messages.mesh_recovery_index import read_index_attachment


class Command(BaseCommand):
    help = 'Recover one authenticated indexed file into a new operator-owned file, without source rows.'

    def add_arguments(self, parser):
        for name in ('publisher', 'scope', 'user', 'message', 'attachment', 'output'):
            parser.add_argument('--' + name, required=True)
        parser.add_argument('--source', choices=('dm', 'guild'), required=True)
        parser.add_argument('--root', default=None)

    def handle(self, *args, **options):
        path = Path(options['output'])
        if not path.is_absolute() or not path.parent.is_dir() or path.exists():
            raise CommandError('output must be a new absolute path in an operator-controlled directory')
        try:
            with open_reader(read_config()) as reader:
                result = read_index_attachment(reader, options['publisher'], options['source'], options['scope'],
                    options['user'], options['message'], options['attachment'], expected_root=options['root'])
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'wb') as destination:
                destination.write(result['content']); destination.flush(); os.fsync(destination.fileno())
        except (ValueError, OSError, InvalidToken, sqlite3.Error, subprocess.SubprocessError) as exc:
            raise CommandError('mesh file recovery failed; no source rows were restored') from exc
        self.stdout.write(json.dumps({'bytes': result['file_size'], 'root_hash': result['root_hash'], 'generation': result['generation']}))
