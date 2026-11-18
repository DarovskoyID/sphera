"""Bounded worker passes with graceful termination and durable queue retries."""
import io
import json
import signal
import threading

from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from django.db import close_old_connections


class Command(BaseCommand):
    help = 'Continuously publish and dispatch queued DM/Guild revisions through the configured verified mesh runtime.'

    def add_arguments(self, parser):
        parser.add_argument('--config', required=True)
        parser.add_argument('--limit', type=int, default=32)
        parser.add_argument('--interval', type=float, default=2)
        parser.add_argument('--database', default='default')
        parser.add_argument('--once', action='store_true')

    def handle(self, *args, **options):
        if not 1 <= options['limit'] <= 64 or not 1 <= options['interval'] <= 60:
            raise CommandError('limit must be 1..64 and interval 1..60 seconds')
        stop = threading.Event()
        previous = {}
        for name in ('SIGINT', 'SIGTERM'):
            number = getattr(signal, name, None)
            if number is not None and threading.current_thread() is threading.main_thread():
                previous[number] = signal.signal(number, lambda *_: stop.set())
        last = None
        try:
            while not stop.is_set():
                close_old_connections()
                output = io.StringIO()
                try:
                    call_command('publish_mesh_messages', config=options['config'], limit=options['limit'],
                                 database=options['database'], stdout=output)
                    result = output.getvalue().strip()
                except (CommandError, OSError, ValueError) as exc:
                    if options['once']:
                        raise
                    result = json.dumps({'retrying': True, 'error': str(exc)[:256]})
                if result != last:
                    self.stdout.write(result)
                    self.stdout.flush()
                    last = result
                if options['once']:
                    break
                stop.wait(options['interval'])
        finally:
            for number, handler in previous.items():
                signal.signal(number, handler)
            close_old_connections()
