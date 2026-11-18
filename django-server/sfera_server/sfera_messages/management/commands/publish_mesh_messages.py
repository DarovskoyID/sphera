import json
import sqlite3
import subprocess
from contextlib import nullcontext
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.conf import settings
from django.db import DatabaseError
from cryptography.fernet import InvalidToken

from sfera_messages.mesh_publication import publish_batch
from sfera_messages.mesh_worker import open_writer


class Command(BaseCommand):
    help = 'Publish one bounded batch of message snapshots and file parts through verified laboratory mesh consensus.'

    def add_arguments(self, parser):
        parser.add_argument('--config', required=True)
        parser.add_argument('--limit', type=int, default=32)
        parser.add_argument('--database', default='default')

    def handle(self, *args, **options):
        with Path(options['config']).open('rb') as source:
            raw = source.read(16385)
        if len(raw) > 16384:
            raise CommandError('message mesh configuration is too large')
        try:
            config = json.loads(raw)
            from sfera_messages.models import MessageMeshWrite
            clusters = set(MessageMeshWrite.objects.using(options['database']).filter(state='pending').values_list('cluster', flat=True).distinct())
            from sfera_messages.mesh_delivery import enabled as delivery_enabled, dispatch_confirmed
            from sfera_messages.mesh_index_worker import enabled as index_enabled, AutomaticIndexes
            automatic_index = index_enabled()
            if automatic_index:
                from sfera_messages.mesh_index_disk import configured
                configured(required=True)
            paged_index = automatic_index and getattr(settings, 'SFERA_MESH_MESSAGE_INDEX_V2', False)
            controller = AutomaticIndexes
            controller_file = 'automatic-index.sqlite'
            if paged_index:
                from sfera_messages.mesh_paged_worker import AutomaticPagedIndexes, page_clusters
                controller = AutomaticPagedIndexes
                controller_file = 'automatic-paged-index.sqlite'
                clusters.update(page_clusters())
            if automatic_index:
                # ACL-only changes must be observed even when the delivery and
                # body queues are empty. Existing recovery roots also survive
                # loss of the application outbox and must not disappear.
                clusters.add(settings.SFERA_MESH_MESSAGE_CLUSTER)
            if delivery_enabled():
                from sfera_messages.models import MessageMeshDelivery
                clusters.update(MessageMeshDelivery.objects.using(options['database']).filter(state='pending').values_list('write__cluster', flat=True))
            if not clusters:
                self.stdout.write(json.dumps({'pending_observed': 0, 'confirmed': 0}))
                return
            with open_writer(config, clusters=clusters) as writer:
                result = publish_batch(writer, using=options['database'], limit=options['limit'])
                with (controller(str(Path(config['publication']) / controller_file), writer,
                        using=options['database']) if automatic_index else nullcontext(None)) as indexes:
                    if indexes is not None:
                        result['indexes'] = indexes.step(limit=min(options['limit'], 8))
                    if delivery_enabled():
                        result['dispatched'] = dispatch_confirmed(writer, using=options['database'], limit=options['limit'],
                            index_gate=indexes.allows if indexes is not None else None,
                            index_scopes={(row['source'], row['scope']) for row in result['indexes'] if row['state'] == 'confirmed'}
                                if indexes is not None else None)
        except (ValueError, OSError, sqlite3.Error, DatabaseError, InvalidToken, subprocess.SubprocessError) as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write(json.dumps(result, sort_keys=True))
