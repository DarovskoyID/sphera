"""Modules taken from the repository at runtime.

The catalog in «Исследовать сферу» is the list of ``module/<id>`` branches in the
repository (``SFERA_MODULES_REPO``, by default the ``origin`` remote of this
checkout), with ``module.json`` read from each branch head. Nothing is deployed
in advance: installing a module fetches its branch into ``modules/<id>`` as a git
worktree, builds its frontend bundle, migrates and restarts the server so Django
loads the backend app.

State on disk (``modules/`` is not tracked by git):

    modules/<id>/                    worktree of module/<id> (detached at a commit)
    modules/.installed.json          {id: {"branch", "ref"}} — restored on deploy by fetch.mjs
    modules/.bundles/<id>/<ref>.js   built frontend
    modules/.jobs/<id>.json          running / failed install or update
"""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

from django.conf import settings

from . import loader

ID_RE = re.compile(r'^[a-z][a-z0-9_-]{0,40}$')
BRANCH_PREFIX = 'module/'
TRACKING = 'refs/sfera-modules/'
CATALOG_TTL = 300

_lock = threading.Lock()
_catalog: dict = {'at': 0.0, 'modules': {}, 'error': None}


def enabled() -> bool:
    return getattr(settings, 'SFERA_MODULES_FROM_REPO', True)


def _dir() -> Path:
    return loader.MODULES_DIR


def _repo() -> str:
    return os.environ.get('SFERA_MODULES_REPO') or getattr(settings, 'SFERA_MODULES_REPO', '') or 'origin'


def _git(*args, cwd=None, timeout=120) -> str:
    res = subprocess.run(
        ['git', *args], cwd=cwd or loader.REPO_ROOT, capture_output=True, text=True,
        encoding='utf-8', timeout=timeout,
    )
    if res.returncode != 0:
        raise RuntimeError((res.stderr or res.stdout).strip()[-800:] or f'git {args[0]} failed')
    return res.stdout.strip()


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return default


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(tmp, path)


# ── Catalog ──────────────────────────────────────────────────────────────────

def catalog(force: bool = False) -> tuple[dict, str | None]:
    """``{id: {"ref", "manifest"}}`` of module branches in the repository, and an error if unreachable."""
    if not enabled():
        return {}, None
    with _lock:
        if not force and time.monotonic() - _catalog['at'] < CATALOG_TTL:
            return _catalog['modules'], _catalog['error']
        try:
            modules = _fetch_catalog()
            _catalog.update(modules=modules, error=None)
        except Exception as e:  # network, auth, no git — keep the last good list
            _catalog['error'] = str(e)[:300]
        _catalog['at'] = time.monotonic()
        return _catalog['modules'], _catalog['error']


def _fetch_catalog() -> dict:
    heads = {}
    for line in _git('ls-remote', _repo(), f'refs/heads/{BRANCH_PREFIX}*', timeout=30).splitlines():
        sha, _, ref = line.partition('\t')
        mid = ref.removeprefix(f'refs/heads/{BRANCH_PREFIX}')
        if ID_RE.match(mid):
            heads[mid] = sha
    out = {}
    stale = [mid for mid, sha in heads.items() if _local_ref(mid) != sha]
    if stale:
        _git('fetch', '--quiet', '--no-tags', _repo(),
             *[f'+refs/heads/{BRANCH_PREFIX}{mid}:{TRACKING}{mid}' for mid in stale], timeout=300)
    for mid, sha in heads.items():
        try:
            raw = json.loads(_git('show', f'{sha}:module.json'))
        except (RuntimeError, ValueError):
            continue
        if raw.get('id') != mid:
            continue
        out[mid] = {'ref': sha, 'manifest': raw}
    return out


def _local_ref(mid: str) -> str | None:
    try:
        return _git('rev-parse', '--verify', '--quiet', f'{TRACKING}{mid}')
    except RuntimeError:
        return None


# ── What is on this server ───────────────────────────────────────────────────

_loaded_refs: dict[str, str | None] = {}


def disk_ref(mid: str) -> str | None:
    path = _dir() / mid
    if not (path / 'module.json').exists():
        return None
    try:
        return _git('rev-parse', 'HEAD', cwd=path, timeout=10)
    except (RuntimeError, OSError, subprocess.SubprocessError):
        return None


def loaded_ref(mid: str) -> str | None:
    """Commit of the module code this process loaded (it restarts after every change)."""
    if mid not in _loaded_refs:
        _loaded_refs[mid] = disk_ref(mid)
    return _loaded_refs[mid]


def installed_refs() -> dict:
    return _read_json(_dir() / '.installed.json', {})


def job(mid: str) -> dict | None:
    data = _read_json(_dir() / '.jobs' / f'{mid}.json', None)
    if not data:
        return None
    # The restart finished and this process runs the new code: the job is done.
    if data.get('status') == 'restarting' and mid in loader.discover() and loaded_ref(mid) == data.get('ref'):
        clear_job(mid)
        return None
    # Cut off by a restart before this process started: pick it up again.
    if data.get('status') in ('installing', 'updating') and data.get('pid') != os.getpid():
        resume_interrupted()
    return data


def clear_job(mid: str) -> None:
    try:
        (_dir() / '.jobs' / f'{mid}.json').unlink()
    except FileNotFoundError:
        pass


def _set_job(mid: str, **data) -> None:
    _write_json(_dir() / '.jobs' / f'{mid}.json', {**(job_raw(mid) or {}), **data, 'at': time.time()})


def job_raw(mid: str) -> dict | None:
    return _read_json(_dir() / '.jobs' / f'{mid}.json', None)


# ── Frontend bundle ──────────────────────────────────────────────────────────

_build_lock = threading.Lock()


def bundle_key(mid: str) -> str:
    """Commit of the checkout plus the newest frontend change, so local edits get rebuilt too."""
    ref = (disk_ref(mid) or 'local')[:12]
    newest = 0.0
    for root, dirs, files in os.walk(_dir() / mid / 'frontend'):
        dirs[:] = [d for d in dirs if d not in ('node_modules', '.git')]
        for name in files:
            if name.endswith(('.ts', '.tsx', '.js', '.jsx', '.css', '.json')):
                newest = max(newest, os.path.getmtime(os.path.join(root, name)))
    return f'{ref}-{int(newest):x}'


def bundle_path(mid: str, key: str) -> Path:
    return _dir() / '.bundles' / mid / f'{key}.js'


def has_frontend(mid: str) -> bool:
    fe = _dir() / mid / 'frontend'
    return (fe / 'index.tsx').exists() or (fe / 'index.ts').exists()


def build_bundle(mid: str) -> Path:
    """Build (once per commit) the frontend of the module checked out in modules/<id>."""
    out = bundle_path(mid, bundle_key(mid))
    if out.exists():
        return out
    with _build_lock:
        if out.exists():
            return out
        script = loader.REPO_ROOT / 'scripts' / 'modules' / 'build-module.mjs'
        res = subprocess.run(
            [os.environ.get('SFERA_NODE', 'node'), str(script), str(_dir() / mid), str(out)],
            cwd=loader.REPO_ROOT, capture_output=True, text=True, encoding='utf-8', timeout=600,
        )
        if res.returncode != 0 or not out.exists():
            raise RuntimeError(f'frontend build failed: {(res.stderr or res.stdout).strip()[-800:]}')
        # Old builds of this module are no longer referenced.
        for old in out.parent.glob('*.js'):
            if old != out:
                old.unlink(missing_ok=True)
        return out


def bundle_url(mid: str) -> str | None:
    if not has_frontend(mid):
        return None
    return f'api/modules/{mid}/bundle.js?v={bundle_key(mid)}'


# ── Install / update ─────────────────────────────────────────────────────────

def closure(mid: str, remote: dict) -> list[str]:
    """The module and its dependencies (dependencies last), from repository manifests."""
    order, stack = [], [mid]
    while stack:
        cur = stack.pop()
        if cur in order:
            continue
        spec = remote.get(cur)
        deps = spec['manifest'].get('deps', []) if spec else list(getattr(loader.discover().get(cur), 'deps', ()))
        order.append(cur)
        stack.extend(deps)
    return order


def needs_fetch(mid: str, remote: dict, update: bool) -> bool:
    """Whether installing needs code from the repository (absent, or an update is asked)."""
    spec = remote.get(mid)
    if disk_ref(mid) is None:
        return spec is not None
    return bool(update and spec and disk_ref(mid) != spec['ref'])


# One worker installs everything in order: git and the build must not run in
# parallel, and the server may restart only when nothing else is in progress.
_queue: list[tuple[str, str, bool]] = []  # (id, ref, has backend)
_queue_lock = threading.Lock()
_worker: threading.Thread | None = None


def start(ids: list[str], remote: dict, update: bool) -> list[str]:
    """Fetch, build and load the given modules in the background. Returns ids that got a job."""
    todo = [mid for mid in ids if needs_fetch(mid, remote, update)]
    for mid in todo:
        _write_json(_dir() / '.jobs' / f'{mid}.json', {
            'status': 'updating' if disk_ref(mid) else 'installing',
            'ref': remote[mid]['ref'], 'at': time.time(), 'pid': os.getpid(),
        })
    _enqueue([(mid, remote[mid]['ref'], bool(remote[mid]['manifest'].get('backendApp'))) for mid in todo])
    return todo


def _enqueue(items):
    global _worker
    with _queue_lock:
        for item in items:
            if all(q[0] != item[0] for q in _queue):
                _queue.append(item)
        if _queue and (_worker is None or not _worker.is_alive()):
            _worker = threading.Thread(target=_work, name='sfera-module-install', daemon=True)
            _worker.start()


def resume_interrupted() -> None:
    """Installs cut off by a restart (another process wrote the job) continue here."""
    jobs = _dir() / '.jobs'
    if not jobs.is_dir():
        return
    items = []
    for path in jobs.glob('*.json'):
        data = _read_json(path, None) or {}
        mid = path.stem
        if data.get('status') not in ('installing', 'updating') or data.get('pid') == os.getpid() or not data.get('ref'):
            continue
        try:
            backend = bool(json.loads(_git('show', f"{data['ref']}:module.json")).get('backendApp'))
        except (RuntimeError, ValueError):
            backend = True
        _set_job(mid, pid=os.getpid())
        items.append((mid, data['ref'], backend))
    _enqueue(items)


def auto_update(repo: dict, deployed: dict, installed: set) -> list[str]:
    """Installed modules follow the heads of their branches without anyone pressing «Обновить».

    Runs whenever the catalog is listed (the repository itself is checked at most
    every CATALOG_TTL). SFERA_MODULES_AUTOUPDATE=0 leaves updates to the superuser.
    """
    if os.environ.get('SFERA_MODULES_AUTOUPDATE', '1') == '0' or not repo:
        return []
    outdated = [
        mid for mid in installed
        if mid in deployed and mid in repo and not job_raw(mid)
        and (disk_ref(mid) or repo[mid]['ref']) != repo[mid]['ref']
    ]
    return start(outdated, repo, update=True) if outdated else []


def _checkout(mid: str, ref: str) -> None:
    target = _dir() / mid
    _dir().mkdir(parents=True, exist_ok=True)
    if not _local_ref(mid) or _git('cat-file', '-t', ref) != 'commit':
        _git('fetch', '--quiet', '--no-tags', _repo(), f'+refs/heads/{BRANCH_PREFIX}{mid}:{TRACKING}{mid}', timeout=300)
    if (target / '.git').exists():
        _git('checkout', '--quiet', '--force', '--detach', ref, cwd=target)
    else:
        if target.exists():
            shutil.rmtree(target)
        _git('worktree', 'prune')
        _git('worktree', 'add', '--force', '--detach', str(target), ref)


_restart: list[str] = []


def _work() -> None:
    restart = _restart
    while True:
        with _queue_lock:
            if not _queue:
                break
            mid, ref, backend = _queue.pop(0)
        try:
            _checkout(mid, ref)
            if has_frontend(mid):
                build_bundle(mid)
            installed = installed_refs()
            installed[mid] = {'branch': f'{BRANCH_PREFIX}{mid}', 'ref': ref}
            _write_json(_dir() / '.installed.json', installed)
            if backend or mid in loader.discover():
                restart.append(mid)
                _set_job(mid, status='restarting')
            else:
                clear_job(mid)
                loader.reset_cache()
        except Exception as e:
            _set_job(mid, status='failed', error=str(e)[:800])
    # Queue drained: restart once for all of them. Anything queued from now on
    # keeps this process's pid in its job and is resumed after the restart.
    if restart:
        _migrate_and_restart(list(restart))
        restart.clear()


def _migrate_and_restart(ids: list[str]) -> None:
    # A fresh interpreter discovers the new modules; this process cannot load them.
    manage = Path(settings.BASE_DIR) / 'manage.py'
    res = subprocess.run(
        [sys.executable, str(manage), 'migrate', '--noinput'],
        cwd=settings.BASE_DIR, capture_output=True, text=True, encoding='utf-8', timeout=900,
    )
    if res.returncode != 0:
        for mid in ids:
            _set_job(mid, status='failed', error=f'migrate: {(res.stderr or res.stdout).strip()[-800:]}')
        return
    mode = os.environ.get('SFERA_MODULES_RESTART', 'exit')
    if mode == 'none':
        for mid in ids:
            _set_job(mid, status='restarting', manual=True)
        return
    # systemd (Restart=always) and Django's autoreloader (exit code 3) start the
    # server again; let the current responses finish first.
    time.sleep(1.5)
    os._exit(3)
