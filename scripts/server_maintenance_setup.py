"""Render automatic ordinary-point maintenance from installer-owned settings."""
import hashlib
import os
from pathlib import Path
import secrets
import subprocess
from release_v1 import canonical,parse
from server_maintenance import timer


def write_owned(path,raw):
    path=Path(path)
    if path.exists():
        if path.is_symlink() or path.stat().st_uid!=os.geteuid() or path.read_bytes()!=raw:raise ValueError('existing_maintenance_configuration_preserved')
    else:
        with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as output:output.write(raw);output.flush();os.fsync(output.fileno())


def setup(root,settings,point_config,python,*,unit_directory=Path('/etc/systemd/system'),enable=True):
    root=Path(root);folder=root/'maintenance';backups=root/'backups'
    for path in (folder,backups):
        if path.exists() and (path.is_symlink() or path.stat().st_uid!=os.geteuid() or path.stat().st_mode&0o077):raise ValueError('private_maintenance_directory_required')
        path.mkdir(mode=0o700,exist_ok=True)
    # Keep root backup configuration independent of application-writable config.
    point_file=folder/'point.json';write_owned(point_file,canonical(point_config))
    ca=Path(point_config['point_registration']['ca_certificate']).read_bytes()
    if hashlib.sha256(ca).hexdigest()!=settings['profile']['ca']['sha256']:raise ValueError('maintenance_ca_pin')
    write_owned(folder/'network-ca.pem',ca)
    key=folder/'backup-password'
    if not key.exists():write_owned(key,secrets.token_urlsafe(48).encode())
    elif key.is_symlink() or key.stat().st_uid!=os.geteuid() or key.stat().st_mode&0o077:raise ValueError('private_backup_password_required')
    profile={'domain':'sphere-external-backup-v1','units':['sphere-point.service'],'point_config':str(point_file),'comet_home':None,'postgres':None}
    write_owned(folder/'backup.json',canonical(profile))
    version=Path(settings['version']);job=[str(python),'-B',str(version/'scripts/server_backup_job.py'),'--profile',str(folder/'backup.json'),'--password-file',str(key),'--output-directory',str(backups)]
    from sfera_mesh.identity import load_identity,node_id
    identity=node_id(load_identity(point_config['node_key']).public_key().public_bytes_raw())
    recovery_job=[str(python),'-B',str(version/'scripts/server_backup_job.py'),'--profile',str(folder/'backup.json'),'--output-directory',str(backups),'--recover-services']
    config={'domain':'sphere-maintenance-v1','state_directory':str(folder),'jobs':{'recover_services':{'argv':recovery_job,'interval':60,'timeout':120},'backup':{'argv':job,'interval':21600,'timeout':3600}},
        'monitor':{'endpoint':point_config['public_endpoint'],'ca_certificate':str(folder/'network-ca.pem'),'failure_threshold':3,'recovery_threshold':2,'node_key':point_config['node_key'],'node':identity,'network':point_config['network']},'alerts':None}
    write_owned(folder/'maintenance.json',canonical(config))
    service,schedule=timer(python,version/'scripts/server_maintenance.py',folder/'maintenance.json')
    write_owned(Path(unit_directory)/'sphere-maintenance.service',service.encode())
    write_owned(Path(unit_directory)/'sphere-maintenance.timer',schedule.encode())
    if enable:
        subprocess.run(['systemctl','daemon-reload'],check=True)
        subprocess.run(['systemctl','enable','--now','sphere-maintenance.timer'],check=True)
    return {'scheduled_backup':True,'monitor_scheduled':True,'retained_backups':7,'independent_backup_configured':False,'external_alert_destination_configured':False}
