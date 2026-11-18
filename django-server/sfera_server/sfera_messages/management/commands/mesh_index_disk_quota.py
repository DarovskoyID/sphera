"""Inspect reservations; explicitly retire missing files or resize policy."""
import json
import sqlite3
from django.core.management.base import BaseCommand, CommandError
from sfera_messages.mesh_index_disk import configured, retire_deleted, status


class Command(BaseCommand):
    help = 'Inspect the shared recovery disk budget; never remove payload files or connection locks.'

    def add_arguments(self, parser):
        parser.add_argument('--retire-deleted', nargs='+', metavar='ABSOLUTE_PATH')
        parser.add_argument('--resize', action='store_true', help='Explicitly adopt configured DISK_BYTES if all existing reservations fit.')

    def handle(self, *args, **options):
        try:
            configured(required=True)
            if options.get('resize') and options.get('retire_deleted'):
                raise ValueError('separate_quota_resize_and_retirement_required')
            removed = retire_deleted(options['retire_deleted']) if options.get('retire_deleted') else 0
            result = status(resize=options.get('resize', False))
            result['retired'] = removed
        except (ValueError, OSError, sqlite3.Error) as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write(json.dumps(result, sort_keys=True))
