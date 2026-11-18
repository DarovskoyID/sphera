"""Fetch and privately stage an authenticated client release. Never executes it."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import ssl
import tempfile
import time
from urllib.parse import urlsplit
from urllib.request import build_opener, ProxyHandler, HTTPSHandler, HTTPRedirectHandler, Request

from mesh_operations import canonical, stage_release, verify_release_metadata

MAX_ARTIFACT = 256 * 1024 * 1024


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('release redirects are forbidden')


def release_base(value):
    if not isinstance(value, str) or len(value) > 2048 or any(ord(character) < 33 for character in value):
        raise ValueError('invalid release base')
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or
            parsed.query or parsed.fragment or '%' in parsed.path or '\\' in value or
            any(part in ('.', '..') for part in parsed.path.split('/'))):
        raise ValueError('trusted HTTPS release base required')
    # Evaluating port rejects malformed host:port input before any network call.
    if parsed.port is not None and not 1 <= parsed.port <= 65535:
        raise ValueError('invalid release port')
    return value.rstrip('/') + '/'


def _copy_response(opener, url, target, maximum, seconds, *, exact=None):
    started = time.monotonic()
    request = Request(url, headers={'Accept-Encoding': 'identity', 'User-Agent': 'Sphere-Release-Stager/1'})
    size, checksum = 0, hashlib.sha256()
    with opener.open(request, timeout=5) as response:
        if response.status != 200 or response.geturl() != url or response.headers.get('Content-Encoding', 'identity') != 'identity':
            raise ValueError('unexpected release response')
        declared = response.headers.get('Content-Length')
        if declared is not None and (not declared.isdecimal() or int(declared) > maximum or
                                    (exact is not None and int(declared) != exact)):
            raise ValueError('release content length mismatch')
        while True:
            if time.monotonic() - started > seconds:
                raise ValueError('release download deadline')
            chunk = response.read1(min(65536, maximum + 1 - size))
            if not chunk:
                break
            size += len(chunk)
            if size > maximum:
                raise ValueError('release download size limit')
            checksum.update(chunk)
            target.write(chunk)
    if exact is not None and size != exact:
        raise ValueError('truncated release download')
    return checksum.hexdigest()


def _json_unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate release JSON key')
        result[key] = value
    return result


def download_release(base, public_key, platform, minimum_sequence, state, destination, *, opener=None):
    import io
    base = release_base(base)
    destination, state = Path(destination), Path(state)
    if (not destination.is_absolute() or not state.is_absolute() or destination.exists() or
            not destination.parent.is_dir() or not state.parent.is_dir() or destination.is_symlink() or state.is_symlink()):
        raise ValueError('dedicated absolute release paths required')
    if state.resolve().is_relative_to(destination.resolve()) or (state.exists() and not state.is_file()):
        raise ValueError('release state path conflict')
    if opener is None:
        context = ssl.create_default_context()
        opener = build_opener(ProxyHandler({}), HTTPSHandler(context=context), NoRedirect())
    data = io.BytesIO()
    _copy_response(opener, base + 'release.json', data, 16384, 10)
    manifest = json.loads(data.getvalue(), object_pairs_hook=_json_unique)
    verify_release_metadata(manifest, public_key, platform, minimum_sequence)
    body = manifest['body']
    if body['size'] > MAX_ARTIFACT:
        raise ValueError('release artifact size limit')
    if state.exists():
        with closing(sqlite3.connect(state.as_uri() + '?mode=ro', uri=True)) as database:
            tables = {row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if tables != {'release_trust', 'release_head'}:
                raise ValueError('state must be a dedicated release database')
            pin = database.execute('SELECT platform,public_key FROM release_trust WHERE singleton=1').fetchone()
            head = database.execute('SELECT sequence,packet_hash FROM release_head WHERE singleton=1').fetchone()
            if pin != (platform, public_key) or head is None:
                raise ValueError('release state trust mismatch')
            if body['sequence'] < head[0] or (body['sequence'] == head[0] and hashlib.sha256(canonical(manifest)).hexdigest() != head[1]):
                raise ValueError('release rollback or same-version fork')
    scratch = Path(tempfile.mkdtemp(prefix='.sphere-release-download-', dir=destination.parent))
    artifact = scratch / body['filename']
    try:
        with artifact.open('xb') as target:
            digest = _copy_response(opener, base + body['filename'], target, body['size'], 120, exact=body['size'])
            target.flush(); os.fsync(target.fileno())
        if digest != body['sha256']:
            raise ValueError('downloaded release digest mismatch')
        return stage_release(manifest, artifact, public_key, platform, minimum_sequence, state, destination)
    finally:
        # Remove only this exact owned file/directory, never recurse through a
        # directory whose contents could have changed underneath the download.
        try:
            artifact.unlink(missing_ok=True); scratch.rmdir()
        except OSError:
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--public-key', required=True)
    parser.add_argument('--platform', required=True)
    parser.add_argument('--minimum-sequence', required=True, type=int)
    parser.add_argument('--state', required=True)
    parser.add_argument('--destination', required=True)
    args = parser.parse_args()
    result = download_release(args.base_url, args.public_key, args.platform, args.minimum_sequence, args.state, args.destination)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
