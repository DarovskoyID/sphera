"""Explicit, restartable migration of one exact committed v1 index to v2.

No SQL snapshot is substituted for the source. The first v2 transaction changes
no UUID statuses and retains the exact old ACL and encrypted body/file pointers.
"""
from hashlib import sha256
import json
import os
from pathlib import Path
import sqlite3
import time

from django.conf import settings

from sfera_mesh.directory import digest64
from sfera_mesh.identity import node_id
from sfera_mesh.recovery_pages import PagedIndexReader, context, validate_index, validate_page
from sfera_mesh.recovery_roots import namespace, validate_root
from sfera_mesh.recovery_tree import validate_head
from sfera_mesh.refresh_lock import RefreshLock
from sfera_mesh.storage import canonical
from .encryption import encrypt_bytes, decrypt_bytes
from .mesh_paged_publication import PagedIndexPublication
from .mesh_read import fetch_ciphertext
from .mesh_recovery_index import validate_document, _decode_entry
from .mesh_index_budget import byte_budget, database_budget
from .mesh_index_disk import claim, check_paths


class IndexMigration:
    def __init__(self, path, writer, source, scope, expected_root, clusters, *, cache_path):
        self.writer, self.directory = writer, writer.publication.directory
        self.publisher = node_id(writer.publication.journal.key.public_key().public_bytes_raw())
        self.identity = namespace(self.publisher, source, scope)
        if (not digest64(expected_root) or not isinstance(clusters, (list, tuple)) or not 1 <= len(clusters) <= 128 or
                any(not digest64(value) for value in clusters) or len(set(clusters)) != len(clusters)):
            raise ValueError('invalid_index_migration_context')
        if not Path(path).is_absolute() or not Path(cache_path).is_absolute():
            raise ValueError('absolute_index_migration_paths_required')
        check_paths(path, cache_path)
        self.path, self.cache_path = str(Path(path).resolve()), str(Path(cache_path).resolve())
        self.page_path = self.path + '.pages.sqlite'
        paths = {os.path.normcase(value) for value in (self.path, self.page_path, self.page_path + '.root.sqlite', self.cache_path)}
        if len(paths) != 4: raise ValueError('separate_index_migration_paths_required')
        app_paths = {os.path.normcase(str(Path(db['NAME']).resolve())) for db in settings.DATABASES.values()
            if db.get('ENGINE', '').endswith('sqlite3') and db.get('NAME') and db['NAME'] != ':memory:'}
        if paths & app_paths: raise ValueError('message_mesh_files_must_not_be_application_database')
        self.source, self.scope, self.expected, self.clusters = source, scope, expected_root, list(clusters)
        self.pin = canonical({'domain': 'sfera-mesh-index-migration-job-v1', 'network': self.directory.network,
            'genesis': self.directory.pin, 'publisher': self.publisher, 'source': source, 'scope': scope,
            'expected_root': expected_root, 'page_clusters': self.clusters, 'page_cache': self.cache_path})
        self.lock = RefreshLock(self.path + '.migration.lock')
        if not self.lock.acquire(): raise ValueError('index_migration_already_running')
        self.db = None
        self.quota = None
        try:
            self.quota = claim(self.path, byte_budget('SFERA_MESH_MESSAGE_INDEX_MIGRATION_BYTES', 4 * 1048576),
                extra={self.page_path: byte_budget('SFERA_MESH_MESSAGE_INDEX_GENERATION_BYTES', 64 * 1048576),
                    self.page_path + '.root.sqlite': 1048576,
                    self.cache_path: byte_budget('SFERA_MESH_MESSAGE_INDEX_CACHE_BYTES', 256 * 1048576)})
            self.db = sqlite3.connect(self.path)
            names = {row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")}
            if names and names != {'index_migration_job'}: raise ValueError('foreign_index_migration_database')
            database_budget(self.db, 'SFERA_MESH_MESSAGE_INDEX_MIGRATION_BYTES', 4 * 1048576)
            self.db.execute('PRAGMA synchronous=FULL')
            self.db.execute('CREATE TABLE IF NOT EXISTS index_migration_job(singleton INTEGER PRIMARY KEY CHECK(singleton=1),context BLOB NOT NULL,source BLOB NOT NULL,completed BLOB)')
            old = self.db.execute('SELECT context,source FROM index_migration_job').fetchone()
            if old is None:
                legacy, tree = self.state()
                if tree is not None: raise ValueError('index_migration_already_migrated')
                body = legacy['record']['body']
                self.writer.confirm_sizes(body['cluster'], {body['digest']: body['size']})
                self.writer.publication.journal.refresh_discovery()
                data = fetch_ciphertext(writer, body['cluster'], body['digest'], body['size'], time.monotonic() + 15)
                raw = canonical({'head': legacy, 'ciphertext': data.hex()})
                self.decode(raw)
                self.state()  # Reject a moved v1 predecessor before freezing the job.
                with self.db:
                    self.db.execute('INSERT INTO index_migration_job VALUES(1,?,?,NULL)', (self.pin, encrypt_bytes(raw)))
            else:
                if bytes(old[0]) != self.pin: raise ValueError('index_migration_context_changed')
                raw = decrypt_bytes(bytes(old[1]))
            self.decode(raw)
        except BaseException:
            self.close(); raise

    def decode(self, raw):
        if len(raw) > 2 * 1048576: raise ValueError('index_migration_journal_limit')
        value = json.loads(raw)
        if (canonical(value) != raw or not isinstance(value, dict) or set(value) != {'head', 'ciphertext'} or
                not isinstance(value['head'], dict) or set(value['head']) != {'record', 'digest'} or not isinstance(value['ciphertext'], str)):
            raise ValueError('index_migration_journal_corrupt')
        body, digest = validate_root(value['head']['record'], self.directory.network, self.directory.pin)
        if digest != self.expected or value['head']['digest'] != digest or namespace(body['publisher'], body['source'], body['scope']) != self.identity:
            raise ValueError('index_migration_source_changed')
        data = bytes.fromhex(value['ciphertext']); wire = canonical([data.hex()])
        if data.hex() != value['ciphertext'] or len(wire) != body['size'] or sha256(wire).hexdigest() != body['digest']:
            raise ValueError('index_migration_source_corrupt')
        plaintext = decrypt_bytes(data); document = json.loads(plaintext)
        if canonical(document) != plaintext: raise ValueError('index_migration_source_encoding')
        validate_document(document, body)
        self.legacy, self.legacy_document = value['head'], document
        deleted = set(body['deleted'])
        self.previous = {identity: identity in deleted for identity in body['messages']}
        self.document = {'domain': 'sfera-mesh-message-index-input-v2', 'genesis': self.directory.pin, 'publisher': self.publisher,
            'source': self.source, 'scope': self.scope, 'generation': body['version'] + 1, 'previous': self.expected,
            'cluster': self.clusters[0], 'page_clusters': self.clusters,
            **{key: document[key] for key in ('members', 'guild_id', 'public', 'closed')},
            'entries': [{**entry, 'cluster': body['cluster']} for entry in document['entries']]}

    def state(self):
        self.directory.refresh(self.writer.publication.address)
        with self.directory.lock:
            self.directory.anchor()
            state = self.directory.current['state']
            legacy = json.loads(canonical(state.get('recovery_roots', {}).get(self.identity)))
            tree = json.loads(canonical(state.get('recovery_trees', {}).get(self.identity)))
        if legacy is None or legacy.get('digest') != self.expected: raise ValueError('index_migration_source_changed')
        body, digest = validate_root(legacy['record'], self.directory.network, self.directory.pin)
        if digest != self.expected or namespace(body['publisher'], body['source'], body['scope']) != self.identity:
            raise ValueError('index_migration_source_changed')
        if tree is not None:
            body, digest = validate_head(tree['record'], self.directory.network, self.directory.pin)
            if digest != tree['digest'] or namespace(body['publisher'], body['source'], body['scope']) != self.identity:
                raise ValueError('index_migration_head_changed')
        return legacy, tree

    def readiness(self):
        from .mesh_index_worker import enabled
        from .mesh_paged_worker import page_clusters
        return (enabled() and getattr(settings, 'SFERA_MESH_MESSAGE_INDEX_V2', False) and
            getattr(settings, 'SFERA_MESH_RECOVERY_READS', False) and
            getattr(settings, 'SFERA_MESH_RECOVERY_PUBLISHER', '') == self.publisher and
            getattr(settings, 'SFERA_MESH_MESSAGE_GENESIS', '') == self.directory.pin and page_clusters() == self.clusters)

    def verify_bodies(self):
        body = self.legacy['record']['body']; deadline = time.monotonic() + 15
        sizes = {entry['digest']: entry['size'] for entry in self.legacy_document['entries']}
        self.writer.confirm_sizes(body['cluster'], {body['digest']: body['size'], **sizes})
        # The complete manifest is needed to validate each body's file pointers.
        from sfera_mesh.manifest_reads import verified_manifests
        _, known = verified_manifests(self.directory)
        confirmed = known.get(body['cluster'], {}).get('sizes', {})
        used = body['size']
        self.writer.publication.journal.refresh_discovery()
        for entry in self.legacy_document['entries']:
            used += entry['size']
            if used > 32 * 1048576 or time.monotonic() >= deadline: raise ValueError('index_migration_verification_limit')
            data = fetch_ciphertext(self.writer, body['cluster'], entry['digest'], entry['size'], deadline)
            _decode_entry(body, self.legacy_document, entry, data, confirmed)
        if time.monotonic() >= deadline: raise ValueError('index_migration_verification_limit')

    def verify_pages(self, head):
        body = head['record']['body']; deadline = time.monotonic() + 15
        # Verify all references against one authenticated snapshot. Refreshing
        # consensus for every page spends the read deadline waiting for a new
        # BFT anchor repeatedly and can never finish a large migrated index.
        from sfera_mesh.manifest_reads import verified_manifests
        with self.directory.lock:
            _, known = verified_manifests(self.directory)
            if self.directory.current['state'].get('recovery_trees', {}).get(self.identity) != head:
                raise ValueError('index_migration_head_changed')
        seen, entries, used = set(), [], 0
        def load(ref):
            nonlocal used
            key = ref['cluster'], ref['digest']
            if key in seen or used + ref['size'] > 32 * 1048576 or time.monotonic() >= deadline:
                raise ValueError('index_migration_verification_limit')
            seen.add(key); used += ref['size']
            if known.get(ref['cluster'], {}).get('sizes', {}).get(ref['digest']) != ref['size']:
                raise ValueError('index_migration_page_uncommitted')
            data = fetch_ciphertext(self.writer, ref['cluster'], ref['digest'], ref['size'], deadline)
            return PagedIndexReader.unpack(canonical([data.hex()]), ref, decrypt_bytes)
        doc = load(body); validate_index(doc, body)
        def visit(ref):
            page = validate_page(load(ref), ref, context(body)); entries.extend(page['entries'])
            for child in page['children']: visit(child)
        if doc['page'] is not None: visit(doc['page'])
        from sfera_mesh.recovery_timeline import validate_complete
        validate_complete(doc, entries, load)
        if (canonical(entries) != canonical(self.document['entries']) or
                any(canonical(doc[key]) != canonical(self.document[key]) for key in ('members', 'guild_id', 'public', 'closed'))):
            raise ValueError('index_migration_result_changed')
        if time.monotonic() >= deadline: raise ValueError('index_migration_verification_limit')

    def step(self, *, prepare_only=False):
        if type(prepare_only) is not bool: raise ValueError('invalid_index_migration_option')
        row = self.db.execute('SELECT context,source,completed FROM index_migration_job WHERE singleton=1').fetchone()
        if row is None or bytes(row[0]) != self.pin: raise ValueError('index_migration_journal_corrupt')
        self.decode(decrypt_bytes(bytes(row[1])))
        completed = None
        if row[2] is not None:
            raw = decrypt_bytes(bytes(row[2])); completed = json.loads(raw)
            if canonical(completed) != raw or not isinstance(completed, dict) or set(completed) != {'record', 'digest'}:
                raise ValueError('index_migration_completion_corrupt')
        _, tree = self.state()
        ready = self.readiness()
        if not prepare_only and not ready: raise ValueError('index_migration_v2_worker_and_reader_required')
        job = PagedIndexPublication(self.page_path, self.writer, self.document,
            previous_messages=self.previous, cache_path=self.cache_path, allow_migration=True)
        try:
            target_hash = sha256(canonical({key: job.transaction[key] for key in ('body', 'signature')})).hexdigest()
            if completed is not None:
                body, digest = validate_head(completed['record'], self.directory.network, self.directory.pin)
                if digest != target_hash or completed['digest'] != digest or body != job.target:
                    raise ValueError('index_migration_completion_corrupt')
                current = tree['record']['body'] if tree is not None else None
                if (current is None or current['version'] < body['version'] or
                        (current['version'] == body['version'] and tree['digest'] != target_hash) or
                        current['count'] < body['count'] or current['deleted_count'] < body['deleted_count']):
                    raise ValueError('index_migration_completion_rollback')
                return {'state': 'completed', 'phase': 'previously_verified', 'root_hash': target_hash,
                    'current_root_hash': tree['digest'], 'generation': body['version'],
                    'messages': len(self.previous), 'deleted': sum(self.previous.values())}
            if tree is not None and tree['digest'] != target_hash:
                return {'state': 'conflict', 'error': 'index_migration_head_changed'}
            self.verify_bodies()
            _, current = self.state()
            if current is not None and current['digest'] != target_hash:
                return {'state': 'conflict', 'error': 'index_migration_head_changed'}
            if prepare_only:
                return {'state': 'prepared', 'source': self.source, 'scope': self.scope, 'previous': self.expected,
                    'root_hash': target_hash, 'generation': job.target['version'], 'messages': len(self.previous),
                    'deleted': sum(self.previous.values()), 'pages': len(job.blocks), 'updates': 0, 'ready': bool(ready)}
            status = job.step()
            if status['state'] == 'confirmed':
                _, current = self.state()
                if current is None or current['digest'] != target_hash or current['record']['body'] != job.target:
                    return {'state': 'conflict', 'error': 'index_migration_head_changed'}
                self.verify_pages(current)
                if self.state()[1] != current: raise ValueError('index_migration_head_changed')
                with self.db:
                    self.db.execute('UPDATE index_migration_job SET completed=? WHERE singleton=1', (encrypt_bytes(canonical(current)),))
                return {**status, 'phase': 'migration_verified', 'messages': len(self.previous), 'deleted': sum(self.previous.values())}
            return status
        finally: job.close()

    def close(self):
        try:
            if self.db is not None: self.db.close(); self.db = None
        finally:
            if self.quota is not None: self.quota.close()
            self.lock.release()
