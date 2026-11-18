"""Prepare a headless systemd unit or run the verified source in foreground.

Does not install/enable units or replace an existing installation.
"""
import argparse
import os
from pathlib import Path,PurePosixPath
import re
import subprocess
import sys
from release_v1 import canonical,parse
from server_install import directory,verify


def command(version,bundle,archive,trust,minimum,environment,lock_pin,config,*,accepted_at=None):
    if sys.platform!='linux':raise ValueError('linux_service_required')
    # Historical time is only for an already-admitted installed release recorded
    # in the protected supervisor journal; new admissions always use real time.
    verify(version,bundle,archive,trust,minimum,accepted_at=accepted_at)
    environment=directory(environment);version=directory(version);config=Path(config)
    receipt=environment/'environment-ready.json'
    if receipt.is_symlink():raise ValueError('environment_receipt_link')
    value=parse(receipt.read_bytes())
    python=environment/'venv/bin/python'
    if value!={'domain':'sphere-headless-environment-v1','wheel_lock_sha256':lock_pin,'python':str(python),'service_started':False}:raise ValueError('approved_environment_required')
    if python.is_symlink() or not python.is_file():raise ValueError('environment_python_required')
    if not config.is_absolute() or config.is_symlink() or not config.is_file():raise ValueError('operator_configuration_required')
    entry=version/'scripts/mesh_point.py'
    clean={key:value for key,value in os.environ.items() if not key.startswith(('PYTHON','PIP_','VIRTUAL_ENV','LD_'))}
    clean.update({'PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1'})
    subprocess.run([str(python),'-B','-E','-s',str(entry),'check-config','--config',str(config)],check=True,env=clean,timeout=30)
    return [str(python),'-B','-E','-s',str(entry),'run','--config',str(config)],clean


def unit(argv,state,user):
    if not re.fullmatch('[a-z_][a-z0-9_-]{0,30}',user) or user=='root':raise ValueError('dedicated_unprivileged_service_user_required')
    # Restrict to unambiguous systemd arguments; never interpolate a shell.
    state=str(state)
    if not PurePosixPath(state).is_absolute() or '..' in PurePosixPath(state).parts or any(not re.fullmatch('[A-Za-z0-9_./-]+',item) for item in [*argv,state]):raise ValueError('simple_absolute_service_paths_required')
    return '\n'.join(['[Unit]','Description=Sphere verified headless point','After=network-online.target','Wants=network-online.target','',
        '[Service]','Type=simple','User='+user,'Group='+user,'ExecStart='+' '.join(argv),'Restart=on-failure','RestartSec=5',
        'TimeoutStopSec=45','UMask=0077','NoNewPrivileges=true','PrivateTmp=true','ProtectSystem=strict','ProtectHome=true',
        'ReadWritePaths='+state,'Environment=PYTHONDONTWRITEBYTECODE=1','','[Install]','WantedBy=multi-user.target',''])


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=('run','render-unit'))
    for name in ('version','manifest','archive','trust','environment','lock-sha256','config'):parser.add_argument('--'+name,required=True)
    parser.add_argument('--minimum-sequence',required=True,type=int);parser.add_argument('--user',default='sfera');parser.add_argument('--output')
    args=parser.parse_args();bundle=parse(Path(args.manifest).read_bytes());trust=parse(Path(args.trust).read_bytes())
    argv,env=command(args.version,bundle,args.archive,trust,args.minimum_sequence,args.environment,args.lock_sha256,args.config)
    if args.action=='run':os.execve(argv[0],argv,env)
    else:
        if not args.output:parser.error('--output required')
        state=parse(Path(args.config).read_bytes())['state_directory'];text=unit(argv,state,args.user)
        with Path(args.output).open('x',encoding='ascii') as output:output.write(text)
        print(canonical({'unit_written':True,'service_started':False,'service_enabled':False}).decode())


if __name__=='__main__':main()
