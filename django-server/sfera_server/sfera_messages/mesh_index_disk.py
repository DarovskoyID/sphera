"""Shared, durable admission budget for recovery SQLite files and sidecars.

Reservations are maxima, not free-space promises or an OS filesystem quota.
Every managed connection holds a non-expiring OS lease. Missing files alone
never free a reservation belonging to an open or crashed publication.
"""
from contextlib import contextmanager
import os
from pathlib import Path
import sqlite3

from django.conf import settings
from sfera_mesh.refresh_lock import RefreshLock

SIDECARS = ('', '-journal', '-wal', '-shm')
GENERATED = SIDECARS[1:] + ('.disk-quota.lock', '.disk-registry.lock', '.paged-index.lock',
    '.recovery-tree.lock', '.recovery-root.lock', '.index.lock', '.automatic-index.lock', '.migration.lock')
REGISTRY_BYTES = 4 * 1048576
OVERHEAD = 1048576
MAX_FILES = 4096
RETIRED_LOCK_BYTES = 128 * 1024


def configured(*, required=False):
    value = getattr(settings, 'SFERA_MESH_MESSAGE_INDEX_DISK_STATE', '')
    if not value:
        if required: raise ValueError('paged_index_shared_disk_budget_required')
        return None
    path = safe_path(value)
    limit = getattr(settings, 'SFERA_MESH_MESSAGE_INDEX_DISK_BYTES', 64 * 1024**3)
    if type(limit) is not int or not 16 * 1048576 <= limit <= 1024**4:
        raise ValueError('invalid_paged_index_shared_disk_budget')
    return path, limit


def safe_path(value):
    path = Path(value)
    if not path.is_absolute() or len(str(path)) > 1024 or not path.parent.is_dir():
        raise ValueError('paged_disk_absolute_existing_parent_required')
    for part in (path, *path.parents):
        if part.is_symlink() or getattr(part, 'is_junction', lambda: False)():
            raise ValueError('paged_disk_unsafe_path')
    path = path.resolve()
    app_paths = {os.path.normcase(str(Path(db['NAME']).resolve())) + suffix for db in settings.DATABASES.values()
        for suffix in SIDECARS
        if db.get('ENGINE', '').endswith('sqlite3') and db.get('NAME') and db['NAME'] != ':memory:'}
    for suffix in SIDECARS + ('.disk-quota.lock', '.disk-registry.lock'):
        item = Path(str(path) + suffix)
        if os.path.normcase(str(item)) in app_paths:
            raise ValueError('message_mesh_files_must_not_be_application_database')
        if item.is_symlink() or (item.exists() and (not item.is_file() or item.stat().st_nlink != 1)):
            raise ValueError('paged_disk_unsafe_path')
    return path


def reservation(size):
    if type(size) is not int or not 65536 <= size <= 4 * 1024**3:
        raise ValueError('invalid_paged_disk_file_limit')
    return 3 * size + OVERHEAD


def check_paths(*paths):
    if configured() is not None:
        for path in paths:
            if path is not None: safe_path(path)


@contextmanager
def registry(*, resize=False):
    state, limit = configured(required=True)
    lock = RefreshLock(str(state) + '.disk-registry.lock')
    if not lock.acquire(): raise ValueError('paged_disk_registry_busy')
    db = None
    try:
        safe_path(state)
        db = sqlite3.connect(state)
        names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")}
        if names and names != {'disk_budget_pin', 'disk_budget_files'}:
            raise ValueError('foreign_paged_disk_registry')
        if db.execute('PRAGMA journal_mode').fetchone()[0] != 'delete':
            raise ValueError('paged_disk_rollback_journal_required')
        if db.execute('PRAGMA page_count').fetchone()[0] * db.execute('PRAGMA page_size').fetchone()[0] > REGISTRY_BYTES:
            raise ValueError('paged_disk_registry_limit')
        db.execute('PRAGMA max_page_count=' + str(REGISTRY_BYTES // db.execute('PRAGMA page_size').fetchone()[0]))
        db.execute('PRAGMA synchronous=FULL')
        db.execute('PRAGMA temp_store=MEMORY')
        db.executescript('''
            CREATE TABLE IF NOT EXISTS disk_budget_pin(singleton INTEGER PRIMARY KEY CHECK(singleton=1),bytes INTEGER NOT NULL,retired_locks INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS disk_budget_files(path TEXT PRIMARY KEY,bytes INTEGER NOT NULL);
        ''')
        db.execute('BEGIN IMMEDIATE')
        old = db.execute('SELECT bytes,retired_locks FROM disk_budget_pin').fetchone()
        retired = old[1] if old else 0
        if type(retired) is not int or not 0 <= retired <= 1024**4 // RETIRED_LOCK_BYTES:
            raise ValueError('paged_disk_registry_corrupt')
        if old and old[0] != limit and not resize:
            raise ValueError('paged_disk_budget_configuration_changed')
        db.execute('INSERT OR IGNORE INTO disk_budget_pin VALUES(1,?,0)', (limit,))
        rows = dict(db.execute('SELECT path,bytes FROM disk_budget_files'))
        if len(rows) > MAX_FILES: raise ValueError('paged_disk_registry_limit')
        for path, size in rows.items():
            if os.path.normcase(str(safe_path(path))) != path or Path(path) == state:
                raise ValueError('paged_disk_registry_corrupt')
            maximum = reservation(size)
            actual = sum(Path(path + suffix).stat().st_size for suffix in SIDECARS if Path(path + suffix).exists())
            if actual > maximum: raise ValueError('paged_disk_file_budget_exceeded')
        yield db, rows, limit, state, retired
        db.commit()
    finally:
        if db is not None: db.close()
        lock.release()


def total(rows, retired=0):
    return reservation(REGISTRY_BYTES) + retired * RETIRED_LOCK_BYTES + sum(reservation(size) for size in rows.values())


class Lease:
    def __init__(self, lock): self.lock = lock
    def close(self): self.lock.release()


def claim(path, size, *, extra=None):
    """Atomically reserve all maxima and create placeholders before returning.

    A crash before the registry commit leaves only empty unregistered files;
    SQLite opens/writes occur only after this function returns. The primary
    file lease remains held until its connection closes.
    """
    if configured() is None: return None
    path = safe_path(path)
    lock = RefreshLock(str(path) + '.disk-quota.lock')
    try:
        planned = {os.path.normcase(str(path)): size}
        for target, maximum in (extra or {}).items():
            target = os.path.normcase(str(safe_path(target)))
            if target in planned and planned[target] != maximum: raise ValueError('paged_disk_conflicting_limits')
            planned[target] = maximum
        with registry() as (db, rows, limit, state, retired):
            state_name = os.path.normcase(str(state))
            all_paths = set(rows) | set(planned)
            for name, maximum in planned.items():
                reservation(maximum)
                if name == state_name or name in {state_name + suffix for suffix in GENERATED}:
                    raise ValueError('paged_disk_registry_is_not_payload')
                if any(name != other and (name in {other + suffix for suffix in GENERATED} or
                        other in {name + suffix for suffix in GENERATED}) for other in all_paths):
                    raise ValueError('paged_disk_overlapping_files')
                if name in rows and rows[name] != maximum:
                    raise ValueError('paged_disk_file_limit_changed')
            combined = {**rows, **planned}
            if len(combined) > MAX_FILES: raise ValueError('paged_disk_registry_limit')
            if total(combined, retired) > limit: raise ValueError('paged_index_shared_disk_budget_exhausted')
            # Nonblocking acquisition under the registry lock avoids creating
            # unlimited lock files for requests already rejected by the quota.
            if not lock.acquire(): raise ValueError('paged_disk_file_busy')
            for name, maximum in planned.items():
                safe_path(name)
                actual = sum(Path(name + suffix).stat().st_size for suffix in SIDECARS if Path(name + suffix).exists())
                if actual > reservation(maximum): raise ValueError('paged_disk_file_budget_exceeded')
                db.execute('INSERT OR IGNORE INTO disk_budget_files VALUES(?,?)', (name, maximum))
            for name in planned:
                if not Path(name).exists():
                    fd = os.open(name, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
                    os.close(fd)
        return Lease(lock)
    except BaseException:
        lock.release(); raise


def guard_database(db, maximum):
    if configured() is None: return
    if db.execute('PRAGMA journal_mode').fetchone()[0] != 'delete':
        raise ValueError('paged_disk_rollback_journal_required')
    if db.execute('PRAGMA page_count').fetchone()[0] * db.execute('PRAGMA page_size').fetchone()[0] > maximum:
        raise ValueError('paged_disk_file_budget_exceeded')
    db.execute('PRAGMA temp_store=MEMORY')


def retire_deleted(paths):
    """Forget only absent files whose connection leases can be acquired.

    Never unlink files, sidecars or locks. A busy/unavailable reservation stays
    charged, including an unlinked file still held open by another process.
    """
    if configured() is None: return 0
    locks, names = [], []
    requested = {os.path.normcase(str(safe_path(path))) for path in paths}
    with registry() as (db, rows, limit, state, retired):
        requested &= set(rows)
    try:
        for path in sorted(requested):
            lock = RefreshLock(path + '.disk-quota.lock')
            if not lock.acquire(): raise ValueError('paged_disk_file_busy')
            locks.append(lock); names.append(os.path.normcase(path))
        with registry() as (db, rows, limit, state, retired):
            if any(Path(name + suffix).exists() for name in names for suffix in SIDECARS):
                raise ValueError('paged_disk_retire_requires_deleted_files')
            count = sum(name in rows for name in names)
            db.executemany('DELETE FROM disk_budget_files WHERE path=?', [(name,) for name in names])
            db.execute('UPDATE disk_budget_pin SET retired_locks=retired_locks+? WHERE singleton=1', (count,))
            return count
    finally:
        for lock in reversed(locks): lock.release()


def status(*, resize=False):
    with registry(resize=resize) as (db, rows, limit, state, retired):
        used = total(rows, retired)
        if used > limit: raise ValueError('paged_index_shared_disk_budget_exhausted')
        if resize: db.execute('UPDATE disk_budget_pin SET bytes=? WHERE singleton=1', (limit,))
        return {'files': len(rows), 'reserved_bytes': used, 'limit_bytes': limit,
            'retired_lock_bytes': retired * RETIRED_LOCK_BYTES}
