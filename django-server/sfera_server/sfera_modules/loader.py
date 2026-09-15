"""Discovery of Sfera modules.

A module lives in ``<repo>/modules/<id>/`` (checked out from the ``module/<id>``
branch) and is described by ``module.json``::

    {
      "id": "channels",
      "name": {"ru": "Каналы", "en": "Channels"},
      "version": "1.0.0",
      "sdkVersion": 1,
      "deps": [],
      "backendApp": "sfera_channels",   # optional, lives in backend/<app>/
      "urlPrefix": "api/channels/",      # optional, mounts <app>.urls
      "icon": "rss",
      "provides": ["explore.search"]
    }

This file must stay import-safe before Django is configured: settings.py calls
``discover()`` to extend INSTALLED_APPS.
"""
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

SDK_VERSION = 1

REPO_ROOT = Path(__file__).resolve().parents[3]
MODULES_DIR = Path(os.environ.get('SFERA_MODULES_DIR', REPO_ROOT / 'modules'))


@dataclass(frozen=True)
class ModuleManifest:
    id: str
    version: str
    path: Path
    name: dict = field(default_factory=dict)
    description: dict = field(default_factory=dict)
    deps: tuple = ()
    backend_app: str | None = None
    url_prefix: str | None = None
    icon: str = ''
    provides: tuple = ()
    sdk_version: int = SDK_VERSION
    # Frontend also runs on the sign-in screen (e.g. choosing a server).
    pre_auth: bool = False

    @property
    def frontend_entry(self) -> str:
        return f'modules/{self.id}/{self.version}/index.js'

    def public(self) -> dict:
        return {
            'id': self.id,
            'version': self.version,
            'name': self.name,
            'description': self.description,
            'deps': list(self.deps),
            'icon': self.icon,
            'provides': list(self.provides),
            'entry': self.frontend_entry,
            'preAuth': self.pre_auth,
        }


_cache: dict[str, ModuleManifest] | None = None


def _read(path: Path) -> ModuleManifest | None:
    try:
        raw = json.loads((path / 'module.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    if raw.get('sdkVersion', SDK_VERSION) != SDK_VERSION:
        print(f'[sfera_modules] skip {path.name}: sdkVersion {raw.get("sdkVersion")} != {SDK_VERSION}',
              file=sys.stderr)
        return None
    return ModuleManifest(
        id=raw['id'],
        version=raw.get('version', '0.0.0'),
        path=path,
        name=raw.get('name', {}),
        description=raw.get('description', {}),
        deps=tuple(raw.get('deps', ())),
        backend_app=raw.get('backendApp'),
        url_prefix=raw.get('urlPrefix'),
        icon=raw.get('icon', ''),
        provides=tuple(raw.get('provides', ())),
        sdk_version=raw.get('sdkVersion', SDK_VERSION),
        pre_auth=bool(raw.get('preAuth', False)),
    )


def discover() -> dict[str, ModuleManifest]:
    """Return manifests of all modules present on this instance (id -> manifest)."""
    global _cache
    if _cache is not None:
        return _cache
    found: dict[str, ModuleManifest] = {}
    if MODULES_DIR.is_dir():
        for child in sorted(MODULES_DIR.iterdir()):
            if child.is_dir():
                m = _read(child)
                if m:
                    found[m.id] = m
    # Drop modules whose dependencies are absent on the instance.
    changed = True
    while changed:
        changed = False
        for mid, m in list(found.items()):
            if any(d not in found for d in m.deps):
                print(f'[sfera_modules] skip {mid}: missing deps {m.deps}', file=sys.stderr)
                del found[mid]
                changed = True
    _cache = found
    return found


def backend_apps() -> list[str]:
    """Django app labels contributed by modules; also puts backend/ on sys.path."""
    apps = []
    for m in discover().values():
        if not m.backend_app:
            continue
        backend = m.path / 'backend'
        if (backend / m.backend_app).is_dir():
            if str(backend) not in sys.path:
                sys.path.insert(0, str(backend))
            apps.append(m.backend_app)
    return apps


def url_patterns() -> list:
    from importlib import import_module
    from django.urls import include, path

    out = []
    for m in discover().values():
        if m.backend_app and m.url_prefix:
            try:
                import_module(f'{m.backend_app}.urls')
            except ModuleNotFoundError as e:
                if e.name != f'{m.backend_app}.urls':
                    raise
                continue
            out.append(path(m.url_prefix, include(f'{m.backend_app}.urls')))
    return out


def websocket_patterns() -> list:
    """Collect ``websocket_urlpatterns`` from ``<app>.routing`` of each module."""
    from importlib import import_module

    out = []
    for m in discover().values():
        if not m.backend_app:
            continue
        try:
            routing = import_module(f'{m.backend_app}.routing')
        except ModuleNotFoundError as e:
            if e.name != f'{m.backend_app}.routing':
                raise
            continue
        out.extend(getattr(routing, 'websocket_urlpatterns', []))
    return out


def reset_cache() -> None:
    """Re-read modules/ on the next discover() (a frontend-only module was added)."""
    global _cache
    _cache = None
