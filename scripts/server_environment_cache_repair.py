"""Restore an admitted environment only by quarantining newly generated pyc.

Never accept a new fingerprint or alter a journal. Prove that excluding exactly
the proposed cache files reproduces the old full-tree SHA-256 before moving any.
"""
import hashlib
import os
from pathlib import Path
from release_v1 import canonical
from server_update import environment_fingerprint


def quarantine_bytecode(root,expected,accepted_at,quarantine):
    root=Path(root);quarantine=Path(quarantine)
    if environment_fingerprint(root)==expected:return []
    records={};candidates=[]
    for parent,dirs,files in os.walk(root,followlinks=False):
        for name in [*dirs,*files]:
            path=Path(parent)/name;relative=path.relative_to(root).as_posix()
            if path.is_symlink():
                if not path.resolve().is_relative_to(root):raise ValueError('environment_external_link')
                records[relative]={'link':os.readlink(path)}
            elif path.is_file():
                if '__pycache__' in path.parts and path.suffix=='.pyc' and path.stat().st_mtime>=accepted_at+1:
                    candidates.append((path,relative));continue
                with path.open('rb') as stream:records[relative]={'sha256':hashlib.file_digest(stream,'sha256').hexdigest()}
    if not candidates or hashlib.sha256(canonical(records)).hexdigest()!=expected:
        raise ValueError('environment_not_restorable_by_recent_bytecode_only')
    if (not quarantine.is_absolute() or quarantine.exists() or quarantine.is_relative_to(root)
            or any(path.is_symlink() for path in quarantine.parents)):
        raise ValueError('new_separate_cache_quarantine_required')
    quarantine.mkdir(mode=0o700,parents=True)
    for path,relative in candidates:
        target=quarantine/relative;target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        os.rename(path,target)
    if environment_fingerprint(root)!=expected:raise ValueError('environment_pristine_fingerprint_not_restored')
    return [relative for _,relative in candidates]
