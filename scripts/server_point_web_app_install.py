"""Restore the project's actual Vite App on an already installed web point.

The application API is a separate service. Never send its password/JWT requests
to the mesh-only entry adapter or answer API requests with the SPA HTML.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import subprocess
import sys
import tarfile
import zipfile

WEB = Path('/opt/sphere-web')
POINT = Path('/opt/sphere-point')


def main():
    os.umask(0o077)
    with zipfile.ZipFile(sys.argv[0]) as archive:
        job = json.loads(archive.read('job.json'))
    settings_path = POINT / 'code/preparing.json'
    if not settings_path.exists():
        settings_path = POINT / 'code/pending.json'
    settings = json.loads(settings_path.read_bytes())
    sys.path.insert(0, str(Path(settings['version']) / 'scripts'))
    from server_point_install import asset

    old_receipt = json.loads((WEB / 'installation.json').read_bytes())
    host = old_receipt['host']
    config = json.loads((POINT / 'data/point.json').read_bytes())
    if config['network'] != job['network'] or host not in job['hosts']:
        raise ValueError('web_network_pin')
    group = pwd.getpwnam('sphere-web').pw_gid
    bundle = asset(job['site'], WEB / 'code' / ('app-' + job['site']['sha256'] + '.tar.gz'), 32 * 1048576)
    target = WEB / ('app-' + job['site']['sha256'][:16])
    target.mkdir(mode=0o750, exist_ok=True)
    os.chown(target, 0, group)
    target.chmod(0o750)
    expected = job['files']
    if not 1 <= len(expected) <= 1000:
        raise ValueError('bounded_app_manifest')
    seen = set()
    with tarfile.open(bundle, 'r:gz') as tar:
        for member in tar.getmembers():
            name = member.name
            parts = PurePosixPath(name).parts
            if (not member.isfile() or name not in expected or name in seen or
                    not parts or name.startswith('/') or '..' in parts or '\\' in name or
                    not 0 <= member.size <= 16 * 1048576):
                raise ValueError('bounded_app_file')
            raw = tar.extractfile(member).read()
            if hashlib.sha256(raw).hexdigest() != expected[name]:
                raise ValueError('app_file_digest')
            dest = target / name
            if dest.is_symlink():
                raise ValueError('app_file_link')
            for parent in reversed(dest.parents):
                if parent == target or target in parent.parents:
                    if parent.is_symlink():
                        raise ValueError('app_directory_link')
                    parent.mkdir(mode=0o750, exist_ok=True)
                    os.chown(parent, 0, group)
                    parent.chmod(0o750)
            dest.write_bytes(raw)
            os.chown(dest, 0, group)
            dest.chmod(0o640)
            seen.add(name)
    if seen != set(expected) or 'index.html' not in seen:
        raise ValueError('complete_app_required')

    # Preserve the existing ACME state and mesh routes. App API integration is
    # not implemented by the mesh login bridge; fail explicitly until it exists.
    current = (WEB / 'Caddyfile').read_text()
    replacement, roots = re.subn(r'(?m)^([ \t]*)root \* /opt/sphere-web/(?:site|app-[0-9a-f]{16})$',
                                 lambda match: match[1] + 'root * ' + str(target), current)
    if roots != 1:
        raise ValueError('unexpected_web_root')
    replacement = replacement.replace(
        "style-src 'self'; img-src 'self' data:; connect-src 'self';",
        "style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; "
        "media-src 'self' https: blob:; worker-src 'self' blob:; connect-src 'self' https: wss:;")
    boundary = '''
 handle /api/* {
  header Content-Type application/json
  header Cache-Control no-store
  respond `{\"detail\":\"Application API is not connected to this mesh point.\",\"code\":\"application_api_not_connected\"}` 503
 }
 handle /ws/* {
  respond "Application WebSocket service is not connected." 503
 }
'''
    if 'application_api_not_connected' not in replacement:
        replacement = replacement.replace(' handle /web-api/* {', boundary + ' handle /web-api/* {')
    pending = WEB / 'Caddyfile.app.pending'
    pending.write_text(replacement)
    os.chown(pending, 0, group)
    pending.chmod(0o640)
    subprocess.run([str(WEB / 'code/caddy'), 'validate', '--config', str(pending), '--adapter', 'caddyfile'], check=True)
    backup = WEB / 'Caddyfile.before-original-app'
    if not backup.exists():
        backup.write_text(current)
        os.chown(backup, 0, group)
        backup.chmod(0o640)
    os.replace(pending, WEB / 'Caddyfile')
    try:
        subprocess.run(['systemctl', 'restart', 'sphere-web-edge.service'], check=True)
        subprocess.run(['systemctl', 'is-active', '--quiet', 'sphere-web-edge.service'], check=True)
    except BaseException:
        (WEB / 'Caddyfile').write_text(current)
        subprocess.run(['systemctl', 'restart', 'sphere-web-edge.service'], check=False)
        raise
    receipt = {'host': host, 'url': 'https://' + host, 'frontend': 'original-src-App.tsx',
               'site_sha256': job['site']['sha256'], 'files': len(seen),
               'application_api_connected': False, 'mesh_services_unchanged': True}
    (WEB / 'original-app.json').write_text(json.dumps(receipt))
    (WEB / 'original-app.json').chmod(0o640)
    os.chown(WEB / 'original-app.json', 0, group)
    print('SPHERE_ORIGINAL_APP_RESTORED=' + json.dumps(receipt), flush=True)


if __name__ == '__main__':
    main()
