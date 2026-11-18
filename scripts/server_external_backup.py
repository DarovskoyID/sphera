"""Stopped point + CometBFT + PostgreSQL encrypted disaster-recovery bundle.

Never restores over live data or starts a restored validator signer.
"""
import argparse
from contextlib import contextmanager,ExitStack
import hashlib
import io
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
from release_v1 import canonical,parse
from server_backup import encrypt,decrypt,digest,MAX_SIZE
from server_point_backup import safe_name
from server_maintenance import private_file
from server_state import point_lock


def validate(value):
    if not isinstance(value,dict) or set(value)!={'domain','units','point_config','comet_home','postgres'} or value['domain']!='sphere-external-backup-v1':raise ValueError('external_backup_schema')
    units=value['units']
    if not isinstance(units,list) or not 1<=len(units)<=16 or len(set(units))!=len(units) or any(not isinstance(u,str) or not re.fullmatch(r'[A-Za-z0-9_@.-]+\.service',u) for u in units):raise ValueError('explicit_quiesced_units_required')
    for field in ('point_config','comet_home'):
        if value[field] is not None and (not isinstance(value[field],str) or not Path(value[field]).is_absolute()):raise ValueError('absolute_backup_sources')
    pg=value['postgres']
    if pg is not None:
        if not isinstance(pg,dict) or set(pg)!={'service','service_file'} or not re.fullmatch('[A-Za-z][A-Za-z0-9_-]{0,63}',pg['service']):raise ValueError('postgres_service_profile_required')
        private_file(pg['service_file'])
    if not any(value[k] is not None for k in ('point_config','comet_home','postgres')):raise ValueError('backup_components_required')
    return value


def command(argv,*,env=None,timeout=120):
    result=subprocess.run(argv,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
    if result.returncode:raise ValueError('external_backup_command_failed')
    return result.stdout


def restart_lease(folder,units,control):
    journal=folder/'restart.json'
    if not journal.exists():return
    value=parse(private_file(journal).read_bytes())
    if set(value)!={'domain','units','active'} or value['domain']!='sphere-quiesced-services-v1' or value['units']!=units or not isinstance(value['active'],list) or len(set(value['active']))!=len(value['active']) or not set(value['active'])<=set(units):raise ValueError('quiesce_recovery_context')
    for unit in reversed(value['active']):control(['systemctl','start',unit])
    journal.unlink()
    fd=os.open(folder,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)


def recover_services(units,output,*,control=command):
    folder=Path(output)/'.quiesce'
    if not folder.exists():return {'interrupted_services_recovered':True}
    with point_lock(folder):restart_lease(folder,units,control)
    return {'interrupted_services_recovered':True}


@contextmanager
def quiesced(units,control=command,*,journal_directory=None):
    with ExitStack() as resources:
        folder=None
        if journal_directory is not None:
            folder=Path(journal_directory)/'.quiesce'
            if folder.is_symlink():raise ValueError('quiesce_state_link')
            folder.mkdir(mode=0o700,exist_ok=True)
            if folder.stat().st_uid!=os.geteuid() or folder.stat().st_mode&0o077:raise ValueError('private_quiesce_state_required')
            resources.enter_context(point_lock(folder))
            restart_lease(folder,units,control)
        active=[]
        for unit in units:
            state=control(['systemctl','show','--property=ActiveState','--value',unit]).decode().strip()
            if state not in ('active','inactive','failed'):raise ValueError('service_transition_in_progress')
            if state=='active':active.append(unit)
        if folder:
            with os.fdopen(os.open(folder/'restart.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as output:
                output.write(canonical({'domain':'sphere-quiesced-services-v1','units':units,'active':active}));output.flush();os.fsync(output.fileno())
            fd=os.open(folder,os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(fd)
            finally:os.close(fd)
        try:
            for unit in active:control(['systemctl','stop',unit])
            for unit in units:
                if control(['systemctl','show','--property=ActiveState','--value',unit]).decode().strip() not in ('inactive','failed'):raise ValueError('backup_services_not_stopped')
            yield active
        finally:
            if folder:restart_lease(folder,units,control)
            else:
                errors=[]
                for unit in reversed(active):
                    try:control(['systemctl','start',unit])
                    except Exception:errors.append(unit)
                if errors:raise ValueError('backup_service_restart_failed')


def postgres_env(profile):
    # Do not inherit ambient credentials, service selectors or injected libraries.
    env={k:v for k,v in os.environ.items() if not k.startswith(('PG','LD_','PYTHON'))}
    env['PGSERVICEFILE']=str(private_file(profile['service_file']));env['PGCONNECT_TIMEOUT']='10'
    return env


def collect_tree(root,prefix):
    root=Path(root)
    if any(p.is_symlink() for p in (root,*root.parents)) or not root.is_dir():raise ValueError('regular_backup_tree_required')
    files={}
    for parent,dirs,names in os.walk(root,followlinks=False):
        if any((Path(parent)/d).is_symlink() for d in dirs):raise ValueError('backup_tree_link')
        for name in names:
            path=Path(parent)/name;relative=path.relative_to(root).as_posix();target=prefix+'/'+relative
            if not safe_name(target) or path.is_symlink() or not path.is_file():raise ValueError('backup_tree_special_file')
            files[target]=path
            if len(files)>20000:raise ValueError('backup_file_limit')
    return files


def backup(profile,destination,password,*,control=command,pg_command=command):
    profile=validate(profile);destination=Path(destination)
    if not destination.is_absolute() or destination.exists() or destination.is_symlink() or not destination.parent.is_dir():raise ValueError('new_external_backup_required')
    if profile['comet_home'] and destination.resolve().is_relative_to(Path(profile['comet_home']).resolve()):raise ValueError('backup_outside_source_required')
    with tempfile.TemporaryDirectory(prefix='sphere-disaster-',dir=destination.parent) as temporary:
        folder=Path(temporary);os.chmod(folder,0o700);records={};sources={};signer=None
        with quiesced(profile['units'],control,journal_directory=destination.parent):
            if profile['point_config']:
                from server_point_backup import backup as point_backup
                point_backup(profile['point_config'],folder/'point.enc',password);sources['point.enc']=folder/'point.enc'
            if profile['postgres']:
                pg=profile['postgres'];target=folder/'postgres.dump'
                pg_command(['pg_dump','--no-password','--format=custom','--dbname=service='+pg['service'],'--file='+str(target)],env=postgres_env(pg),timeout=3600)
                if not target.is_file() or target.stat().st_size<5:raise ValueError('postgres_custom_dump_required')
                with target.open('rb') as stream:
                    if stream.read(5)!=b'PGDMP':raise ValueError('postgres_custom_dump_required')
                pg_command(['pg_restore','--list',str(target)],timeout=120)
                sources['postgres.dump']=target
            if profile['comet_home']:
                home=Path(profile['comet_home']);sources.update(collect_tree(home,'comet'))
                for name in ('comet/config/genesis.json','comet/config/priv_validator_key.json','comet/data/priv_validator_state.json'):
                    if name not in sources:raise ValueError('complete_comet_signing_state_required')
                state=parse(sources['comet/data/priv_validator_state.json'].read_bytes())
                if set(state)-{'height','round','step','signature','signbytes'} or not {'height','round','step'}<=set(state) or not str(state['height']).isdigit():raise ValueError('comet_last_sign_state_required')
                signer={'genesis_sha256':digest(sources['comet/config/genesis.json']),'key_sha256':digest(sources['comet/config/priv_validator_key.json']),'last_sign_sha256':digest(sources['comet/data/priv_validator_state.json']),'height':str(state['height'])}
            total=0;archive=folder/'recovery.tar'
            with tarfile.open(archive,'w',format=tarfile.USTAR_FORMAT) as tar:
                for name,path in sorted(sources.items()):
                    size=path.stat().st_size;total+=size
                    if total>MAX_SIZE-4*1024*1024:raise ValueError('external_backup_size_limit')
                    before=digest(path);entry=tarfile.TarInfo(name);entry.size=size;entry.mode=0o600
                    with path.open('rb') as stream:tar.addfile(entry,stream)
                    if path.stat().st_size!=size or digest(path)!=before:raise ValueError('backup_source_changed_while_stopped')
                    records[name]={'size':size,'sha256':before}
                index=canonical({'domain':'sphere-disaster-recovery-v1','created_at':int(time.time()),'files':records,'comet_signer':signer,'requires_independent_checkpoint':True})
                entry=tarfile.TarInfo('recovery.json');entry.size=len(index);entry.mode=0o600;tar.addfile(entry,io.BytesIO(index))
            encrypt(archive,destination,password)
    return {'encrypted':True,'files':len(records),'comet_included':signer is not None,'postgres_included':'postgres.dump' in records,'restored_services_started':False}


def restore(source,destination,password):
    destination=Path(destination)
    if not destination.is_absolute() or destination.exists() or destination.is_symlink() or not destination.parent.is_dir():raise ValueError('new_isolated_recovery_directory_required')
    with tempfile.TemporaryDirectory(prefix='sphere-restore-',dir=destination.parent) as temporary:
        folder=Path(temporary);archive=folder/'authenticated.tar';decrypt(source,archive,password)
        staged=folder/'staged';staged.mkdir(mode=0o700)
        with tarfile.open(archive,'r:') as tar:
            members=tar.getmembers();seen=set();total=0
            for member in members:
                total+=member.size
                if not safe_name(member.name) or member.name in seen or not member.isfile() or member.issparse() or member.pax_headers or member.size<0 or total>MAX_SIZE or len(seen)>=20001:raise ValueError('recovery_archive_member')
                if member.name not in ('recovery.json','point.enc','postgres.dump') and not member.name.startswith('comet/'):raise ValueError('recovery_archive_path')
                seen.add(member.name)
            index_member=tar.getmember('recovery.json')
            if index_member.size>4*1024*1024:raise ValueError('recovery_index_size')
            index=parse(tar.extractfile(index_member).read(),4*1024*1024)
            if set(index)!={'domain','created_at','files','comet_signer','requires_independent_checkpoint'} or index['domain']!='sphere-disaster-recovery-v1' or index['requires_independent_checkpoint'] is not True or set(index['files'])!=seen-{'recovery.json'}:raise ValueError('recovery_inventory')
            for name,record in index['files'].items():
                member=tar.getmember(name)
                if not isinstance(record,dict) or set(record)!={'size','sha256'} or record['size']!=member.size:raise ValueError('recovery_size')
                target=staged/name;target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
                with tar.extractfile(member) as stream,target.open('xb') as output:shutil.copyfileobj(stream,output,1024*1024)
                target.chmod(0o600)
                if digest(target)!=record['sha256']:raise ValueError('recovery_hash')
        (staged/'recovery.json').write_bytes(canonical(index))
        if (staged/'point.enc').is_file():
            from server_point_backup import restore as point_restore
            # Relocated paths must refer to the final destination, not staging.
            point_restore(staged/'point.enc',staged/'point',password)
            relocated=staged/'point/point.relocated.json';raw=relocated.read_text();raw=raw.replace(str(staged/'point'),str(destination/'point'));relocated.write_text(raw)
        # A restored signer key is quarantined outside its runnable Comet home.
        # No restore or activation path can silently double-sign using an old H/R/S.
        if index['comet_signer']:
            signer=index['comet_signer']
            for name,key in (('comet/config/genesis.json','genesis_sha256'),('comet/config/priv_validator_key.json','key_sha256'),('comet/data/priv_validator_state.json','last_sign_sha256')):
                if digest(staged/name)!=signer[key]:raise ValueError('recovery_comet_context')
            quarantine=staged/'quarantine';quarantine.mkdir(mode=0o700)
            os.rename(staged/'comet/config/priv_validator_key.json',quarantine/'priv_validator_key.json')
        (staged/'RESTORE_REQUIRES_INDEPENDENT_CHECKPOINT.json').write_bytes(canonical({'domain':'sphere-disaster-restore-guard-v1','backup_sha256':digest(source),'validator_signing_enabled':False,'postgres_restored':False,'services_started':False}))
        destination.mkdir(mode=0o700)
        marker='RESTORE_REQUIRES_INDEPENDENT_CHECKPOINT.json'
        for path in sorted(staged.iterdir(),key=lambda p:p.name==marker):os.rename(path,destination/path.name)
    return {'isolated_restore':True,'validator_signing_enabled':False,'services_started':False}


def restore_postgres(recovery,profile,new_database,*,pg_command=command):
    recovery=Path(recovery)
    if not re.fullmatch('sphere_restore_[a-z0-9_]{1,40}',new_database):raise ValueError('dedicated_new_postgres_database_required')
    index=parse((recovery/'recovery.json').read_bytes());dump=recovery/'postgres.dump'
    if index['domain']!='sphere-disaster-recovery-v1' or digest(dump)!=index['files']['postgres.dump']['sha256']:raise ValueError('recovery_postgres_dump_changed')
    env=postgres_env(profile);env['PGSERVICE']=profile['service']
    # createdb fails if the name already exists. No --clean, DROP or overwrite.
    pg_command(['createdb','--no-password','--maintenance-db=service='+profile['service'],new_database],env=env)
    pg_command(['pg_restore','--no-password','--exit-on-error','--single-transaction','--no-owner','--no-privileges','--dbname='+new_database,str(dump)],env=env,timeout=3600)
    return {'postgres_restored_to_new_database':True,'database':new_database,'live_database_changed':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=('backup','restore','restore-postgres'));parser.add_argument('--profile');parser.add_argument('--password-file');parser.add_argument('--output');parser.add_argument('--source');parser.add_argument('--database');args=parser.parse_args()
    if args.action=='restore-postgres':
        profile=validate(parse(private_file(args.profile).read_bytes()));result=restore_postgres(args.source,profile['postgres'],args.database)
    else:
        password=private_file(args.password_file).read_text().rstrip('\r\n')
        result=backup(parse(private_file(args.profile).read_bytes()),args.output,password) if args.action=='backup' else restore(args.source,args.output,password)
    print(canonical(result).decode())


if __name__=='__main__':main()
