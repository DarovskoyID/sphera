"""Encrypted stopped headless-point backup and isolated recovery.

Includes point state, node/TLS keys, genesis, pinned verifier and configuration.
Does not back up external CometBFT or PostgreSQL, or authorize a rolled-back
identity to rejoin. Independent protocol checkpoints are required before reuse.
"""
import argparse
from contextlib import closing
import getpass
import hashlib
import io
import os
from pathlib import Path,PurePosixPath
import re
import sqlite3
import tarfile
import tempfile
from release_v1 import canonical,parse
from server_backup import encrypt,decrypt,integrity,MAX_SIZE,BLOCK
from server_install import directory
from server_state import point_lock

FILES={'node_key':'node.key','genesis':'genesis.json','verifier_binary':'mesh-verifier','tls_certificate':'tls.pem','tls_private_key':'tls.key'}


def safe_name(name):
    return isinstance(name,str) and re.fullmatch('[A-Za-z0-9_./-]+',name) and PurePosixPath(name).as_posix()==name and not PurePosixPath(name).is_absolute() and all(part not in ('','.','..') and not part.startswith('.') for part in name.split('/'))


def backup(config,destination,password):
    from mesh_point import validate_config,check_file
    config=check_file(config);value=validate_config(parse(config.read_bytes()));state=directory(value['state_directory']);destination=Path(destination)
    directory(destination.parent)
    if not destination.is_absolute() or destination.exists() or destination.is_symlink() or destination.is_relative_to(state):raise ValueError('new_backup_outside_state_required')
    with point_lock(state),tempfile.TemporaryDirectory(prefix='point-backup-',dir=destination.parent) as temporary:
        records={};sources={'operator/point.json':config}
        for key,name in FILES.items():sources['operator/'+name]=check_file(value[key],value.get(key.replace('_binary','')+'_sha256') if key=='verifier_binary' else value.get(key+'_sha256'))
        if 'assessment_service' in value:
            p=value['assessment_service'];sources['operator/assessor.key']=check_file(p['assessor_key'],p['assessor_sha256'])
        if 'point_registration' in value:
            p=value['point_registration'];sources['operator/network-ca.pem']=check_file(p['ca_certificate'],p['ca_sha256'])
        if 'enrollment_service' in value:
            p=value['enrollment_service']
            for field,pin,name in (('issuer_key','issuer_sha256','enrollment-issuer.key'),('ca_certificate','ca_sha256','enrollment-ca.pem'),('ca_key','ca_key_sha256','enrollment-ca.key')):
                sources['operator/'+name]=check_file(p[field],p[pin])
        for parent,dirs,files in os.walk(state,followlinks=False):
            if any((Path(parent)/name).is_symlink() for name in dirs):raise ValueError('point_backup_state_link')
            for name in files:
                path=Path(parent)/name;relative=path.relative_to(state).as_posix()
                if relative in ('point.lock','status.json') or relative.endswith(('.sqlite-wal','.sqlite-shm')):continue
                if path.is_symlink() or not path.is_file() or not safe_name(relative):raise ValueError('point_backup_state_file')
                sources['state/'+relative]=path
        if 'state/point-context.json' not in sources:raise ValueError('initialized_point_state_required')
        # Collapse any committed WAL into private SQLite copies while the entire
        # point is stopped; never copy a raw database without its committed WAL.
        for number,(name,path) in enumerate(list(sources.items())):
            if name.startswith('state/') and name.endswith('.sqlite'):
                snapshot=Path(temporary)/('database-'+str(number)+'.sqlite')
                with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)) as reader,closing(sqlite3.connect(snapshot)) as copy:
                    reader.backup(copy);integrity(copy)
                sources[name]=snapshot
        total=0;archive=Path(temporary)/'point.tar'
        with tarfile.open(archive,'w',format=tarfile.USTAR_FORMAT) as tar:
            for name,path in sorted(sources.items()):
                size=path.stat().st_size;total+=size
                if total>MAX_SIZE-4*1024*1024 or len(sources)>20000:raise ValueError('point_backup_size_limit')
                # Bounded memory by the existing backup size cap; snapshot operator
                # files too, since they must not change during maintenance.
                raw=path.read_bytes()
                if len(raw)!=size:raise ValueError('point_backup_source_changed')
                records[name]={'size':size,'sha256':hashlib.sha256(raw).hexdigest()}
                entry=tarfile.TarInfo(name);entry.size=size;entry.mode=0o600;tar.addfile(entry,io.BytesIO(raw))
            index=canonical({'domain':'sphere-stopped-point-backup-v1','files':records,'external_consensus_included':False,'postgresql_included':False})
            entry=tarfile.TarInfo('point-backup.json');entry.size=len(index);entry.mode=0o600;tar.addfile(entry,io.BytesIO(index))
        encrypt(archive,destination,password)
    return {'encrypted':True,'files':len(records),'point_was_stopped':True,'whole_server_backup':False}


def restore(source,destination,password):
    destination=Path(destination);directory(destination.parent)
    if not destination.is_absolute() or destination.exists() or destination.is_symlink():raise ValueError('new_isolated_point_restore_required')
    with tempfile.TemporaryDirectory(prefix='point-restore-',dir=destination.parent) as temporary:
        archive=Path(temporary)/'authenticated.tar';decrypt(source,archive,password)
        staged=Path(temporary)/'point';staged.mkdir(mode=0o700)
        with tarfile.open(archive,'r:') as tar:
            members=tar.getmembers();seen=set();total=0
            if not 3<=len(members)<=20001:raise ValueError('point_restore_inventory')
            for item in members:
                total+=item.size
                if not safe_name(item.name) or item.name in seen or not item.isfile() or item.issparse() or item.pax_headers or item.size<0 or total>MAX_SIZE:raise ValueError('point_restore_member')
                if item.name!='point-backup.json' and not item.name.startswith(('operator/','state/')):raise ValueError('point_restore_path')
                seen.add(item.name)
            index_member=tar.getmember('point-backup.json')
            if index_member.size>4*1024*1024:raise ValueError('point_restore_index_size')
            index=parse(tar.extractfile(index_member).read(),4*1024*1024)
            if not isinstance(index,dict) or set(index)!={'domain','files','external_consensus_included','postgresql_included'} or index['domain']!='sphere-stopped-point-backup-v1' or index['external_consensus_included'] is not False or index['postgresql_included'] is not False or not isinstance(index['files'],dict) or set(index['files'])!=seen-{'point-backup.json'}:raise ValueError('point_restore_inventory')
            required={'operator/point.json','state/point-context.json',*('operator/'+name for name in FILES.values())}
            if not required<=seen:raise ValueError('point_restore_required_files')
            for name,record in index['files'].items():
                member=tar.getmember(name)
                if not isinstance(record,dict) or set(record)!={'size','sha256'} or type(record['size']) is not int or record['size']!=member.size:raise ValueError('point_restore_record')
                target=staged/name;target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
                with tar.extractfile(member) as reader,target.open('xb') as output:
                    while chunk:=reader.read(BLOCK):output.write(chunk)
                target.chmod(0o600)
                with target.open('rb') as raw:
                    if hashlib.file_digest(raw,'sha256').hexdigest()!=record['sha256']:raise ValueError('point_restore_hash')
                if name.endswith('.sqlite'):
                    with closing(sqlite3.connect(target.as_uri()+'?mode=ro',uri=True)) as db:integrity(db)
        from mesh_point import validate_config,check_file
        value=validate_config(parse((staged/'operator/point.json').read_bytes()))
        check_file(staged/'operator/genesis.json',value['genesis_sha256']);check_file(staged/'operator/mesh-verifier',value['verifier_sha256'])
        from sfera_mesh.identity import load_identity,node_id
        context=parse((staged/'state/point-context.json').read_bytes())
        identity=node_id(load_identity(staged/'operator/node.key').public_key().public_bytes_raw())
        expected_context={'domain':'sphere-mesh-point-state-v1','node':identity,'network':value['network'],'genesis':value['genesis_sha256']}
        if value.get('health_observer',False):expected_context['health_observer']=True
        if value.get('replication_worker',False):expected_context['replication_worker']=True
        if 'controllers' in value:expected_context['controllers_sha256']=hashlib.sha256(canonical(value['controllers'])).hexdigest()
        if value.get('follow_network_peers'):expected_context['follow_network_peers']=True
        if 'point_registration' in value:expected_context['network_ca_sha256']=value['point_registration']['ca_sha256']
        if 'enrollment_service' in value:
            from mesh_enrollment import enrollment_binding
            expected_context['enrollment_sha256']=enrollment_binding(value['enrollment_service'])
            journal=staged/'state/enrollment.sqlite'
            if not journal.is_file() or journal.stat().st_size==0:raise ValueError('enrollment_state_missing_recovery_required')
            for field,pin,name in (('issuer_key','issuer_sha256','enrollment-issuer.key'),('ca_certificate','ca_sha256','enrollment-ca.pem'),('ca_key','ca_key_sha256','enrollment-ca.key')):
                check_file(staged/'operator'/name,value['enrollment_service'][pin])
                value['enrollment_service'][field]=str(destination/'operator'/name)
        if 'assessment_service' in value:
            from sfera_mesh.assessment_service import assessment_binding
            expected_context['assessment_sha256']=assessment_binding(value['assessment_service'])
            check_file(staged/'operator/assessor.key',value['assessment_service']['assessor_sha256'])
        if context!=expected_context:raise ValueError('point_restore_context')
        # Keep original operator config as evidence; provide a separate relocated
        # config. No automatic start or replacement of a live state directory.
        value['state_directory']=str(destination/'state')
        for key,name in FILES.items():value[key]=str(destination/'operator'/name)
        if 'assessment_service' in value:value['assessment_service']['assessor_key']=str(destination/'operator/assessor.key')
        if 'point_registration' in value:
            check_file(staged/'operator/network-ca.pem',value['point_registration']['ca_sha256'])
            value['point_registration']['ca_certificate']=str(destination/'operator/network-ca.pem')
        (staged/'point.relocated.json').write_bytes(canonical(value))
        (staged/'operator/mesh-verifier').chmod(0o700)
        review=canonical({'domain':'sphere-point-restore-review-v1','node':identity,'anti_rollback_validated':False,'service_started':False,'external_consensus_restored':False})
        (staged/'REQUIRES_INDEPENDENT_CHECKPOINT_VALIDATION.json').write_bytes(review)
        (staged/'state/RESTORE_REQUIRES_CHECKPOINT_VALIDATION.json').write_bytes(review)
        # Exclusively reserve a new destination. A failure can leave a partial
        # directory, but the final review marker is moved last as a barrier.
        destination.mkdir(mode=0o700)
        marker='REQUIRES_INDEPENDENT_CHECKPOINT_VALIDATION.json'
        for entry in sorted(staged.iterdir(),key=lambda entry:entry.name==marker):os.rename(entry,destination/entry.name)
    return {'isolated_point_restored':True,'anti_rollback_validated':False,'whole_server_restored':False,'service_started':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='command',required=True)
    create=sub.add_parser('backup');create.add_argument('--config',required=True);create.add_argument('--output',required=True)
    recover=sub.add_parser('restore');recover.add_argument('--backup',required=True);recover.add_argument('--destination',required=True)
    args=parser.parse_args();password=getpass.getpass('Encrypted stopped-point backup password: ')
    if args.command=='backup':
        if getpass.getpass('Repeat password: ')!=password:raise ValueError('backup_password_mismatch')
        result=backup(args.config,args.output,password)
    else:result=restore(args.backup,args.destination,password)
    print(canonical(result).decode())


if __name__=='__main__':main()
