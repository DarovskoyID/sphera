"""Scheduled encrypted backup with read-back validation and bounded retention."""
import argparse
import os
from pathlib import Path
import secrets
import shutil
import tempfile
import time
from release_v1 import canonical,parse
from server_maintenance import private_file
from server_state import point_lock
from server_install import directory
from server_external_backup import backup,restore,recover_services,validate
from server_backup import digest


def run(profile,password_file,output_directory,*,keep=7,replica_directory=None,creator=backup,validator=restore):
    if type(keep) is not int or not 2<=keep<=365:raise ValueError('backup_retention_range')
    output=directory(output_directory);password=private_file(password_file).read_text().rstrip('\r\n')
    if output.stat().st_uid!=os.geteuid() or output.stat().st_mode&0o077:raise ValueError('private_backup_output_required')
    with point_lock(output):
        if len(list(output.glob('sphere-backup-*.pending')))>=4:raise ValueError('unfinished_backup_attempt_limit')
        tag='sphere-backup-'+str(int(time.time()))+'-'+secrets.token_hex(8);pending=output/(tag+'.pending');target=output/(tag+'.enc')
        creator(profile,pending,password)
        # Authenticate and check inventory/SQLite before publishing success.
        with tempfile.TemporaryDirectory(prefix='readback-',dir=output) as temporary:validator(pending,Path(temporary)/'restored',password)
        os.rename(pending,target)
        fd=os.open(output,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)
        if replica_directory is not None:
            replica=directory(replica_directory)
            if replica.stat().st_dev==output.stat().st_dev:raise ValueError('independent_backup_filesystem_required')
            copy=replica/(tag+'.pending')
            with target.open('rb') as source,copy.open('xb') as stream:shutil.copyfileobj(source,stream);stream.flush();os.fsync(stream.fileno())
            copy.chmod(0o600)
            if digest(copy)!=digest(target):raise ValueError('backup_replica_hash')
            os.rename(copy,replica/target.name)
            fd=os.open(replica,os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(fd)
            finally:os.close(fd)
        # Only complete files produced by this job are eligible for retention.
        import re
        owned=sorted((p for p in output.iterdir() if re.fullmatch(r'sphere-backup-[0-9]+-[0-9a-f]{16}\.enc',p.name) and p.is_file() and not p.is_symlink()),key=lambda p:(p.stat().st_mtime_ns,p.name))
        for old in owned[:-keep]:old.unlink()
        return {'backup_verified':True,'filename':target.name,'independent_replica':replica_directory is not None}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('profile','output-directory'):p.add_argument('--'+name,required=True)
    p.add_argument('--password-file');p.add_argument('--recover-services',action='store_true')
    p.add_argument('--keep',type=int,default=7);p.add_argument('--replica-directory');a=p.parse_args()
    profile=validate(parse(private_file(a.profile).read_bytes()))
    if a.recover_services:result=recover_services(profile['units'],a.output_directory)
    else:
        if not a.password_file:p.error('--password-file required for backup')
        import signal
        def interrupted(*_):raise InterruptedError('scheduled_backup_cancelled')
        signal.signal(signal.SIGTERM,interrupted)
        result=run(profile,a.password_file,a.output_directory,keep=a.keep,replica_directory=a.replica_directory)
    print(canonical(result).decode())


if __name__=='__main__':main()
