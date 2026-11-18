"""Linux state-directory lifetime lock shared by runtime and stopped backups."""
from contextlib import contextmanager
import os
from pathlib import Path
import sys


@contextmanager
def point_lock(state):
    if sys.platform!='linux':raise ValueError('linux_state_lock_required')
    import fcntl
    state=Path(state)
    if not state.is_absolute() or any(path.is_symlink() for path in (state,*state.parents)) or not state.is_dir():raise ValueError('regular_state_directory_required')
    descriptor=os.open(state/'point.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        try:fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise ValueError('point_state_in_use_stop_service_first') from None
        yield
    finally:os.close(descriptor)
