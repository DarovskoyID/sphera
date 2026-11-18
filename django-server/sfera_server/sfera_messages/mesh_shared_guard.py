"""Bounded, authenticated SQL-check receipts shared by local HTTP processes."""
from contextlib import contextmanager
import json
import math
import os
from pathlib import Path
import sqlite3
from time import time as walltime

from cryptography.fernet import InvalidToken
from django.conf import settings

from sfera_mesh.storage import canonical
from .encryption import encrypt_bytes, decrypt_bytes
from .mesh_index_disk import claim, guard_database, check_paths

DOMAIN = 'sfera-mesh-shared-sql-check-v1'
MAX_BYTES, MAX_VALUES = 2 * 1048576, 256


class SharedGuard:
    def __init__(self, path):
        if not isinstance(path, (str, Path)): raise ValueError('invalid_shared_guard_path')
        target = Path(path)
        if not target.is_absolute() or target.is_symlink(): raise ValueError('invalid_shared_guard_path')
        check_paths(path)
        self.path = target.resolve()
        databases = {os.path.normcase(str(Path(db['NAME']).resolve())) for db in settings.DATABASES.values()
            if db.get('ENGINE', '').endswith('sqlite3') and db.get('NAME') and db['NAME'] != ':memory:'}
        if (os.path.normcase(str(self.path)) in databases or
                (self.path.exists() and (not self.path.is_file() or self.path.stat().st_nlink != 1))):
            raise ValueError('unsafe_shared_guard_path')

    @contextmanager
    def transaction(self):
        quota = claim(self.path, MAX_BYTES)
        db = None
        try:
            db = sqlite3.connect(self.path, timeout=0.25)
            guard_database(db, MAX_BYTES)
            names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")}
            if names and names != {'shared_guard_meta', 'shared_guard_values'}:
                raise ValueError('foreign_shared_guard_database')
            size = db.execute('PRAGMA page_size').fetchone()[0]
            if db.execute('PRAGMA page_count').fetchone()[0] * size > MAX_BYTES:
                raise ValueError('shared_guard_disk_limit')
            db.execute('PRAGMA max_page_count=' + str(MAX_BYTES // size))
            db.execute('PRAGMA synchronous=FULL')
            # Keep sidecars bounded; this cache does not use persistent WAL.
            if db.execute('PRAGMA journal_mode').fetchone()[0].lower() != 'delete':
                raise ValueError('shared_guard_delete_journal_required')
            with db:
                db.execute('BEGIN IMMEDIATE')
                db.execute('CREATE TABLE IF NOT EXISTS shared_guard_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),value BLOB NOT NULL)')
                db.execute('CREATE TABLE IF NOT EXISTS shared_guard_values(key TEXT PRIMARY KEY,value BLOB NOT NULL,touched REAL NOT NULL)')
                now = walltime()
                if not math.isfinite(now) or now < 0: raise ValueError('shared_guard_clock_invalid')
                row = db.execute('SELECT value FROM shared_guard_meta WHERE singleton=1').fetchone()
                if row:
                    meta = self.decode(row[0])
                    if (set(meta) != {'domain', 'clock'} or meta['domain'] != DOMAIN or
                            type(meta['clock']) not in (int, float) or not math.isfinite(meta['clock'])):
                        raise ValueError('shared_guard_context_corrupt')
                    if now < meta['clock']: raise ValueError('shared_guard_clock_rollback')
                db.execute('INSERT OR REPLACE INTO shared_guard_meta VALUES(1,?)',
                    (encrypt_bytes(canonical({'domain': DOMAIN, 'clock': now})),))
                yield db, now
        except InvalidToken as exc:
            raise ValueError('shared_guard_context_unreadable') from exc
        finally:
            if db is not None: db.close()
            if quota is not None: quota.close()

    @staticmethod
    def decode(raw):
        value = decrypt_bytes(bytes(raw))
        parsed = json.loads(value)
        if not isinstance(parsed, dict) or canonical(parsed) != value: raise ValueError('shared_guard_value_corrupt')
        return parsed

    def load(self, db, key, total, now):
        row = db.execute('SELECT value FROM shared_guard_values WHERE key=?', (key,)).fetchone()
        if row is None: return None
        try:
            value = self.decode(row[0])
            if (set(value) != {'domain', 'key', 'total', 'position', 'ready', 'issued', 'expires'} or
                    value['domain'] != DOMAIN or value['key'] != key or value['total'] != total or
                    type(value['total']) is not int or type(value['position']) is not int or
                    not 0 <= value['position'] <= total or type(value['ready']) is not bool or
                    (value['ready'] and value['position'] != total) or
                    type(value['issued']) not in (int, float) or type(value['expires']) not in (int, float) or
                    not value['issued'] <= now < value['expires'] or
                    value['expires'] - value['issued'] > (30 if value['ready'] else 120)):
                raise ValueError('shared_guard_value_corrupt')
            return value
        except (ValueError, InvalidToken, TypeError):
            # A damaged receipt grants no authority to skip verification.
            db.execute('DELETE FROM shared_guard_values WHERE key=?', (key,))
            return None

    @staticmethod
    def identity(key, total):
        if not isinstance(key, bytes) or len(key) != 32 or type(total) is not int or not 0 <= total <= 100000:
            raise ValueError('invalid_shared_guard_query')
        return key.hex()

    def get(self, key, total):
        token = self.identity(key, total)
        with self.transaction() as (db, now):
            value = self.load(db, token, total, now)
            if value is not None: db.execute('UPDATE shared_guard_values SET touched=? WHERE key=?', (now, token))
            return (value['ready'], value['position']) if value else (False, 0)

    def advance(self, key, total, position, *, ready=False):
        token = self.identity(key, total)
        if type(position) is not int or not 0 <= position <= total or type(ready) is not bool or (ready and position != total):
            raise ValueError('invalid_shared_guard_position')
        with self.transaction() as (db, now):
            old = self.load(db, token, total, now)
            if old and (old['ready'] or (not ready and old['position'] >= position)):
                return old['ready']
            value = {'domain': DOMAIN, 'key': token, 'total': total, 'position': position, 'ready': ready,
                'issued': now, 'expires': now + (30 if ready else 120)}
            db.execute('INSERT OR REPLACE INTO shared_guard_values VALUES(?,?,?)', (token, encrypt_bytes(canonical(value)), now))
            count = db.execute('SELECT COUNT(*) FROM shared_guard_values').fetchone()[0]
            if count > MAX_VALUES:
                db.execute('DELETE FROM shared_guard_values WHERE key IN (SELECT key FROM shared_guard_values ORDER BY touched,key LIMIT ?)',
                    (count - MAX_VALUES,))
            return ready
