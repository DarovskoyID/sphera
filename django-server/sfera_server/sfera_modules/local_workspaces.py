"""First-party local stores and realtime engines, shipped with the open core."""
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parent.parent / 'local_workspaces'
IDS = frozenset(('office', 'whiteboard', 'planner', 'conference', 'servers', 'channels', 'bots', 'diary', 'family', 'legal', 'multiserver', 'totp'))


def manifests():
    result = {}
    for module_id in sorted(IDS):
        path = ROOT / module_id
        source = path / 'module.json'
        if source.is_file(): result[module_id] = (path, json.loads(source.read_text(encoding='utf-8')))
    return result
