"""Restartable publication of every encrypted page before one v2 head.

Explicit snapshots only. Neither missing SQL rows nor a lost RPC reply grant
permission to drop known UUIDs, undo tombstones or rebase a prepared generation.
"""
from hashlib import sha256
import json
import os
from pathlib import Path
import sqlite3
import threading

from django.conf import settings

from sfera_mesh.directory import digest64
from sfera_mesh.identity import node_id
from sfera_mesh.recovery_pages import build_index, context, validate_index, validate_page, acl, entry as validate_entry, ENTRY_FIELDS, PagedIndexReader
from sfera_mesh.recovery_roots import namespace
from sfera_mesh.recovery_tree import RecoveryTree, head_record, validate_head, updates_digest
from sfera_mesh.recovery_tree_publisher import RecoveryTreePublisher
from sfera_mesh.refresh_lock import RefreshLock
from sfera_mesh.storage import canonical
from .encryption import encrypt_bytes, decrypt_bytes
from .mesh_page_cache import PageCipherCache
from .mesh_page_capacity import page_capacity, page_occupancy
from .mesh_index_budget import database_budget, byte_budget, is_full
from .mesh_index_disk import claim, check_paths

FIELDS = {'domain', 'genesis', 'publisher', 'source', 'scope', 'cluster', 'generation', 'previous',
    'members', 'closed', 'public', 'guild_id', 'entries', 'page_clusters'}


class PagedIndexPublication:
    def __init__(self, path, writer, document, *, previous_messages=None, cache_path=None, allow_migration=False):
        if type(allow_migration) is not bool: raise ValueError('invalid_paged_index_migration_option')
        self.allow_migration = allow_migration
        check_paths(path, cache_path)
        if str(path) == ':memory:' or not Path(path).is_absolute():
            raise ValueError('absolute_durable_paged_index_path_required')
        self.path = str(Path(path).resolve())
        if cache_path is not None and not Path(cache_path).is_absolute(): raise ValueError('absolute_paged_cache_path_required')
        self.cache_path = str(Path(cache_path or self.path + '.cache.sqlite').resolve())
        targets = {os.path.normcase(self.path), os.path.normcase(self.path + '.root.sqlite'), os.path.normcase(self.cache_path)}
        if len(targets) != 3: raise ValueError('paged_index_paths_must_be_separate')
        databases = {os.path.normcase(str(Path(db['NAME']).resolve())) for db in settings.DATABASES.values()
            if db.get('ENGINE', '').endswith('sqlite3') and db.get('NAME') and db['NAME'] != ':memory:'}
        if targets & databases: raise ValueError('message_mesh_files_must_not_be_application_database')
        self.writer, self.directory, self.key = writer, writer.publication.directory, writer.publication.journal.key
        document = json.loads(canonical(document))
        previous_messages = json.loads(canonical({} if previous_messages is None else previous_messages))
        if (not isinstance(document, dict) or set(document) != FIELDS or
                document['domain'] != 'sfera-mesh-message-index-input-v2' or
                document['genesis'] != self.directory.pin or document['publisher'] != node_id(self.key.public_key().public_bytes_raw()) or
                not isinstance(document['entries'], list) or not isinstance(previous_messages, dict) or
                any(type(deleted) is not bool for deleted in previous_messages.values()) or
                not isinstance(document['page_clusters'], list) or not 1 <= len(document['page_clusters']) <= 128 or
                any(not digest64(cluster) for cluster in document['page_clusters']) or
                len(set(document['page_clusters'])) != len(document['page_clusters']) or document['cluster'] != document['page_clusters'][0]):
            raise ValueError('invalid_paged_index_input')
        self.identity = namespace(document['publisher'], document['source'], document['scope'])
        document['entries'].sort(key=lambda entry: entry['message_id'])
        if any(not isinstance(entry, dict) or set(entry) != ENTRY_FIELDS - {'path'} for entry in document['entries']):
            raise ValueError('invalid_paged_index_entry')
        self.previous = RecoveryTree(previous_messages, [message for message, deleted in previous_messages.items() if deleted])
        current = {entry['message_id']: entry['deleted'] for entry in document['entries']}
        if len(current) != len(document['entries']) or any(type(deleted) is not bool for deleted in current.values()):
            raise ValueError('invalid_paged_index_message_set')
        if not set(previous_messages).issubset(current) or any(deleted and not current[message] for message, deleted in previous_messages.items()):
            raise ValueError('paged_index_omission_or_resurrection')
        changed = [message for message in sorted(current) if message not in previous_messages or previous_messages[message] != current[message]]
        if len(changed) > 4: raise ValueError('paged_index_transition_batch_limit')
        tree = RecoveryTree(previous_messages, [message for message, deleted in previous_messages.items() if deleted])
        self.updates = [tree.update(message, 2 if current[message] else 1) for message in changed]
        self.document, self.current = document, current
        self.prototype = head_record(self.key, self.directory.network, self.directory.pin, document['source'], document['scope'],
            document['cluster'], '0' * 64, 1, tree.root, len(current), sum(current.values()),
            version=document['generation'], previous=document['previous'], updates=self.updates)['body']
        acl({**document, 'context': context(self.prototype)})
        for entry in document['entries']:
            validate_entry(entry)
        self.body_queries = self.queries(document['entries'])
        raw = canonical({'document': document, 'previous_messages': previous_messages})
        if len(raw) > 32 * 1048576: raise ValueError('paged_index_input_byte_limit')
        self.token = sha256(raw).hexdigest()
        self.lock, self.process_lock = threading.RLock(), RefreshLock(self.path + '.paged-index.lock')
        self.quota = claim(self.path, byte_budget('SFERA_MESH_MESSAGE_INDEX_GENERATION_BYTES', 64 * 1048576),
            extra={self.path + '.root.sqlite': 1048576,
                self.cache_path: byte_budget('SFERA_MESH_MESSAGE_INDEX_CACHE_BYTES', 256 * 1048576)})
        self.db = None
        try:
            self.db = sqlite3.connect(self.path, check_same_thread=False)
            names = {row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")}
            if names and names != {'paged_index_pin', 'paged_index_blocks', 'paged_index_head'}:
                raise ValueError('foreign_paged_index_database')
            byte_limit = database_budget(self.db, 'SFERA_MESH_MESSAGE_INDEX_GENERATION_BYTES', 64 * 1048576)
            self.db.execute('PRAGMA synchronous=FULL')
            self.db.executescript('''
                CREATE TABLE IF NOT EXISTS paged_index_pin(singleton INTEGER PRIMARY KEY CHECK(singleton=1), context TEXT NOT NULL, ciphertext BLOB NOT NULL);
                CREATE TABLE IF NOT EXISTS paged_index_blocks(cluster TEXT NOT NULL,digest TEXT NOT NULL,wire BLOB NOT NULL,PRIMARY KEY(cluster,digest));
                CREATE TABLE IF NOT EXISTS paged_index_head(singleton INTEGER PRIMARY KEY CHECK(singleton=1),transaction_bytes BLOB NOT NULL);
            ''')
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                old = self.db.execute('SELECT context,ciphertext FROM paged_index_pin').fetchone()
                if old is None:
                    self.directory.refresh(self.writer.publication.address)
                    with self.directory.lock:
                        self.directory.anchor()
                        state = json.loads(canonical(self.directory.current['state']))
                    occupied = page_occupancy(self.writer, state, document['page_clusters'])
                    cache = PageCipherCache(self.cache_path, {'network': self.directory.network, 'genesis': self.directory.pin,
                        'publisher': document['publisher']}, document['page_clusters'], occupied=occupied)
                    try:
                        plan = build_index(self.prototype, document['entries'], document['members'], cache.seal,
                            guild_id=document['guild_id'], public=document['public'], closed=document['closed'])
                    finally: cache.close()
                    ref = plan['reference']
                    record = head_record(self.key, self.directory.network, self.directory.pin, document['source'], document['scope'],
                        ref['cluster'], ref['digest'], ref['size'], tree.root, len(current), sum(current.values()),
                        version=document['generation'], previous=document['previous'], updates=self.updates)
                    transaction = {**record, 'updates': self.updates}
                    encrypted_input = encrypt_bytes(raw)
                    if len(encrypted_input) + sum(map(len, plan['blocks'].values())) + len(canonical(transaction)) > byte_limit:
                        raise ValueError('paged_index_generation_disk_budget_exhausted')
                    self.db.execute('INSERT INTO paged_index_pin VALUES(1,?,?)', (self.token, encrypted_input))
                    self.db.executemany('INSERT INTO paged_index_blocks VALUES(?,?,?)', [(cluster, digest, wire) for (cluster, digest), wire in plan['blocks'].items()])
                    self.db.execute('INSERT INTO paged_index_head VALUES(1,?)', (canonical(transaction),))
                elif old[0] != self.token:
                    raise ValueError('paged_index_context_changed')
                elif decrypt_bytes(bytes(old[1])) != raw:
                    raise ValueError('paged_index_input_corrupt')
            self.validate_plan()
        except BaseException as exc:
            if self.db is not None: self.db.close()
            if self.quota is not None: self.quota.close()
            if isinstance(exc, sqlite3.OperationalError) and is_full(exc):
                raise ValueError('paged_index_generation_disk_budget_exhausted') from exc
            raise

    @staticmethod
    def queries(entries):
        queries, sizes = {}, {}
        for entry in entries:
            cluster, digest, size = entry['cluster'], entry['digest'], entry['size']
            if (not digest64(cluster) or not digest64(digest) or type(size) is not int or not 1 <= size <= 262144 or
                    (digest in sizes and sizes[digest] != size)):
                raise ValueError('paged_index_conflicting_size')
            sizes[digest] = size
            queries.setdefault(cluster, {})[digest] = size
        return queries

    def validate_plan(self):
        row = self.db.execute('SELECT transaction_bytes FROM paged_index_head').fetchone()
        if row is None: raise ValueError('paged_index_head_missing')
        raw = bytes(row[0]); transaction = json.loads(raw)
        if set(transaction) != {'body', 'signature', 'updates'} or canonical(transaction) != raw:
            raise ValueError('paged_index_head_corrupt')
        record = {key: transaction[key] for key in ('body', 'signature')}
        body, _ = validate_head(record, self.directory.network, self.directory.pin)
        if (canonical(transaction['updates']) != canonical(self.updates) or body['updates_hash'] != updates_digest(transaction['updates']) or
                any(body[key] != value for key, value in self.prototype.items() if key not in {'cluster', 'digest', 'size'}) or
                body['cluster'] not in self.document['page_clusters']):
            raise ValueError('paged_index_head_context_changed')
        blocks = {(cluster, digest): bytes(wire) for cluster, digest, wire in self.db.execute('SELECT cluster,digest,wire FROM paged_index_blocks')}
        used, entries = set(), []
        def load(ref):
            key = ref['cluster'], ref['digest']
            if key not in blocks or key in used or ref['cluster'] not in self.document['page_clusters']:
                raise ValueError('paged_index_block_missing_or_reused')
            used.add(key)
            return PagedIndexReader.unpack(blocks[key], ref, decrypt_bytes)
        doc = load(body); validate_index(doc, body)
        for key in ('members', 'closed', 'public', 'guild_id'):
            if canonical(doc[key]) != canonical(self.document[key]): raise ValueError('paged_index_acl_changed')
        def visit(ref):
            page = validate_page(load(ref), ref, context(body))
            entries.extend({key: value for key, value in entry.items() if key != 'path'} for entry in page['entries'])
            for child in page['children']: visit(child)
        if doc['page'] is not None: visit(doc['page'])
        from sfera_mesh.recovery_timeline import validate_complete
        validate_complete(doc, entries, load)
        if entries != self.document['entries'] or used != set(blocks): raise ValueError('paged_index_omission_or_extra_blocks')
        self.transaction, self.target, self.blocks = transaction, body, blocks

    def close(self):
        with self.lock:
            try: self.db.close()
            finally:
                if self.quota is not None: self.quota.close()

    def step(self):
        with self.lock:
            if not self.process_lock.acquire(): return {'state': 'busy'}
            try:
                self.validate_plan()
                self.directory.refresh(self.writer.publication.address)
                with self.directory.lock:
                    self.directory.anchor()
                    state = json.loads(canonical(self.directory.current['state']))
                old = state.get('recovery_trees', {}).get(self.identity)
                record = {key: self.transaction[key] for key in ('body', 'signature')}
                same = old and old['digest'] == sha256(canonical(record)).hexdigest()
                legacy = state.get('recovery_roots', {}).get(self.identity)
                if legacy and not old and not self.allow_migration:
                    return {'state': 'conflict', 'error': 'paged_index_migration_requires_explicit_opt_in'}
                prior = old or legacy
                if not same:
                    if (self.target['previous'], self.target['version']) != (prior['digest'] if prior else '0' * 64,
                            prior['record']['body']['version'] + 1 if prior else 1):
                        return {'state': 'conflict', 'error': 'recovery_tree_head_changed'}
                    expected = old['record']['body']['root'] if old else (RecoveryTree(legacy['record']['body']['messages'], legacy['record']['body']['deleted']).root if legacy else RecoveryTree().root)
                    if self.previous.root != expected or (legacy and not old and self.updates):
                        return {'state': 'conflict', 'error': 'recovery_tree_registry_changed'}
                for cluster, sizes in self.body_queries.items(): self.writer.confirm_sizes(cluster, sizes)
                exhausted = page_capacity(self.writer, state, self.blocks)
                if exhausted:
                    return {'state': 'blocked', 'phase': 'page_capacity',
                        'error': 'paged_index_cluster_capacity_exhausted', 'clusters': exhausted}
                ids = []
                for (cluster, digest), wire in sorted(self.blocks.items()):
                    block = 'recovery-page:' + cluster + ':' + digest
                    self.writer.append('recovery-pages:' + self.identity, block, cluster, [bytes.fromhex(json.loads(wire)[0])])
                    ids.append(block)
                # New writers require one confirmed atomic reservation before
                # any per-cluster manifest publication. Compatibility adapters
                # retain the explicitly legacy publication path.
                queue = getattr(self.writer, 'queue', None)
                if queue is not None and getattr(queue, 'content_bound', False):
                    reserved = self.writer.reserve_many(ids)
                    if reserved['state'] != 'queued':
                        return {**reserved, 'phase': 'page_reservation'}
                for cluster in sorted({cluster for cluster, _ in self.blocks}): self.writer.step(cluster)
                for offset in range(0, len(ids), 512):
                    receipts = self.writer.status_many(ids[offset:offset + 512])
                    for block in ids[offset:offset + 512]:
                        receipt = receipts.get(block, {})
                        if receipt.get('state') != 'confirmed' or receipt.get('digest') != block.rsplit(':', 1)[1]:
                            return {'state': 'waiting', 'phase': 'page_inclusion'}
                # A status adapter cannot turn a local enqueue into inclusion.
                # Recheck exact sized references against the fresh BFT manifests
                # before opening the immutable head outbox.
                page_queries = {}
                for (cluster, digest), wire in self.blocks.items(): page_queries.setdefault(cluster, {})[digest] = len(wire)
                try:
                    for cluster, sizes in page_queries.items(): self.writer.confirm_sizes(cluster, sizes)
                except ValueError:
                    return {'state': 'waiting', 'phase': 'page_inclusion'}
                quota = claim(self.path + '.root.sqlite', 1048576)
                try:
                    publisher = RecoveryTreePublisher(self.path + '.root.sqlite', self.directory, self.writer.publication.address,
                        self.transaction, database_bytes=1048576)
                    try: return {**publisher.step(), 'phase': 'recovery_tree'}
                    finally: publisher.close()
                finally:
                    if quota is not None: quota.close()
            finally: self.process_lock.release()
