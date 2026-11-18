from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from sfera_messages.encryption import rotate_bytes, rotate_text
from sfera_messages.models import Attachment, Message, ScheduledMessage
from sfera_modules import hooks


def _models():
    """Core models plus every module's encrypted data (hooks.ENCRYPTED_DATA)."""
    text, files = [Message, ScheduledMessage], [Attachment]
    for provided in hooks.collect(hooks.ENCRYPTED_DATA).values():
        text += list((provided or {}).get('text', []))
        files += list((provided or {}).get('files', []))
    return text, files


class Command(BaseCommand):
    help = (
        'Re-encrypt chat message bodies and encrypted attachment files with '
        'the current SFERA_MESSAGE_ENCRYPTION_KEY.'
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--dry-run',
            action='store_true',
            help='Decrypt/rotate in memory, but do not save changes.',
        )
        parser.add_argument(
            '--batch-size',
            type=int,
            default=500,
            help='Rows to stream per DB batch.',
        )
        parser.add_argument(
            '--skip-files',
            action='store_true',
            help='Only rotate DB text fields, leaving encrypted attachment files untouched.',
        )

    def handle(self, *args, **options):
        dry_run = options['dry_run']
        batch_size = options['batch_size']
        skip_files = options['skip_files']

        if batch_size < 1:
            raise CommandError('--batch-size must be positive')

        total_text = 0
        total_files = 0

        text_models, file_models = _models()
        for model in text_models:
            rotated = self._rotate_text_model(model, batch_size, dry_run)
            total_text += rotated
            self.stdout.write(f'{model.__name__}: {rotated} text rows')

        if not skip_files:
            for model in file_models:
                rotated = self._rotate_file_model(model, batch_size, dry_run)
                total_files += rotated
                self.stdout.write(f'{model.__name__}: {rotated} files')

        suffix = ' checked' if dry_run else ' rotated'
        self.stdout.write(self.style.SUCCESS(
            f'{total_text} text rows and {total_files} files{suffix}.'
        ))

    def _rotate_text_model(self, model, batch_size, dry_run):
        count = 0
        qs = model.objects.only('id', 'encrypted_content').iterator(chunk_size=batch_size)
        for obj in qs:
            if not obj.encrypted_content:
                continue
            rotated = rotate_text(obj.encrypted_content)
            count += 1
            if dry_run:
                continue
            obj.encrypted_content = rotated
            with transaction.atomic():
                obj.save(update_fields=['encrypted_content'])
        return count

    def _rotate_file_model(self, model, batch_size, dry_run):
        count = 0
        qs = model.objects.only('id', 'file').iterator(chunk_size=batch_size)
        for obj in qs:
            if not obj.file:
                continue
            with obj.file.open('rb') as fh:
                rotated = rotate_bytes(fh.read())
            count += 1
            if dry_run:
                continue
            with obj.file.open('wb') as fh:
                fh.write(rotated)
        return count
