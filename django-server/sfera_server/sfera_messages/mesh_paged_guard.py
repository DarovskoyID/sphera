"""Bounded local or shared receipts for SQL-to-page consistency checks.

Only hashes, prefix positions and expiries are retained. Every use reads SQL;
session/account/ACL checks and current BFT root checks remain with the caller.
"""
from collections import OrderedDict
from hashlib import sha256
import threading
import sqlite3
from time import monotonic
from django.conf import settings

from sfera_mesh.storage import canonical

TTL_SECONDS, MAX_RECEIPTS, MAX_ROWS = 30, 128, 50000
CHUNK_BYTES, PROGRESS_SECONDS = 2 * 1048576, 120
_receipts, _lock = OrderedDict(), threading.Lock()
_progress = OrderedDict()


class GuardMismatch(ValueError): pass
class GuardWarming(ValueError): pass


def check_sql_pages(paged, deleted_rows, source_rows):
    try: return _check_sql_pages(paged, deleted_rows, source_rows)
    except ValueError as exc:
        if str(exc) in ('paged_disk_registry_busy', 'paged_disk_file_busy'):
            raise GuardWarming('history_verification_in_progress') from exc
        raise
    except sqlite3.OperationalError as exc:
        if (getattr(exc, 'sqlite_errorcode', 0) & 255) in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
            raise GuardWarming('history_verification_in_progress') from exc
        raise


def _check_sql_pages(paged, deleted_rows, source_rows):
    digest = sha256(canonical({'domain': 'sfera-mesh-live-sql-page-check-v1', 'index': paged.document}))
    deleted, sources = [], []
    for label, rows, target in (('deleted', deleted_rows, deleted), ('source', source_rows, sources)):
        digest.update(canonical(label))
        for row in rows:
            if monotonic() >= paged.deadline: raise ValueError('recovery_page_deadline')
            if len(target) >= MAX_ROWS: raise ValueError('paged_recovery_sql_guard_row_limit')
            value = str(row) if label == 'deleted' else (str(row[0]), row[1])
            target.append(value); digest.update(canonical(value)); digest.update(b'\n')
    if monotonic() >= paged.deadline: raise ValueError('recovery_page_deadline')
    key = digest.digest()
    total = len(deleted) + len(sources)
    shared = None
    path = getattr(settings, 'SFERA_MESH_RECOVERY_GUARD_STATE', '')
    if path:
        from .mesh_shared_guard import SharedGuard
        shared = SharedGuard(path)
        ready, start = shared.get(key, total)
        if ready: return
    else:
        with _lock:
            expiry = _receipts.get(key)
            if expiry is not None and expiry > monotonic():
                _receipts.move_to_end(key)
                return
            _receipts.pop(key, None)
            progress = _progress.get(key)
            start = progress[0] if progress is not None and progress[1] > monotonic() else 0
            _progress.pop(key, None)
    initial_bytes = paged.used
    for offset in range(start, total):
        if offset > start and (paged.used - initial_bytes >= CHUNK_BYTES or monotonic() >= paged.deadline - 2):
            if shared is not None:
                if shared.advance(key, total, offset): return
            else:
                with _lock:
                    # Concurrent checks may advance further, never backwards.
                    existing = _progress.get(key)
                    position = max(offset, existing[0] if existing and existing[1] > monotonic() else 0)
                    _progress[key] = (position, monotonic() + PROGRESS_SECONDS)
                    _progress.move_to_end(key)
                    while len(_progress) > MAX_RECEIPTS: _progress.popitem(last=False)
            raise GuardWarming('history_verification_in_progress')
        if offset < len(deleted):
            entry = paged.lookup(deleted[offset])
            if entry is None or not entry['deleted']:
                raise GuardMismatch('history_deletion_update_pending')
        else:
            identity, write_id = sources[offset - len(deleted)]
            entry = paged.lookup(identity)
            expected = sha256(canonical({'domain': 'sfera-mesh-django-message-write-v1', 'message': identity,
                'snapshot': entry['snapshot_hash']})).hexdigest() if entry is not None and not entry['deleted'] else None
            if expected is None or write_id != expected:
                raise GuardMismatch('history_revision_update_pending')
    if monotonic() >= paged.deadline: raise ValueError('recovery_page_deadline')
    if shared is not None:
        shared.advance(key, total, total, ready=True)
        return
    with _lock:
        _progress.pop(key, None)
        _receipts[key] = monotonic() + TTL_SECONDS
        _receipts.move_to_end(key)
        while len(_receipts) > MAX_RECEIPTS: _receipts.popitem(last=False)
