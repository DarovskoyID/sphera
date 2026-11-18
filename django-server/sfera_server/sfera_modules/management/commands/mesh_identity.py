from pathlib import Path
from django.core.management.base import BaseCommand, CommandError
from sfera_mesh.identity import create_identity, load_identity, node_id


class Command(BaseCommand):
    help = 'Prepare a persistent node identity; never print or overwrite its private key.'

    def add_arguments(self, parser):
        parser.add_argument('--output', required=True)

    def handle(self, *args, **options):
        path = Path(options['output'])
        try:
            try:
                key = create_identity(path)
            except FileExistsError:
                key = load_identity(path)
        except (OSError, ValueError) as exc:
            raise CommandError('Unable to prepare node identity; existing file was not overwritten') from exc
        self.stdout.write('Mesh node_id: ' + node_id(key.public_key().public_bytes_raw()))
