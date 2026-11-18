import json
import uuid

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from sfera_messages.models import Message
from sfera_messages.mesh_publication import enabled, require_durable_database


class Command(BaseCommand):
    help = 'Capture a bounded page of existing DM rows as current mesh snapshots; publication remains asynchronous.'

    def add_arguments(self, parser):
        parser.add_argument('--limit', type=int, default=32)
        parser.add_argument('--after', default='')
        parser.add_argument('--database', default='default')
        parser.add_argument('--source', choices=['dm', 'guild'], default='dm')

    def handle(self, *args, **options):
        limit, using = options['limit'], options['database']
        if not 1 <= limit <= 512 or not enabled():
            raise CommandError('mesh capture must be configured; limit must be 1..512')
        require_durable_database(using)
        from sfera_messages.mesh_sources import source_model
        model = source_model(options['source'])
        query = model.objects.using(using).order_by('pk')
        if options['after']:
            try:
                after = uuid.UUID(options['after'])
            except ValueError as exc:
                raise CommandError('invalid cursor') from exc
            query = query.filter(pk__gt=after)
        identities = list(query.values_list('pk', flat=True)[:limit])
        changed = 0
        for identity in identities:
            with transaction.atomic(using=using):
                message = model.objects.using(using).select_for_update().filter(pk=identity).first()
                if message is None:
                    continue
                previous = message.mesh_write_id
                from sfera_messages.models import MessageMeshDelivery
                events = MessageMeshDelivery.objects.using(using).filter(message_id=message.pk, write__source=options['source'])
                # Existing legacy history must not be announced as thousands of
                # new messages. An actual pending send retains its normal gate.
                message._mesh_backfill = not events.filter(state='pending').exists()
                message.save(using=using, update_fields=['encrypted_content'])
                if message._mesh_backfill and previous != message.mesh_write_id:
                    events.create(message_id=message.pk, write_id=message.mesh_write_id, state='legacy')
                changed += message.mesh_write_id != previous
        self.stdout.write(json.dumps({'observed': len(identities), 'captured': changed,
                                     'next_after': str(identities[-1]) if identities else None}))
