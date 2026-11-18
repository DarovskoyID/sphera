"""Retire only authenticated, superseded automatic v2 generation files.

No recursive deletion and no cache pruning: cache rows are durable reservations.
An interrupted cleanup can be retried from the retained generation input.
"""
from contextlib import closing
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import sqlite3
import time

from cryptography.fernet import InvalidToken
from django.conf import settings

from sfera_mesh.recovery_tree import validate_head
from sfera_mesh.refresh_lock import RefreshLock
from sfera_mesh.storage import canonical
from .encryption import decrypt_bytes
from .mesh_paged_publication import FIELDS
from .mesh_index_disk import configured, retire_deleted


def prune_generations(controller, identity, expected_head, *, limit=8):
    if type(limit) is not int or not 1 <= limit <= 32: raise ValueError('invalid_paged_cleanup_limit')
    directory = controller.writer.publication.directory
    directory.refresh(controller.writer.publication.address)
    head = controller._head(identity)
    stored = controller._stored(identity)
    result = {'removed': 0, 'bytes': 0, 'deferred': 0}
    if (head is None or head['digest'] != expected_head or stored is None or stored[2] != expected_head or
            not controller._matches(stored[0], head)):
        return result
    base = Path(controller.path)
    parent = base.parent.resolve()
    keep = Path(controller._job(stored[0]))
    pattern = re.compile(re.escape(base.name) + r'\.([0-9a-f]{64})\.sqlite\Z')
    app_paths = {os.path.normcase(str(Path(db['NAME']).resolve())) for db in settings.DATABASES.values()
        if db.get('ENGINE', '').endswith('sqlite3') and db.get('NAME') and db['NAME'] != ':memory:'}

    def safe(path):
        return (not path.is_symlink() and path.resolve().parent == parent and
            os.path.normcase(str(path.resolve())) not in app_paths and
            (not path.exists() or path.stat().st_nlink == 1))

    scanned = 0
    retired = []
    deadline = time.monotonic() + 2
    for path in parent.glob(base.name + '.*.sqlite'):
        match = pattern.fullmatch(path.name)
        if not match or path == keep: continue
        scanned += 1
        if scanned > 64 or result['removed'] >= limit or time.monotonic() >= deadline: break
        root = Path(str(path) + '.root.sqlite')
        locks = [RefreshLock(str(path) + '.paged-index.lock'), RefreshLock(str(root) + '.recovery-tree.lock')]
        if configured() is not None:
            locks.extend(RefreshLock(str(target) + '.disk-quota.lock') for target in (path, root))
        try:
            if not safe(path) or not safe(root):
                result['deferred'] += 1; continue
            if not all(lock.acquire() for lock in locks):
                result['deferred'] += 1; continue
            # Sidecars can indicate another open connection or an interrupted
            # SQLite transaction. Do not remove them or bypass recovery.
            if any(Path(str(target) + suffix).exists() for target in (path, root) for suffix in ('-journal', '-wal', '-shm')):
                result['deferred'] += 1; continue
            with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
                names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")}
                if names != {'paged_index_pin', 'paged_index_blocks', 'paged_index_head'}:
                    raise ValueError('foreign_paged_cleanup_database')
                size = db.execute('SELECT length(ciphertext) FROM paged_index_pin WHERE singleton=1').fetchone()
                head_size = db.execute('SELECT length(transaction_bytes) FROM paged_index_head WHERE singleton=1').fetchone()
                if size is None or size[0] > 48 * 1048576 or head_size is None or head_size[0] > 65536:
                    raise ValueError('paged_cleanup_byte_limit')
                pin, encrypted = db.execute('SELECT context,ciphertext FROM paged_index_pin WHERE singleton=1').fetchone()
                raw = decrypt_bytes(bytes(encrypted)); value = json.loads(raw)
                if canonical(value) != raw or sha256(raw).hexdigest() != pin or set(value) != {'document', 'previous_messages'}:
                    raise ValueError('paged_cleanup_input_corrupt')
                document = value['document']
                if set(document) != FIELDS or document['domain'] != 'sfera-mesh-message-index-input-v2':
                    raise ValueError('paged_cleanup_input_corrupt')
                full = {**document, '_previous_messages': value['previous_messages']}
                if sha256(canonical(full)).hexdigest() != match[1]: raise ValueError('paged_cleanup_filename_changed')
                transaction_raw = bytes(db.execute('SELECT transaction_bytes FROM paged_index_head WHERE singleton=1').fetchone()[0])
                transaction = json.loads(transaction_raw)
                if set(transaction) != {'body', 'signature', 'updates'} or canonical(transaction) != transaction_raw:
                    raise ValueError('paged_cleanup_head_corrupt')
                body, _ = validate_head({key: transaction[key] for key in ('body', 'signature')}, directory.network, directory.pin)
                if (not controller._matches(full, {'record': {'body': body}}) or
                        any(body[key] != head['record']['body'][key] for key in ('publisher', 'source', 'scope', 'genesis')) or
                        body['version'] >= head['record']['body']['version']):
                    continue
            if root.exists():
                with closing(sqlite3.connect(root.as_uri() + '?mode=ro', uri=True)) as db:
                    names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")}
                    if names != {'recovery_tree_outbox'}: raise ValueError('foreign_paged_cleanup_outbox')
                    row = db.execute('SELECT transaction_bytes FROM recovery_tree_outbox WHERE singleton=1').fetchone()
                    if row is None or bytes(row[0]) != transaction_raw: raise ValueError('paged_cleanup_outbox_changed')
            # Recheck the durable/current head immediately before unlinking.
            current = controller._stored(identity)
            latest = controller._head(identity)
            if current is None or current[2] != expected_head or latest is None or latest['digest'] != expected_head:
                break
            if not safe(path) or not safe(root): raise ValueError('paged_cleanup_path_changed')
            sizes = {target: target.stat().st_size for target in (root, path) if target.exists()}
            # Outbox first: if interrupted, the remaining authenticated input
            # still identifies the obsolete plan on the next pass.
            for target in (root, path):
                if target in sizes:
                    target.unlink(); result['bytes'] += sizes[target]
            retired.extend((path, root))
            result['removed'] += 1
        except (ValueError, TypeError, KeyError, OSError, sqlite3.Error, InvalidToken):
            result['deferred'] += 1
        finally:
            for lock in reversed(locks): lock.release()
    if retired:
        try: result['quota_released'] = retire_deleted(retired)
        except (ValueError, OSError, sqlite3.Error): result['quota_released'] = 0
    return result
