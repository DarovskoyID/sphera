"""Measured file capacity including SQLite sidecars; not an OS filesystem quota."""
from pathlib import Path
import shutil


class DiskBudget:
    def __init__(self, paths, limit_bytes, metadata_reserve_bytes):
        if (not isinstance(paths, (list, tuple)) or not 1 <= len(paths) <= 64 or
                type(limit_bytes) is not int or not 1 <= limit_bytes <= 2**63-1 or
                type(metadata_reserve_bytes) is not int or not 0 <= metadata_reserve_bytes < limit_bytes):
            raise ValueError('invalid_disk_budget')
        prepared=[]
        for value in paths:
            path=Path(value).absolute()
            if path.is_symlink() or path.is_dir() or not path.parent.is_dir():
                raise ValueError('managed_database_file_required')
            prepared.append(path.resolve())
        if len(set(prepared))!=len(prepared) or len({path.parent.stat().st_dev for path in prepared})!=1:
            raise ValueError('distinct_managed_files_on_one_volume_required')
        self.paths=tuple(sorted(prepared))
        self.limit_bytes,self.metadata_reserve_bytes=limit_bytes,metadata_reserve_bytes

    def config(self):
        return {'paths':[str(path) for path in self.paths],'limit_bytes':self.limit_bytes,
                'metadata_reserve_bytes':self.metadata_reserve_bytes}

    def sample(self, reserved_bytes=0):
        if type(reserved_bytes) is not int or reserved_bytes<0:
            raise ValueError('invalid_disk_reservations')
        managed,seen=0,set()
        for path in self.paths:
            for suffix in ('','-wal','-shm','-journal'):
                file=Path(str(path)+suffix)
                if file.is_symlink():raise ValueError('managed_file_symlink')
                try:info=file.stat()
                except FileNotFoundError:continue
                identity=(info.st_dev,info.st_ino)
                if identity not in seen:
                    managed+=info.st_size;seen.add(identity)
        free=shutil.disk_usage(self.paths[0].parent).free
        headroom=self.metadata_reserve_bytes+reserved_bytes
        available=max(0,min(self.limit_bytes-managed-headroom,free-headroom))
        return {'managed_bytes':managed,'disk_free_bytes':free,'disk_limit_bytes':self.limit_bytes,
                'metadata_reserve_bytes':self.metadata_reserve_bytes,'reserved_bytes':reserved_bytes,
                'available_bytes':available,
                'within_limit':managed+headroom<=self.limit_bytes and headroom<=free}

    def require(self, amount, reserved_bytes=0):
        if type(amount) is not int or amount<0 or amount>self.sample(reserved_bytes)['available_bytes']:
            raise ValueError('managed_disk_budget_exceeded')
