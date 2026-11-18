"""SQLite page budgets for recovery files; never used for application databases."""
import sqlite3
from hashlib import sha256
from pathlib import Path
import re

from django.conf import settings


def byte_budget(setting, default, *, maximum=4 * 1024**3):
    limit = getattr(settings, setting, default)
    if type(limit) is not int or not 65536 <= limit <= maximum:
        raise ValueError('invalid_paged_index_disk_budget')
    return limit


def database_budget(db, setting, default):
    limit = byte_budget(setting, default)
    return cap_database(db, limit)


def cap_database(db, limit):
    from .mesh_index_disk import guard_database
    guard_database(db, limit)
    page_size = db.execute('PRAGMA page_size').fetchone()[0]
    # Existing files can still be read/retried after lowering a budget. SQLite
    # cannot lower this below the current page count; admission checks below
    # reject new payload while allowing exact ciphertext reuse.
    db.execute('PRAGMA max_page_count=' + str(limit // page_size))
    return limit


def is_full(exc):
    return getattr(exc, 'sqlite_errorcode', None) == sqlite3.SQLITE_FULL


def family_budget(controller, document):
    try: return _family_budget(controller, document)
    except OSError as exc:
        raise ValueError('paged_index_family_inventory_unavailable') from exc


def _family_budget(controller, document):
    """Reserve an automatic controller family before freezing a new input.

    The controller's lifetime OS lock serializes admission. Existing plans and
    durable pending inputs are reservations; no expiry can free a pending job.
    Main-file caps plus conservative journal headroom are reserved in advance.
    """
    from sfera_mesh.storage import canonical
    limit = byte_budget('SFERA_MESH_MESSAGE_INDEX_FAMILY_BYTES', 2 * 1024**3, maximum=64 * 1024**3)
    generation = byte_budget('SFERA_MESH_MESSAGE_INDEX_GENERATION_BYTES', 64 * 1048576)
    cache = byte_budget('SFERA_MESH_MESSAGE_INDEX_CACHE_BYTES', 256 * 1048576)
    metadata = byte_budget('SFERA_MESH_MESSAGE_INDEX_CONTROLLER_BYTES', 64 * 1048576)
    base = Path(controller.path)
    parent = base.parent.resolve()
    pattern = re.compile(re.escape(base.name) + r'\.([0-9a-f]{64})\.sqlite(?:\.root\.sqlite)?(?:-journal|-wal|-shm|\.paged-index\.lock|\.recovery-tree\.lock)?\Z')
    plans, used = {}, {'controller': 0, 'cache': 0, 'other': 0}
    actual, count = 0, 0
    for path in parent.iterdir():
        if path.name != base.name and not path.name.startswith((base.name + '.', base.name + '-')): continue
        count += 1
        if count > 32768: raise ValueError('paged_index_family_inventory_limit')
        if path.is_symlink() or path.resolve().parent != parent or not path.is_file():
            raise ValueError('paged_index_family_unsafe_path')
        size = path.stat().st_size; actual += size
        match = pattern.fullmatch(path.name)
        if match and not path.name.endswith('.lock'):
            plans[match[1]] = plans.get(match[1], 0) + size
        elif path.name in {base.name + suffix for suffix in ('', '-journal', '-wal', '-shm')}:
            used['controller'] += size
        elif path.name in {base.name + '.page-cache.sqlite' + suffix for suffix in ('', '-journal', '-wal', '-shm')}:
            used['cache'] += size
        else: used['other'] += size
    for (identity,) in controller.db.execute('SELECT identity FROM automatic_index_scopes'):
        stored = controller._stored(identity)
        if stored is not None and stored[2] is None:
            plans.setdefault(sha256(canonical(stored[0])).hexdigest(), 0)
    plans.setdefault(sha256(canonical(document)).hexdigest(), 0)
    # 3x covers the bounded main file and rollback/checkpoint working space;
    # the root outbox has one <=64 KiB transaction, reserved with 1 MiB overhead.
    reserved = (max(used['controller'], 3 * metadata) + max(used['cache'], 3 * cache) + used['other'] +
        sum(max(size, 3 * generation + 1048576) for size in plans.values()))
    if reserved > limit: raise ValueError('paged_index_family_disk_budget_exhausted')
    return {'actual_bytes': actual, 'reserved_bytes': reserved, 'limit': limit, 'generations': len(plans)}
