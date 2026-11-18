"""Durable ciphertext reuse for immutable recovery pages, scoped to one publisher."""
from hashlib import sha256
from pathlib import Path
import sqlite3

from sfera_mesh.directory import digest64
from sfera_mesh.storage import canonical
from .encryption import encrypt_bytes, decrypt_bytes
from .mesh_page_capacity import MANIFEST_SLOTS
from .mesh_index_budget import database_budget, byte_budget, is_full
from .mesh_index_disk import claim


class PageCipherCache:
    def __init__(self, path, context, clusters, *, occupied=None):
        if not Path(path).is_absolute() or not isinstance(clusters, list) or not 1 <= len(clusters) <= 128 or any(not digest64(cluster) for cluster in clusters):
            raise ValueError('invalid_paged_cache_configuration')
        if len(set(clusters)) != len(clusters): raise ValueError('invalid_paged_cache_configuration')
        self.clusters, self.cursor = clusters[:], 0
        self.occupied = {cluster: set((occupied or {}).get(cluster, ())) for cluster in clusters}
        if any(not digest64(digest) for values in self.occupied.values() for digest in values):
            raise ValueError('invalid_paged_capacity_digest')
        self.quota = claim(path, byte_budget('SFERA_MESH_MESSAGE_INDEX_CACHE_BYTES', 256 * 1048576))
        self.db = None
        try:
            self.db = sqlite3.connect(path)
            names = {row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")}
            if names and names != {'page_cache_pin', 'page_cache_values'}: raise ValueError('foreign_paged_cache_database')
            self.byte_limit = database_budget(self.db, 'SFERA_MESH_MESSAGE_INDEX_CACHE_BYTES', 256 * 1048576)
            self.db.execute('PRAGMA synchronous=FULL')
            self.db.executescript('''
                CREATE TABLE IF NOT EXISTS page_cache_pin(singleton INTEGER PRIMARY KEY CHECK(singleton=1),context BLOB NOT NULL);
                CREATE TABLE IF NOT EXISTS page_cache_values(plaintext_hash TEXT NOT NULL,cluster TEXT NOT NULL,ciphertext BLOB NOT NULL,PRIMARY KEY(plaintext_hash,cluster));
            ''')
            raw = canonical(context)
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                columns = {row[1] for row in self.db.execute('PRAGMA table_info(page_cache_values)')}
                if 'wire_digest' not in columns:
                    self.db.execute('ALTER TABLE page_cache_values ADD COLUMN wire_digest TEXT')
                for rowid, ciphertext in self.db.execute('SELECT rowid,ciphertext FROM page_cache_values WHERE wire_digest IS NULL').fetchall():
                    self.db.execute('UPDATE page_cache_values SET wire_digest=? WHERE rowid=?',
                        (sha256(canonical([bytes(ciphertext).hex()])).hexdigest(), rowid))
                old = self.db.execute('SELECT context FROM page_cache_pin').fetchone()
                if old and bytes(old[0]) != raw: raise ValueError('paged_cache_context_changed')
                self.db.execute('INSERT OR IGNORE INTO page_cache_pin VALUES(1,?)', (raw,))
        except BaseException as exc:
            if self.db is not None: self.db.close()
            if self.quota is not None: self.quota.close()
            if isinstance(exc, sqlite3.OperationalError) and is_full(exc):
                raise ValueError('paged_index_cache_disk_budget_exhausted') from exc
            raise

    def close(self):
        try: self.db.close()
        finally:
            if self.quota is not None: self.quota.close()

    def seal(self, raw):
        try: return self._seal(raw)
        except sqlite3.OperationalError as exc:
            if is_full(exc): raise ValueError('paged_index_cache_disk_budget_exhausted') from exc
            raise

    def _seal(self, raw):
        if not isinstance(raw, bytes) or len(raw) > 97000: raise ValueError('paged_cache_plaintext_limit')
        digest = sha256(raw).hexdigest()
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            rows = {cluster: bytes(ciphertext) for cluster, ciphertext in self.db.execute(
                'SELECT cluster,ciphertext FROM page_cache_values WHERE plaintext_hash=? AND cluster IN (' +
                ','.join('?' for _ in self.clusters) + ')', [digest, *self.clusters])}
            for cluster in self.clusters:
                if cluster in rows:
                    if decrypt_bytes(rows[cluster]) != raw: raise ValueError('paged_cache_ciphertext_corrupt')
                    return cluster, rows[cluster]
            # BEGIN IMMEDIATE serializes admission across users of this cache.
            # Cached ciphertext is a durable, conservative slot reservation,
            # including pages from unfinished generations after a restart.
            cluster = None
            for offset in range(len(self.clusters)):
                candidate = self.clusters[(self.cursor + offset) % len(self.clusters)]
                reserved = {row[0] for row in self.db.execute(
                    'SELECT wire_digest FROM page_cache_values WHERE cluster=?', (candidate,))}
                if any(not digest64(value) for value in reserved): raise ValueError('paged_cache_reservation_corrupt')
                if len(reserved | self.occupied[candidate]) < MANIFEST_SLOTS:
                    cluster = candidate
                    self.cursor = (self.cursor + offset + 1) % len(self.clusters)
                    break
            if cluster is None: raise ValueError('paged_index_page_pool_capacity_exhausted')
            ciphertext = encrypt_bytes(raw)
            used = self.db.execute('SELECT COALESCE(SUM(length(ciphertext)),0) FROM page_cache_values').fetchone()[0]
            if used + len(ciphertext) > self.byte_limit:
                raise ValueError('paged_index_cache_disk_budget_exhausted')
            wire_digest = sha256(canonical([ciphertext.hex()])).hexdigest()
            self.db.execute('INSERT INTO page_cache_values(plaintext_hash,cluster,ciphertext,wire_digest) VALUES(?,?,?,?)',
                (digest, cluster, ciphertext, wire_digest))
            return cluster, ciphertext
