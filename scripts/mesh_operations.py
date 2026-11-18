"""Local mesh maintenance primitives. Never uploads, installs or overwrites live data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
from contextlib import closing

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def verify_release(manifest, artifact, public_key, platform, minimum_sequence):
    """The caller supplies an independently trusted key and durable version floor."""
    checked = verify_release_metadata(manifest, public_key, platform, minimum_sequence)
    body = manifest['body']
    artifact = Path(artifact)
    if artifact.is_symlink() or not artifact.is_file() or artifact.name != body['filename']:
        raise ValueError('artifact name mismatch')
    if artifact.stat().st_size != body['size'] or sha256(artifact) != body['sha256']:
        raise ValueError('artifact content mismatch')
    return checked


def verify_release_metadata(manifest, public_key, platform, minimum_sequence):
    """Authenticate size/name/hash before following a download instruction."""
    if type(minimum_sequence) is not int or minimum_sequence < 1:
        raise ValueError('invalid version floor')
    if not isinstance(manifest, dict) or set(manifest) != {'body', 'signature'}:
        raise ValueError('invalid manifest')
    body = manifest['body']
    if not isinstance(body, dict) or set(body) != {'domain', 'platform', 'sequence', 'filename', 'size', 'sha256'}:
        raise ValueError('invalid release body')
    if body['domain'] != 'sfera-mesh-release-lab-v1' or body['platform'] != platform:
        raise ValueError('release context mismatch')
    if type(body['sequence']) is not int or not minimum_sequence <= body['sequence'] <= 2**63 - 1:
        raise ValueError('release rollback')
    if type(body['size']) is not int or body['size'] < 1:
        raise ValueError('invalid artifact size')
    if not isinstance(body['sha256'], str) or not re.fullmatch('[0-9a-f]{64}', body['sha256']):
        raise ValueError('invalid artifact digest')
    if not isinstance(body['filename'], str) or not re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,127}', body['filename']):
        raise ValueError('invalid artifact name')
    reserved = {'con', 'prn', 'aux', 'nul', *('com' + str(index) for index in range(1, 10)), *('lpt' + str(index) for index in range(1, 10))}
    if body['filename'].endswith('.') or body['filename'].split('.')[0].lower() in reserved:
        raise ValueError('reserved artifact name')
    if not isinstance(public_key, str) or not re.fullmatch('[0-9a-f]{64}', public_key):
        raise ValueError('invalid pinned key')
    if not isinstance(manifest['signature'], str) or not re.fullmatch('[0-9a-f]{128}', manifest['signature']):
        raise ValueError('invalid signature encoding')
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key)).verify(
        bytes.fromhex(manifest['signature']), canonical(body))
    return {'verified': True, 'platform': platform, 'sequence': body['sequence'], 'sha256': body['sha256']}


def stage_release(manifest, artifact, public_key, platform, minimum_sequence, state, destination):
    """Verify a private staging copy and persist the release floor before success.

    No execution or installation. Full state-file rollback needs an independent
    version floor; an old copy of this DB is not a trusted recovery checkpoint.
    """
    manifest = json.loads(canonical(manifest))
    artifact, state, destination = Path(artifact), Path(state), Path(destination)
    checked = verify_release(manifest, artifact, public_key, platform, minimum_sequence)
    packet = canonical(manifest)
    packet_hash = hashlib.sha256(packet).hexdigest()
    if state.is_symlink() or state.resolve() == artifact.resolve() or state.resolve().is_relative_to(destination.resolve()):
        raise ValueError('release state path conflict')
    with closing(sqlite3.connect(state)) as db:
        db.execute('PRAGMA synchronous=FULL')
        with db:
            db.execute('BEGIN IMMEDIATE')
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if tables and tables != {'release_trust', 'release_head'}:
                raise ValueError('state must be a dedicated release database')
            db.execute('CREATE TABLE IF NOT EXISTS release_trust (singleton INTEGER PRIMARY KEY CHECK(singleton=1), platform TEXT NOT NULL, public_key TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS release_head (singleton INTEGER PRIMARY KEY CHECK(singleton=1), sequence INTEGER NOT NULL, packet_hash TEXT NOT NULL)')
            pin = db.execute('SELECT platform,public_key FROM release_trust WHERE singleton=1').fetchone()
            head = db.execute('SELECT sequence,packet_hash FROM release_head WHERE singleton=1').fetchone()
            if pin is not None and pin != (platform, public_key):
                raise ValueError('release trust changed')
            if (pin is None) != (head is None):
                raise ValueError('release state corrupt')
            sequence = checked['sequence']
            if head and (sequence < head[0] or (sequence == head[0] and packet_hash != head[1])):
                raise ValueError('release rollback or same-version fork')
            destination.mkdir()  # Never reuse or replace an existing staging directory.
            staged = destination / manifest['body']['filename']
            with staged.open('xb') as output, artifact.open('rb') as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b''):
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            # Source may have changed while copying. Verify the exact staged bytes.
            verify_release(manifest, staged, public_key, platform, minimum_sequence)
            with (destination / '.release-manifest.json').open('xb') as output:
                output.write(packet)
                output.flush()
                os.fsync(output.fileno())
            db.execute('INSERT OR IGNORE INTO release_trust VALUES (1,?,?)', (platform, public_key))
            db.execute('INSERT OR REPLACE INTO release_head VALUES (1,?,?)', (sequence, packet_hash))
    return {**checked, 'staged': True, 'installed': False}


def _integrity(connection):
    if connection.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
        raise ValueError('SQLite integrity failure')


def backup_sqlite(source, destination):
    """SQLite online backup includes committed WAL; destination must not exist."""
    source, destination = Path(source).resolve(strict=True), Path(destination).absolute()
    if not source.is_file() or source == destination.resolve():
        raise ValueError('invalid backup paths')
    # Exclusive directory creation is the publication barrier: never replace an old backup.
    destination.mkdir()
    try:
        target = destination / 'database.sqlite3'
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as live:
            with closing(sqlite3.connect(target)) as copy:
                live.backup(copy, pages=256, sleep=0.01)
                _integrity(copy)
        metadata = {'domain': 'sfera-mesh-sqlite-backup-lab-v1',
                    'sha256': sha256(target), 'size': target.stat().st_size}
        (destination / 'manifest.json').write_bytes(canonical(metadata))
        return metadata
    except BaseException:
        # Keep incomplete evidence; restore requires a complete verified manifest.
        raise


def verify_backup(directory):
    directory = Path(directory)
    manifest_path, database = directory / 'manifest.json', directory / 'database.sqlite3'
    if manifest_path.is_symlink() or database.is_symlink() or manifest_path.stat().st_size > 1024:
        raise ValueError('invalid backup files')
    metadata = json.loads(manifest_path.read_bytes())
    if not isinstance(metadata, dict) or set(metadata) != {'domain', 'sha256', 'size'}:
        raise ValueError('invalid backup manifest')
    if metadata['domain'] != 'sfera-mesh-sqlite-backup-lab-v1' or type(metadata['size']) is not int:
        raise ValueError('invalid backup context')
    if database.stat().st_size != metadata['size'] or sha256(database) != metadata['sha256']:
        raise ValueError('backup content mismatch')
    with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True)) as connection:
        _integrity(connection)
    return metadata


def restore_copy(directory, destination):
    """Restore to a NEW isolated file for protocol-specific checks, never into a service."""
    metadata = verify_backup(directory)
    destination = Path(destination)
    # Exclusive creation preserves existing files, even on a second invocation.
    with destination.open('xb') as output:
        with (Path(directory) / 'database.sqlite3').open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                output.write(chunk)
    if sha256(destination) != metadata['sha256']:
        raise ValueError('restore verification failure')
    with closing(sqlite3.connect(destination.resolve().as_uri() + '?mode=ro', uri=True)) as connection:
        _integrity(connection)
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for command in ('verify-release', 'stage-release'):
        release = sub.add_parser(command)
        for name in ('manifest', 'artifact', 'public-key', 'platform'):
            release.add_argument('--' + name, required=True)
        release.add_argument('--minimum-sequence', type=int, required=True)
        if command == 'stage-release':
            release.add_argument('--state', required=True, help='dedicated release SQLite file')
            release.add_argument('--destination', required=True, help='new private staging directory')
    backup = sub.add_parser('backup-sqlite')
    backup.add_argument('--source', required=True)
    backup.add_argument('--destination', required=True)
    check = sub.add_parser('verify-backup')
    check.add_argument('--directory', required=True)
    restore = sub.add_parser('restore-copy')
    restore.add_argument('--directory', required=True)
    restore.add_argument('--destination', required=True)
    args = parser.parse_args()
    if args.command in ('verify-release', 'stage-release'):
        path = Path(args.manifest)
        if path.stat().st_size > 4096:
            raise ValueError('manifest too large')
        manifest = json.loads(path.read_bytes())
        if args.command == 'stage-release':
            if Path(args.state).resolve() == path.resolve():
                raise ValueError('release state path conflict')
            result = stage_release(manifest, args.artifact, args.public_key, args.platform,
                                   args.minimum_sequence, args.state, args.destination)
        else:
            result = verify_release(manifest, args.artifact, args.public_key,
                                    args.platform, args.minimum_sequence)
    elif args.command == 'backup-sqlite':
        result = backup_sqlite(args.source, args.destination)
    elif args.command == 'verify-backup':
        result = verify_backup(args.directory)
    else:
        result = restore_copy(args.directory, args.destination)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
