"""Opt-in automatic bounded history snapshots and restartable publication.

SQL supplies current message heads and membership. Missing source rows never
mean deletion: only retained confirmed terminal tombstones can remove content.
"""
from hashlib import sha256
import json
import os
from pathlib import Path
import sqlite3

from django.apps import apps
from django.conf import settings
from django.db import transaction, connections

from sfera_mesh.directory import ZERO, digest64
from sfera_mesh.identity import node_id
from sfera_mesh.recovery_roots import namespace, root_record
from sfera_mesh.refresh_lock import RefreshLock
from sfera_mesh.storage import canonical
from .encryption import decrypt_bytes, encrypt_bytes
from .mesh_history import _snapshot, _attachment_sizes, BODY_BYTE_LIMIT
from .mesh_index_publication import IndexPublication
from .mesh_recovery_index import index_document, validate_document
from .mesh_revisions import validate_tombstone
from .mesh_sources import source_model, scope_field
from .mesh_index_disk import claim, check_paths
from .mesh_index_budget import byte_budget, database_budget


def enabled():
    if not getattr(settings, 'SFERA_MESH_MESSAGE_INDEX', False):
        return False
    from .mesh_revisions import enabled as recovery_enabled
    if not recovery_enabled():
        raise ValueError('mesh_index_requires_recovery_and_delivery')
    return True


def fingerprint(document):
    return sha256(canonical({key: value for key, value in document.items()
        if key not in {'generation', 'previous'}})).hexdigest()


def snapshot(writer, source, scope, *, using='default', paged=False, page_clusters=None):
    """Read heads/ACL without network I/O; reject source changes during capture."""
    from .models import Conversation, MessageMeshWrite
    if paged and (not isinstance(page_clusters, (list, tuple)) or not page_clusters or
            len(page_clusters) > 128 or any(not digest64(value) for value in page_clusters) or len(set(page_clusters)) != len(page_clusters)):
        raise ValueError('paged_index_page_clusters_required')
    directory = writer.publication.directory
    key = writer.publication.journal.key
    publisher = node_id(key.public_key().public_bytes_raw())
    identity = namespace(publisher, source, scope)
    with directory.lock:
        directory.anchor()
        if not paged and identity in directory.current['state'].get('recovery_trees', {}):
            raise ValueError('recovery_tree_v2_publisher_required')
        head = json.loads(canonical(directory.current['state'].get('recovery_trees' if paged else 'recovery_roots', {}).get(identity)))
    capture_limit = 50000 if paged else 256
    cluster = getattr(settings, 'SFERA_MESH_MESSAGE_CLUSTER', '')
    if not digest64(cluster) or getattr(settings, 'SFERA_MESH_MESSAGE_GENESIS', '') != directory.pin:
        raise ValueError('message_mesh_index_trust_changed')
    database = connections[using]
    outer_atomic = database.in_atomic_block
    if database.vendor not in ('sqlite', 'postgresql'):
        raise ValueError('automatic_index_database_unsupported')
    with transaction.atomic(using=using):
        if database.vendor == 'postgresql' and not outer_atomic:
            with database.cursor() as cursor:
                cursor.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        if source == 'dm':
            origin = Conversation.objects.using(using).filter(pk=scope).first()
            if origin is None:
                raise ValueError('message_mesh_index_source_missing')
            members = sorted(str(value) for value in origin.participants.using(using).values_list('pk', flat=True)[:65])
            guild_id, public = None, False
        else:
            origin = apps.get_model('sfera_servers.GuildChannel').objects.using(using).select_related('guild').filter(pk=scope).first()
            if origin is None:
                raise ValueError('message_mesh_index_source_missing')
            members = sorted(str(value) for value in apps.get_model('sfera_servers.GuildMembership').objects.using(using)
                .filter(guild_id=origin.guild_id).values_list('user_id', flat=True)[:65])
            guild_id, public = str(origin.guild_id), origin.guild.is_discoverable
        if len(members) > 64:
            raise ValueError('message_mesh_index_member_limit')
        live = source_model(source).objects.using(using).filter(**{scope_field(source): scope})
        if source == 'guild':
            live = live.select_related('channel__guild')
        messages = list(live.order_by('pk')[:capture_limit + 1])
        writes = MessageMeshWrite.objects.using(using).filter(source=source, conversation_id=scope)
        retained = set(str(value) for value in writes.values_list('message_id', flat=True).distinct()[:capture_limit + 1])
        tombstones = list(writes.filter(format_version=4).order_by('pk')[:capture_limit + 1])
        if len(messages) > capture_limit or len(retained) > capture_limit or len(tombstones) > capture_limit:
            raise ValueError('message_mesh_index_message_limit')
        if writes.exclude(genesis=directory.pin).exists() or (not paged and writes.exclude(cluster=cluster).exists()):
            raise ValueError('message_mesh_index_trust_changed')
        current = {str(message.pk): message for message in messages}
        by_id = writes.in_bulk([message.mesh_write_id for message in messages])
        entries, sizes, deleted, body_bytes = [], {}, set(), 0
        for write in tombstones:
            identity_id = str(write.message_id)
            if identity_id in current or identity_id in deleted:
                raise ValueError('message_mesh_index_tombstone_conflict')
            deleted.add(identity_id)
        selected = [(by_id.get(message.mesh_write_id), message) for message in messages] + [(write, None) for write in tombstones]
        if retained - (set(current) | deleted):
            raise ValueError('message_mesh_index_unexplained_missing_message')
        for write, message in selected:
            if write is None or write.state != 'confirmed':
                raise ValueError('message_mesh_index_waiting_for_bodies')
            data = bytes(write.ciphertext)
            body_bytes += 2 * len(data) + 4
            if not digest64(write.cluster) or len(data) > 131000 or (not paged and body_bytes > BODY_BYTE_LIMIT):
                raise ValueError('message_mesh_index_body_byte_limit')
            if message is None:
                raw = decrypt_bytes(data); body = json.loads(raw)
                validate_tombstone(body, directory.pin, write.cluster)
                identity_id = str(write.message_id)
                expected = sha256(canonical({'domain': 'sfera-mesh-django-message-write-v1',
                    'message': identity_id, 'snapshot': write.snapshot_hash})).hexdigest()
                if (canonical(body) != raw or sha256(raw).hexdigest() != write.snapshot_hash or expected != write.pk or
                        body['source'] != source or body['conversation_id'] != scope or body['message_id'] != identity_id):
                    raise ValueError('message_mesh_index_tombstone_corrupt')
            else:
                body = _snapshot(write, data, message)
                attachment_sizes = _attachment_sizes(write, body)
                if paged:
                    sizes.setdefault(write.cluster, {}).update(attachment_sizes)
                else:
                    sizes.update(attachment_sizes)
            wire = canonical([data.hex()]); digest = sha256(wire).hexdigest()
            if paged:
                sizes.setdefault(write.cluster, {})[digest] = len(wire)
            else:
                sizes[digest] = len(wire)
            entries.append({'message_id': str(write.message_id), 'author_id': body['author_id'],
                'created_at': body.get('created_at'), 'snapshot_hash': write.snapshot_hash,
                'digest': digest, 'size': len(wire), 'deleted': message is None,
                **({'cluster': write.cluster} if paged else {})})
        entries.sort(key=lambda entry: entry['message_id'])
        if paged:
            document = {'domain': 'sfera-mesh-message-index-input-v2', 'genesis': directory.pin, 'publisher': publisher,
                'source': source, 'scope': scope, 'cluster': page_clusters[0], 'page_clusters': list(page_clusters),
                'generation': head['record']['body']['version'] + 1 if head else 1, 'previous': head['digest'] if head else ZERO,
                'members': members, 'guild_id': guild_id, 'public': public, 'closed': not public and not members, 'entries': entries}
        else:
            root = root_record(key, directory.network, directory.pin, source, scope, cluster, ZERO, 1,
            version=head['record']['body']['version'] + 1 if head else 1, previous=head['digest'] if head else ZERO,
            messages=[entry['message_id'] for entry in entries], deleted=sorted(deleted))['body']
        if not paged and head and (not set(head['record']['body']['messages']).issubset(root['messages']) or
                not set(head['record']['body']['deleted']).issubset(root['deleted'])):
            raise ValueError('message_mesh_index_omission_or_resurrection')
        if not paged:
            document = index_document(root, members, entries, guild_id=guild_id, public=public, closed=not public and not members)
        # Also recheck inside callers' existing transactions, whose isolation
        # level this function cannot change (notably the delivery transaction).
        final_origin = (Conversation.objects.using(using).filter(pk=scope).first() if source == 'dm' else
            apps.get_model('sfera_servers.GuildChannel').objects.using(using).select_related('guild').filter(pk=scope).first())
        if final_origin is None:
            raise ValueError('message_mesh_index_source_changed_during_snapshot')
        final_members = (sorted(str(value) for value in final_origin.participants.using(using).values_list('pk', flat=True)[:65])
            if source == 'dm' else sorted(str(value) for value in
                apps.get_model('sfera_servers.GuildMembership').objects.using(using).filter(guild_id=guild_id).values_list('user_id', flat=True)[:65]))
        final_heads = [(str(pk), write) for pk, write in live.order_by('pk').values_list('pk', 'mesh_write_id')[:capture_limit + 1]]
        final_retained = set(str(value) for value in writes.values_list('message_id', flat=True).distinct()[:capture_limit + 1])
        final_deleted = set(str(value) for value in writes.filter(format_version=4).values_list('message_id', flat=True)[:capture_limit + 1])
        if (final_origin is None or final_members != members or final_retained != retained or final_deleted != deleted or
                final_heads != [(str(message.pk), message.mesh_write_id) for message in messages] or
                (source == 'guild' and (str(final_origin.guild_id) != guild_id or final_origin.guild.is_discoverable != public))):
            raise ValueError('message_mesh_index_source_changed_during_snapshot')
    if not paged and len(sizes) > 512:
        raise ValueError('message_mesh_index_block_limit')
    if paged and (len(entries) > capture_limit or len(canonical(document)) > 32 * 1048576 or
            any(len(values) > 512 for values in sizes.values())):
        raise ValueError('paged_index_snapshot_capacity')
    return document, sizes


class AutomaticIndexes:
    def __init__(self, path, writer, *, using='default'):
        if not Path(path).is_absolute():
            raise ValueError('absolute_message_mesh_index_path_required')
        check_paths(path)
        self.path = str(Path(path).resolve())
        app_paths = {os.path.normcase(str(Path(db['NAME']).resolve())) for db in settings.DATABASES.values()
            if db.get('ENGINE', '').endswith('sqlite3') and db.get('NAME') and db['NAME'] != ':memory:'}
        if os.path.normcase(self.path) in app_paths:
            raise ValueError('message_mesh_files_must_not_be_application_database')
        self.writer, self.using = writer, using
        self.publisher = node_id(writer.publication.journal.key.public_key().public_bytes_raw())
        self.lock = RefreshLock(self.path + '.automatic-index.lock')
        if not self.lock.acquire():
            raise ValueError('message_mesh_index_worker_already_running')
        self.db = None
        self.quota = None
        try:
            self.quota = claim(path, byte_budget('SFERA_MESH_MESSAGE_INDEX_CONTROLLER_BYTES', 64 * 1048576))
            self.db = sqlite3.connect(self.path)
            names = {row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")}
            if names and names != {'automatic_index_pin', 'automatic_index_scopes', 'automatic_index_jobs'}:
                raise ValueError('foreign_automatic_index_database')
            database_budget(self.db, 'SFERA_MESH_MESSAGE_INDEX_CONTROLLER_BYTES', 64 * 1048576)
            self.db.execute('PRAGMA synchronous=FULL')
            self.db.executescript('''
                CREATE TABLE IF NOT EXISTS automatic_index_pin(singleton INTEGER PRIMARY KEY CHECK(singleton=1), context BLOB NOT NULL, cursor TEXT NOT NULL DEFAULT '');
                CREATE TABLE IF NOT EXISTS automatic_index_scopes(identity TEXT PRIMARY KEY, document BLOB NOT NULL, fingerprint TEXT NOT NULL, root_hash TEXT);
                CREATE TABLE IF NOT EXISTS automatic_index_jobs(job TEXT PRIMARY KEY);
            ''')
            context = canonical({'network': writer.publication.directory.network, 'genesis': writer.publication.directory.pin,
                'publisher': self.publisher, 'database': using})
            with self.db:
                old = self.db.execute('SELECT context FROM automatic_index_pin').fetchone()
                if old and bytes(old[0]) != context:
                    raise ValueError('automatic_index_context_changed')
                self.db.execute('INSERT OR IGNORE INTO automatic_index_pin(singleton,context) VALUES(1,?)', (context,))
        except BaseException:
            self.close()
            raise

    def close(self):
        try:
            if self.db is not None: self.db.close()
        finally:
            if self.quota is not None: self.quota.close()
            self.lock.release()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def _stored(self, identity):
        row = self.db.execute('SELECT document,fingerprint,root_hash FROM automatic_index_scopes WHERE identity=?', (identity,)).fetchone()
        if row is None:
            return None
        raw = decrypt_bytes(bytes(row[0])); document = json.loads(raw)
        if (canonical(document) != raw or fingerprint(document) != row[1] or
                namespace(document['publisher'], document['source'], document['scope']) != identity or
                document['publisher'] != self.publisher or (row[2] is not None and not digest64(row[2]))):
            raise ValueError('automatic_index_journal_corrupt')
        return document, row[1], row[2]

    def _job(self, document):
        token = sha256(canonical(document)).hexdigest()
        return self.path + '.' + token + '.sqlite'

    def allows(self, write):
        """Recheck SQL membership/heads and the fresh BFT root before fanout."""
        identity = namespace(self.publisher, write.source, str(write.conversation_id))
        stored = self._stored(identity)
        if stored is None or stored[2] is None:
            return False
        document, _, root_hash = stored
        directory = self.writer.publication.directory
        with directory.lock:
            directory.anchor()
            if identity in directory.current['state'].get('recovery_trees', {}):
                return False
            head = directory.current['state'].get('recovery_roots', {}).get(identity)
            if not head or head['digest'] != root_hash:
                return False
            validate_document(document, head['record']['body'])
        desired, _ = snapshot(self.writer, write.source, str(write.conversation_id), using=self.using)
        return fingerprint(desired) == fingerprint(document) and any(entry['message_id'] == str(write.message_id) and
            entry['snapshot_hash'] == write.snapshot_hash for entry in document['entries'])

    def step(self, *, limit=8):
        from .models import MessageMeshWrite
        if type(limit) is not int or not 1 <= limit <= 16:
            raise ValueError('invalid_automatic_index_batch')
        directory = self.writer.publication.directory
        directory.refresh(self.writer.publication.address)
        with directory.lock:
            directory.anchor()
            heads = json.loads(canonical(directory.current['state'].get('recovery_roots', {})))
        scopes = {(source, str(scope)) for source, scope in MessageMeshWrite.objects.using(self.using)
            .values_list('source', 'conversation_id').distinct()[:129]}
        scopes.update((head['record']['body']['source'], head['record']['body']['scope']) for head in heads.values()
            if head['record']['body']['publisher'] == self.publisher)
        scopes.update((self._stored(identity)[0]['source'], self._stored(identity)[0]['scope']) for (identity,) in
            self.db.execute('SELECT identity FROM automatic_index_scopes').fetchall())
        if len(scopes) > 128:
            raise ValueError('automatic_index_scope_limit')
        ordered = sorted((namespace(self.publisher, source, scope), source, scope) for source, scope in scopes)
        cursor = self.db.execute('SELECT cursor FROM automatic_index_pin').fetchone()[0]
        selected = ([row for row in ordered if row[0] > cursor] + [row for row in ordered if row[0] <= cursor])[:limit]
        result = []
        for identity, source, scope in selected:
            try:
                desired, sizes = snapshot(self.writer, source, scope, using=self.using)
                stored = self._stored(identity)
                if stored and stored[2] is not None and stored[1] == fingerprint(desired):
                    with directory.lock:
                        directory.anchor()
                        head = directory.current['state'].get('recovery_roots', {}).get(identity)
                    if not head or head['digest'] != stored[2]:
                        raise ValueError('automatic_index_confirmed_root_changed')
                    job = IndexPublication(self._job(stored[0]), self.writer, stored[0])
                    try:
                        if job.target != head['record']['body']:
                            raise ValueError('automatic_index_confirmed_payload_changed')
                    finally:
                        job.close()
                    result.append({'source': source, 'scope': scope, 'state': 'confirmed', 'root_hash': head['digest']})
                    continue
                if stored is None or stored[2] is not None:
                    token = sha256(canonical(desired)).hexdigest()
                    with self.db:
                        if self.db.execute('SELECT COUNT(*) FROM automatic_index_jobs').fetchone()[0] >= 512:
                            raise ValueError('automatic_index_job_limit')
                        self.db.execute('INSERT OR IGNORE INTO automatic_index_jobs VALUES(?)', (token,))
                        self.db.execute('INSERT OR REPLACE INTO automatic_index_scopes VALUES(?,?,?,NULL)',
                            (identity, encrypt_bytes(canonical(desired)), fingerprint(desired)))
                    document = desired
                else:
                    document = stored[0]
                if sizes:
                    self.writer.confirm_sizes(document['cluster'], sizes)
                job = IndexPublication(self._job(document), self.writer, document)
                try:
                    status = job.step()
                finally:
                    job.close()
                if status['state'] == 'confirmed':
                    with self.db:
                        self.db.execute('UPDATE automatic_index_scopes SET root_hash=? WHERE identity=?', (status['root_hash'], identity))
                    latest, _ = snapshot(self.writer, source, scope, using=self.using)
                    if fingerprint(latest) != fingerprint(document):
                        status = {'state': 'waiting', 'phase': 'changed_during_publication'}
                result.append({'source': source, 'scope': scope, **status})
            except ValueError as exc:
                result.append({'source': source, 'scope': scope, 'state': 'waiting', 'error': str(exc)[:96]})
            finally:
                with self.db:
                    self.db.execute('UPDATE automatic_index_pin SET cursor=?', (identity,))
        return result
