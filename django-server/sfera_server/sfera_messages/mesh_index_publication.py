"""Immutable, restartable publication of one typed history-index generation.

The caller supplies an explicit complete snapshot and ACL. This component never
infers deletions or membership from missing application rows.
"""
from hashlib import sha256
from contextlib import ExitStack
import json
from pathlib import Path
import sqlite3
import threading

from django.conf import settings

from sfera_mesh.directory import ZERO
from sfera_mesh.identity import node_id
from sfera_mesh.recovery_publisher import RecoveryPublisher
from sfera_mesh.recovery_roots import namespace, root_record, check_progress
from sfera_mesh.refresh_lock import RefreshLock
from sfera_mesh.storage import canonical
from .encryption import encrypt_bytes, decrypt_bytes
from .mesh_recovery_index import validate_document
from .mesh_index_disk import claim, check_paths
from .mesh_index_budget import cap_database


class IndexPublication:
    def __init__(self, path, writer, document):
        self.writer = writer
        self.directory = writer.publication.directory
        self.key = writer.publication.journal.key
        publisher = node_id(self.key.public_key().public_bytes_raw())
        document = json.loads(canonical(document))
        entries = document.get('entries', [])
        self.target = root_record(self.key, self.directory.network, self.directory.pin,
            document.get('source'), document.get('scope'), document.get('cluster'), ZERO, 1,
            version=document.get('generation'), previous=document.get('previous'),
            messages=[entry['message_id'] for entry in entries],
            deleted=[entry['message_id'] for entry in entries if entry['deleted']])['body']
        validate_document(document, self.target)
        if document['publisher'] != publisher:
            raise ValueError('message_mesh_index_publisher_changed')
        raw = canonical(document)
        if len(raw) > 97000:
            raise ValueError('message_mesh_index_byte_limit')
        self.document, self.raw = document, raw
        self.identity = namespace(publisher, document['source'], document['scope'])
        self.lock = threading.RLock()
        if str(path) == ':memory:':
            raise ValueError('durable_message_mesh_index_path_required')
        check_paths(path)
        self.path = str(Path(path).resolve())
        import os
        app_databases = {os.path.normcase(str(Path(db['NAME']).resolve())) for db in settings.DATABASES.values()
            if db.get('ENGINE', '').endswith('sqlite3') and db.get('NAME') and db['NAME'] != ':memory:'}
        if {os.path.normcase(self.path), os.path.normcase(str(Path(self.path + '.root.sqlite').resolve()))} & app_databases:
            raise ValueError('message_mesh_files_must_not_be_application_database')
        self.process_lock = RefreshLock(self.path + '.index.lock')
        self.quota = claim(self.path, 1048576, extra={self.path + '.root.sqlite': 1048576})
        self.db = None
        try:
            self.db = sqlite3.connect(self.path, check_same_thread=False)
            names = {row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")}
            if names and names != {'message_mesh_index_job'}:
                raise ValueError('foreign_message_mesh_index_database')
            cap_database(self.db, 1048576)
            self.db.execute('PRAGMA synchronous=FULL')
            self.db.execute('CREATE TABLE IF NOT EXISTS message_mesh_index_job(singleton INTEGER PRIMARY KEY CHECK(singleton=1), context TEXT NOT NULL, ciphertext BLOB NOT NULL)')
            context = sha256(raw).hexdigest()
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                row = self.db.execute('SELECT context,ciphertext FROM message_mesh_index_job').fetchone()
                if row is None:
                    data = encrypt_bytes(raw)
                    self.db.execute('INSERT INTO message_mesh_index_job VALUES(1,?,?)', (context, data))
                else:
                    if row[0] != context:
                        raise ValueError('message_mesh_index_job_context_changed')
                    data = bytes(row[1])
                    if decrypt_bytes(data) != raw:
                        raise ValueError('message_mesh_index_job_corrupt')
            self.data = data
            wire = canonical([data.hex()])
            if len(wire) > 262144:
                raise ValueError('message_mesh_index_byte_limit')
            self.target.update(digest=sha256(wire).hexdigest(), size=len(wire))
            self.block_id = 'recovery-index:' + context
        except BaseException:
            if self.db is not None: self.db.close()
            if self.quota is not None: self.quota.close()
            raise

    def close(self):
        with self.lock:
            try: self.db.close()
            finally:
                if self.quota is not None: self.quota.close()

    def step(self):
        with self.lock:
            if not self.process_lock.acquire():
                return {'state': 'busy'}
            try:
                self.directory.refresh(self.writer.publication.address)
                with self.directory.lock:
                    self.directory.anchor()
                    state = json.loads(canonical(self.directory.current['state']))
                old = state.get('recovery_roots', {}).get(self.identity)
                same = old and old['record']['body'] == self.target
                if not same and ((old['digest'] if old else ZERO) != self.target['previous'] or
                        self.target['version'] != (old['record']['body']['version'] + 1 if old else 1)):
                    return {'state': 'conflict', 'error': 'recovery_root_head_changed'}
                record = {'body': self.target, 'signature': self.key.sign(canonical(self.target)).hex()}
                check_progress(state, {**state, 'recovery_roots': {**state.get('recovery_roots', {}),
                    self.identity: {'record': record, 'digest': sha256(canonical(record)).hexdigest()}}})
                # All message bodies must already be confirmed. The index itself
                # then follows the same three-holder/BFT publication path.
                sizes = {entry['digest']: entry['size'] for entry in self.document['entries']}
                if sizes:
                    self.writer.confirm_sizes(self.target['cluster'], sizes)
                self.writer.append('recovery-index:' + self.identity, self.block_id, self.target['cluster'], [self.data])
                self.writer.step(self.target['cluster'])
                receipt = self.writer.status_many([self.block_id]).get(self.block_id, {})
                if receipt.get('state') != 'confirmed' or receipt.get('digest') != self.target['digest']:
                    return {'state': 'waiting', 'phase': 'index_inclusion'}
                with ExitStack() as cleanup:
                    quota = claim(self.path + '.root.sqlite', 1048576)
                    if quota is not None: cleanup.callback(quota.close)
                    with_publisher = RecoveryPublisher(self.path + '.root.sqlite', self.directory,
                        self.writer.publication.address, self.key, source=self.target['source'], scope=self.target['scope'],
                        cluster=self.target['cluster'], block_digest=self.target['digest'], size=self.target['size'],
                        messages=self.target['messages'], deleted=self.target['deleted'], expected_previous=self.target['previous'],
                        database_bytes=1048576)
                    cleanup.callback(with_publisher.close)
                    result = with_publisher.step()
                    if result['state'] == 'confirmed' and result['version'] != self.target['version']:
                        raise ValueError('message_mesh_index_generation_changed')
                    return {**result, 'phase': 'recovery_root'}
            finally:
                self.process_lock.release()
