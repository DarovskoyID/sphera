"""Signed distributed-registration deployment on existing licensed web points.

Stages are preparation, stopped verifier handoff and public activation. All
software comes from hash-bound GitHub assets. Private point keys stay in place.
"""
import hashlib
import json
import os
from pathlib import Path,PurePosixPath
import pwd
import re
import shlex
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile

POINT=Path('/opt/sphere-point');APP=Path('/opt/sphere-application');WEB=Path('/opt/sphere-web')


def run(argv,**kwargs):
    return subprocess.run([str(arg) for arg in argv],check=True,**kwargs)


def own(path,uid,gid,mode):
    os.chown(path,uid,gid);Path(path).chmod(mode)


def private_json(path,value,user):
    from server_verifier_transition import replace_private
    from release_v1 import canonical
    if hasattr(user,'pw_uid'):
        from types import SimpleNamespace
        user=SimpleNamespace(st_uid=user.pw_uid,st_gid=user.pw_gid)
    replace_private(path,canonical(value),user)


def extract_source(archive,target,gid):
    from server_release import archive_members
    archive_members(archive)
    target.mkdir(mode=0o750,parents=True,exist_ok=True);own(target,0,gid,0o750)
    with tarfile.open(archive,'r:gz') as stream:
        for item in stream:
            dest=target/item.name
            for parent in reversed(dest.parents):
                if parent==target or target in parent.parents:
                    if parent.is_symlink():raise ValueError('application_source_link')
                    parent.mkdir(mode=0o750,exist_ok=True);own(parent,0,gid,0o750)
            if dest.is_symlink():raise ValueError('application_source_link')
            raw=stream.extractfile(item).read()
            if dest.exists() and dest.read_bytes()!=raw:raise ValueError('application_source_changed')
            if not dest.exists():dest.write_bytes(raw)
            own(dest,0,gid,0o640)


def wait_service(name):
    run(['systemctl','is-active','--quiet',name])


def http(path):
    request=urllib.request.Request('http://127.0.0.1:9091'+path,headers={'Host':'127.0.0.1'})
    with urllib.request.urlopen(request,timeout=30) as response:
        if response.status!=200:raise ValueError('application_not_ready')
        return json.loads(response.read(1048576))


def main(action_override=None):
    os.umask(0o077)
    os.environ['PYTHONDONTWRITEBYTECODE']='1'
    settings=POINT/'code/preparing.json'
    if not settings.exists():settings=POINT/'code/pending.json'
    current=json.loads(settings.read_bytes());old_source=Path(current['version'])
    sys.path[:0]=[str(old_source/'scripts'),str(old_source/'django-server/sfera_server')]
    from server_point_install import asset
    with zipfile.ZipFile(sys.argv[0]) as package:job=json.loads(package.read('job.json'))
    point_path=POINT/'data/point.json';point=json.loads(point_path.read_bytes())
    web=json.loads((WEB/'installation.json').read_bytes());host=web['host']
    if host not in job['hosts'] or point['network']!=job['network'] or point['genesis_sha256']!=job['genesis']:
        raise ValueError('application_deployment_network_pin')
    user=pwd.getpwnam('sphere-point');web_user=pwd.getpwnam('sphere-web')
    for folder in (APP,APP/'assets',APP/'code',APP/'environments'):
        folder.mkdir(mode=0o750,parents=True,exist_ok=True);own(folder,0,user.pw_gid,0o750)
    source_archive=asset(job['source'],APP/'assets'/('source-'+job['source']['sha256']+'.tar.gz'),32*1048576)
    source=APP/'code'/job['source']['sha256'];extract_source(source_archive,source,user.pw_gid)
    # The helper itself is inside the hash-bound source snapshot.
    sys.path[:0]=[str(source/'scripts'),str(source/'django-server/sfera_server')]
    binary_dir=POINT/'code/verifiers'/job['verifier']['sha256'];binary_dir.mkdir(mode=0o750,parents=True,exist_ok=True)
    own(binary_dir.parent,0,user.pw_gid,0o750);own(binary_dir,0,user.pw_gid,0o750)
    binary=asset(job['verifier'],binary_dir/'mesh-verifier',128*1048576);own(binary,0,user.pw_gid,0o750)
    action=action_override or job['action']
    if action=='complete':
        for stage in ('turn','prepare','enable','realtime'):main(stage)
        return
    if action=='turn':
        from server_application_turn import install
        print(json.dumps(install(APP,host,user,run,own,private_json)),flush=True)
        return
    if action=='prepare':
        wheel_archive=asset(job['wheels'],APP/'assets'/('wheels-'+job['wheels']['sha256']+'.tar.gz'),64*1048576)
        wheels=APP/'assets'/('wheels-'+job['wheels']['sha256']);wheels.mkdir(mode=0o750,exist_ok=True)
        seen=set()
        with tarfile.open(wheel_archive,'r:gz') as stream:
            for item in stream:
                if (not item.isfile() or item.name not in job['wheel_files'] or PurePosixPath(item.name).name!=item.name
                        or item.name in seen or item.size>32*1048576):raise ValueError('application_wheel_path')
                raw=stream.extractfile(item).read()
                if hashlib.sha256(raw).hexdigest()!=job['wheel_files'][item.name]:raise ValueError('application_wheel_digest')
                dest=wheels/item.name
                if dest.exists() and dest.read_bytes()!=raw:raise ValueError('application_wheel_changed')
                if not dest.exists():dest.write_bytes(raw)
                seen.add(item.name)
        if seen!=set(job['wheel_files']):raise ValueError('application_wheel_set')
        envdir=APP/'environments'/job['wheels']['sha256'];python=envdir/'bin/python'
        if not python.exists():run([sys._base_executable,'-B','-m','venv',envdir])
        run([python,'-B','-m','pip','install','--no-index','--no-deps','--no-compile',*[wheels/name for name in sorted(seen)]])
        for parent,dirs,files in os.walk(envdir):
            own(parent,0,user.pw_gid,0o750)
            for name in files:
                path=Path(parent)/name
                if not path.is_symlink():own(path,0,user.pw_gid,0o750 if os.access(path,os.X_OK) else 0o640)
        data=APP/'data';data.mkdir(mode=0o700,exist_ok=True);own(data,user.pw_uid,user.pw_gid,0o700)
        for name in ('media','upload-tmp'):
            folder=data/name;folder.mkdir(mode=0o700,exist_ok=True);own(folder,user.pw_uid,user.pw_gid,0o700)
        config_path=data/'configuration.json'
        from sfera_mesh.identity import load_identity,node_id
        entry=node_id(load_identity(point['node_key']).public_key().public_bytes_raw())
        if config_path.exists():
            config=json.loads(config_path.read_bytes())
            if config['mesh']['entry']!=entry or config['mesh']['genesis']!=point['genesis']:
                raise ValueError('application_existing_identity_changed')
            if config['mesh'].get('verifier')!=str(binary):
                config['mesh']['verifier']=str(binary)
                private_json(config_path,config,user)
        else:
            from cryptography.fernet import Fernet
            import secrets
            config={'secret_key':secrets.token_hex(48),'message_encryption_key':Fernet.generate_key().decode(),
                'database':str(data/'application.sqlite'),'allowed_hosts':[host,'127.0.0.1'],
                'local_consensus_rpc':'http://127.0.0.1:26657' if host in job['validator_hosts'] else '',
                'mesh':{'identity_policy':'consensus-profile-v1','state':str(data/'directory.sqlite'),'sessions':str(data/'sessions.sqlite'),
                    'identity':point['node_key'],'entry':entry,'genesis':point['genesis'],'verifier':str(binary),
                    'rpc':'http://127.0.0.1:26657','gateways':job['gateways'],'gateway_ca':point['point_registration']['ca_certificate']}}
            private_json(config_path,config,user)
        env={**os.environ,'DJANGO_SETTINGS_MODULE':'sfera_distribution.settings','SFERA_DISTRIBUTED_CONFIG':str(config_path),
             'PYTHONPATH':str(source/'django-server/sfera_server'),'PYTHONDONTWRITEBYTECODE':'1'}
        for command in ('check','migrate'):
            args=[python,'-B','-m','django',command]
            if command=='migrate':args=[python,'-B','-m','sfera_distribution.upgrade']
            run(['runuser','-u','sphere-point','--',*args],env=env)
        unit=f'''[Unit]
Description=Sphere distributed application registration
After=network-online.target sphere-point.service
[Service]
User=sphere-point
Group=sphere-point
WorkingDirectory={source/'django-server/sfera_server'}
Environment=DJANGO_SETTINGS_MODULE=sfera_distribution.settings
Environment=SFERA_DISTRIBUTED_CONFIG={config_path}
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ExecStart={python} -B -m uvicorn sfera_distribution.asgi:application --host 127.0.0.1 --port 9091 --workers 1 --http h11 --ws websockets-sansio --ws-max-size 1048576 --lifespan off --limit-concurrency 256 --timeout-keep-alive 15 --no-proxy-headers
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths={data}
[Install]
WantedBy=multi-user.target
'''
        unit_path=Path('/etc/systemd/system/sphere-application.service')
        previous_unit=unit_path.read_bytes() if unit_path.exists() else None
        unit_path.write_text(unit)
        try:
            run(['systemctl','daemon-reload']);run(['systemctl','enable','sphere-application.service']);run(['systemctl','restart','sphere-application.service'])
            deadline=time.monotonic()+60
            while True:
                try:
                    wait_service('sphere-application.service');http('/api/distribution/config/');break
                except (OSError,ValueError,subprocess.CalledProcessError):
                    if time.monotonic()>=deadline:raise
                    time.sleep(1)
        except BaseException:
            if previous_unit is not None:
                unit_path.write_bytes(previous_unit);run(['systemctl','daemon-reload']);run(['systemctl','restart','sphere-application.service'])
            raise
        prepared={'host':host,'source':str(source),'python':str(python),'config':str(config_path),'verifier':str(binary),'prepared':True}
        private_json(APP/'prepared.json',prepared,(APP/'assets').stat())
        print(json.dumps(prepared),flush=True)
    elif action=='verifier':
        from server_verifier_transition import migrate
        receipts=POINT/'verifier-transitions';receipts.mkdir(mode=0o700,exist_ok=True);own(receipts,0,0,0o700)
        trust=json.loads((POINT/'code/trust.json').read_bytes())
        old_nonce=json.loads((POINT/'data/state/status.json').read_bytes()).get('runtime_nonce')
        run(['systemctl','stop','sphere-point.service'])
        try:result=migrate(point_path,POINT/'data/operations',trust,job['transition'],binary,receipts)
        finally:run(['systemctl','start','sphere-point.service'])
        deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            status=json.loads((POINT/'data/state/status.json').read_bytes())
            if status.get('runtime_nonce')!=old_nonce and status.get('consensus_snapshot_ready') and status.get('tls_listener_running'):break
            time.sleep(1)
        else:raise ValueError('point_not_ready_after_verifier_update')
        bridge=WEB/'bridge.json'
        if bridge.exists():
            value=json.loads(bridge.read_bytes());value['verifier']=str(binary)
            private_json(bridge,value,bridge.stat());own(bridge,0,web_user.pw_gid,0o640);run(['systemctl','restart','sphere-web.service'])
        # These auxiliary daemons also read the point's verifier configuration.
        # The seed used a hardcoded legacy path, so switch only its executable
        # script to the hash-bound source version; retain its private state.
        seed=run(['systemctl','show','--property','LoadState','--value','sphere-trial-seed.service'],capture_output=True,text=True).stdout.strip()
        if seed=='loaded':
            drop=Path('/etc/systemd/system/sphere-trial-seed.service.d');drop.mkdir(mode=0o755,exist_ok=True)
            (drop/'registration-verifier.conf').write_text('[Service]\nExecStart=\nExecStart='+str(POINT/'code/environment/venv/bin/python')+' -B '+str(source/'scripts/server_trial_seed.py')+'\n')
            run(['systemctl','daemon-reload']);run(['systemctl','restart','sphere-trial-seed.service'])
        for service in ('sphere-trial-assessment.service','sphere-trial-controller.service'):
            if run(['systemctl','show','--property','LoadState','--value',service],capture_output=True,text=True).stdout.strip()=='loaded':
                run(['systemctl','restart',service]);wait_service(service)
        print(json.dumps({'host':host,**result}),flush=True)
    elif action=='validator':
        unit='sphere-trial-validator.service'
        raw=run(['systemctl','show','--property','ExecStart','--value',unit],capture_output=True,text=True).stdout
        match=re.search(r'argv\[\]=(.*?)\s*;',raw)
        if not match:raise ValueError('validator_command_unrecognized')
        args=shlex.split(match[1])
        allowed={str(POINT/'code/mesh-verifier'),str(binary)}
        # Only the exact root-authorized predecessor may be replaced.
        if 'transition' in job:
            from server_verifier_transition import contract
            transition=contract(job['transition'],json.loads((POINT/'code/trust.json').read_bytes()))
            previous_binary=POINT/'code/verifiers'/transition['from_verifier']/'mesh-verifier'
            if previous_binary.is_file() and hashlib.sha256(previous_binary.read_bytes()).hexdigest()==transition['from_verifier']:
                allowed.add(str(previous_binary))
        if len(args)!=3 or args[1]!='--node-config' or args[0] not in allowed:
            raise ValueError('validator_command_unrecognized')
        config=Path(args[2])
        if (not config.is_relative_to(POINT/'consensus') and config!=POINT/'validator.json') or config.is_symlink():raise ValueError('validator_configuration_path')
        run([binary,'--node-config',config,'--check-node-config'])
        drop=Path('/etc/systemd/system')/(unit+'.d');drop.mkdir(mode=0o755,exist_ok=True)
        (drop/'registration-verifier.conf').write_text('[Service]\nExecStart=\nExecStart='+str(binary)+' --node-config '+str(config)+'\n')
        def height():
            with urllib.request.urlopen('http://127.0.0.1:26657/status',timeout=5) as response:
                return int(json.loads(response.read(1048576))['result']['sync_info']['latest_block_height'])
        previous=height()
        run(['systemctl','daemon-reload']);run(['systemctl','restart',unit]);wait_service(unit)
        deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            try:
                if height()>previous:break
            except (OSError,ValueError):pass
            time.sleep(1)
        else:raise ValueError('validator_did_not_rejoin_quorum')
        print(json.dumps({'host':host,'validator_updated':True,'validator_keys_changed':False}),flush=True)
    elif action=='enable':
        http('/api/distribution/config/')
        before=(WEB/'Caddyfile').read_text()
        receipt=json.loads((WEB/'original-app.json').read_bytes())
        if ('application_api_not_connected' not in before and 'reverse_proxy 127.0.0.1:9091' in before
                and receipt['site_sha256']==job['site']['sha256']):
            print(json.dumps({'host':host,'application_api_connected':True,'already_enabled':True}),flush=True);return
        # Reuse the existing verified static installer before replacing its
        # explicit 503 boundary with the real application reverse proxy.
        import server_point_web_app_install
        server_point_web_app_install.main()
        current_caddy=(WEB/'Caddyfile').read_text()
        if ('application_api_not_connected' not in current_caddy
                and 'reverse_proxy 127.0.0.1:9091' in current_caddy):
            print(json.dumps({'host':host,'application_api_connected':True,'site_updated':True,
                              'configuration':http('/api/distribution/config/')}),flush=True)
            return
        block=re.compile(r' handle /api/\* \{\n.*?application_api_not_connected.*?\n \}',re.S)
        replacement,count=block.subn(' handle /api/* {\n  reverse_proxy 127.0.0.1:9091\n }',current_caddy)
        if count!=1:raise ValueError('explicit_application_boundary_required')
        replacement=replacement.replace(' handle /api/* {',' handle /mesh/network/v1/rpc {\n  reverse_proxy 127.0.0.1:9091\n }\n handle /api/* {',1)
        pending=WEB/'Caddyfile.registration.pending';pending.write_text(replacement);own(pending,0,web_user.pw_gid,0o640)
        run([WEB/'code/caddy','validate','--config',pending,'--adapter','caddyfile'])
        backup=WEB/'Caddyfile.before-registration'
        if not backup.exists():backup.write_text(current_caddy);own(backup,0,web_user.pw_gid,0o640)
        os.replace(pending,WEB/'Caddyfile')
        try:run(['systemctl','restart','sphere-web-edge.service']);wait_service('sphere-web-edge.service')
        except BaseException:
            (WEB/'Caddyfile').write_text(current_caddy);run(['systemctl','restart','sphere-web-edge.service']);raise
        receipt=json.loads((WEB/'original-app.json').read_bytes());receipt['application_api_connected']=True
        private_json(WEB/'original-app.json',receipt,(WEB/'original-app.json').stat())
        own(WEB/'original-app.json',0,web_user.pw_gid,0o640)
        print(json.dumps({'host':host,'application_api_connected':True,'registration_mode':'distributed','configuration':http('/api/distribution/config/')}),flush=True)
    elif action=='realtime':
        before=(WEB/'Caddyfile').read_text()
        pattern=re.compile(r' handle /ws/\* \{\n  respond "Application WebSocket service is not connected\." 503\n \}')
        replacement,count=pattern.subn(' handle /ws/* {\n  reverse_proxy 127.0.0.1:9091\n }',before)
        if count==0:
            if 'handle /ws/* {\n  reverse_proxy 127.0.0.1:9091' not in before:raise ValueError('known_websocket_route_required')
        elif count!=1:raise ValueError('one_websocket_route_required')
        else:
            pending=WEB/'Caddyfile.realtime.pending';pending.write_text(replacement);own(pending,0,web_user.pw_gid,0o640)
            run([WEB/'code/caddy','validate','--config',pending,'--adapter','caddyfile'])
            os.replace(pending,WEB/'Caddyfile')
            try:run(['systemctl','restart','sphere-web-edge.service']);wait_service('sphere-web-edge.service')
            except BaseException:
                (WEB/'Caddyfile').write_text(before);run(['systemctl','restart','sphere-web-edge.service']);raise
        print(json.dumps({'host':host,'websocket_proxy':True,'configuration':http('/api/distribution/config/')}),flush=True)
    elif action=='bridge-permissions':
        bridge=WEB/'bridge.json'
        if bridge.is_symlink() or not bridge.is_file():raise ValueError('regular_web_configuration_required')
        own(bridge,0,web_user.pw_gid,0o640);run(['systemctl','restart','sphere-web.service']);wait_service('sphere-web.service')
        print(json.dumps({'host':host,'web_bridge_configuration_readable':True}),flush=True)
    elif action=='environment-repair':
        from server_update import Supervisor,read_json
        from server_environment_cache_repair import quarantine_bytecode
        trust=read_json(POINT/'code/trust.json');journal=read_json(POINT/'data/operations/update.json');active=journal['active']
        supervisor=Supervisor(POINT/'data/operations',trust,point_path,trust['minimum_sequence'])
        admitted,_,_=supervisor.admitted(active['deployment'],accepted_at=active['accepted_at'],minimum=active['sequence'])
        if (supervisor.policy!=journal['policy'] or {k:v for k,v in active.items() if k!='environment_sha256'}
                !={k:v for k,v in admitted.items() if k!='environment_sha256'}):raise ValueError('environment_repair_other_admission_inputs_changed')
        run(['systemctl','stop','sphere-point.service'])
        try:
            from server_state import point_lock
            with point_lock(POINT/'data/operations'),point_lock(Path(point['state_directory'])):
                removed=quarantine_bytecode(active['deployment']['environment'],active['environment_sha256'],active['accepted_at'],
                    APP/'quarantined-bytecode'/str(time.time_ns()))
        finally:run(['systemctl','start','sphere-point.service'])
        print(json.dumps({'host':host,'original_environment_hash_restored':True,'quarantined_cache_files':len(removed),'admission_journal_changed':False}),flush=True)
    elif action=='inspect':
        from server_update import Supervisor,read_json
        trust=read_json(POINT/'code/trust.json');journal=read_json(POINT/'data/operations/update.json');active=journal['active']
        supervisor=Supervisor(POINT/'data/operations',trust,point_path,trust['minimum_sequence'])
        admitted,_,_=supervisor.admitted(active['deployment'],accepted_at=active['accepted_at'],minimum=active['sequence'])
        differences={name:{'recorded':active.get(name),'calculated':admitted.get(name)} for name in set(active)|set(admitted) if active.get(name)!=admitted.get(name)}
        print(json.dumps({'host':host,'admission_policy_matches':supervisor.policy==journal['policy'],'differences':differences}),flush=True)
    else:raise ValueError('unknown_registration_deployment_action')


if __name__=='__main__':main()
