"""Operator-only preparation command; never starts or joins a mesh network."""
import json
import os
from pathlib import Path
from django.core.management.base import BaseCommand, CommandError
from sfera_mesh.identity import load_identity
from sfera_mesh.license_client import request_attestation
from sfera_modules.commercial import CommercialError


class Command(BaseCommand):
    help = 'Fetch a short-lived signed placement profile for a node. Does not authorise modules.'

    def add_arguments(self, parser):
        parser.add_argument('--identity-file', required=True)
        parser.add_argument('--network', required=True)
        parser.add_argument('--issuer-public-file', required=True)
        parser.add_argument('--output', required=True)

    def handle(self, *args, **options):
        try:
            issuer = json.loads(Path(options['issuer_public_file']).read_text(encoding='utf-8'))
            trusted = {issuer['issuer']: bytes.fromhex(issuer['public_key'])}
            key = load_identity(options['identity_file'])
            output = Path(options['output'])
            if output.exists():
                raise CommandError('Output already exists; it was not overwritten')
            document, verified = request_attestation(key, options['network'], trusted)
            fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as file:
                json.dump(document, file)
                file.flush()
                os.fsync(file.fileno())
        except (OSError, ValueError, TypeError, KeyError, CommercialError) as exc:
            raise CommandError('Unable to obtain a verified mesh profile; existing files were preserved') from exc
        self.stdout.write(f'Verified profile saved: {len(verified.modules)} paid modules, expires {verified.expires_at}. No module access was changed.')
