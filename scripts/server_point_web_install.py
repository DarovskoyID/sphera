"""Install the same publisher-signed web entry on an existing ordinary point."""
import hashlib
import io
import json
import os
from pathlib import Path,PurePosixPath
import pwd
import subprocess
import sys
import tarfile
import time
import zipfile

ROOT=Path('/opt/sphere-point');WEB=Path('/opt/sphere-web')


def command(args):return subprocess.run(list(map(str,args)),check=True,timeout=120)


def main():
    os.umask(0o077)
    with zipfile.ZipFile(sys.argv[0]) as archive:job=json.loads(archive.read('job.json'))
    path=ROOT/'code/preparing.json'
    if not path.exists():path=ROOT/'code/pending.json'
    settings=json.loads(path.read_bytes());version=Path(settings['version']);sys.path[:0]=[str(version/'scripts'),str(version/'django-server/sfera_server')]
    from server_point_install import asset
    from sfera_mesh.identity import node_id
    from cryptography import x509
    config=json.loads((ROOT/'data/point.json').read_bytes());host=config['public_endpoint'].split('://')[1].split(':')[0];own=next(n for n in job['nodes'] if n['host']==host)
    public=x509.load_pem_x509_certificate(Path(config['tls_certificate']).read_bytes()).public_key().public_bytes_raw()
    if config['network']!=job['network'] or public.hex()!=own['public_key'] or node_id(public)!=own['node_id']:raise ValueError('web_point_identity_pin')
    if not WEB.exists():
        result=subprocess.run(['ss','-Hlnt','sport = :80 or sport = :443 or sport = :9080'],capture_output=True,text=True,check=True,timeout=10)
        if result.stdout.strip():raise ValueError('existing_web_listener_preserved')
    try:user=pwd.getpwnam('sphere-web')
    except KeyError:command(['useradd','--system','--user-group','--no-create-home','--shell','/usr/sbin/nologin','sphere-web']);user=pwd.getpwnam('sphere-web')
    if user.pw_uid==0:raise ValueError('unprivileged_web_account_required')
    WEB.mkdir(mode=0o750,exist_ok=True);os.chown(WEB,0,user.pw_gid);WEB.chmod(0o750)
    code=WEB/'code';code.mkdir(mode=0o750,exist_ok=True);os.chown(code,0,user.pw_gid);code.chmod(0o750)
    def write(path,raw,executable=False):
        if path.is_symlink():raise ValueError('web_file_link')
        temporary=path.with_suffix(path.suffix+'.pending');temporary.write_bytes(raw);os.chmod(temporary,0o750 if executable else 0o640);os.chown(temporary,0,user.pw_gid);os.replace(temporary,path)
    bundle=asset(job['site'],code/('web-'+job['site']['sha256'][:16]+'.tar.gz'),4*1048576)
    with tarfile.open(bundle,'r:gz') as tar:
        for member in tar.getmembers():
            parts=PurePosixPath(member.name).parts
            if not member.isfile() or member.size>2*1048576 or member.name.startswith('/') or '..' in parts or member.name not in ('site/index.html','site/main.js','site/main.css','server_point_web.py'):raise ValueError('bounded_web_bundle_required')
            dest=WEB/member.name;dest.parent.mkdir(mode=0o750,exist_ok=True);os.chown(dest.parent,0,user.pw_gid);dest.parent.chmod(0o750);write(dest,tar.extractfile(member).read())
    caddy_archive=asset(job['caddy'],code/'caddy.tar.gz',64*1048576)
    with tarfile.open(caddy_archive,'r:gz') as tar:
        member=tar.getmember('caddy')
        if not member.isfile() or not 1<=member.size<=128*1048576:raise ValueError('bounded_caddy_binary_required')
        write(code/'caddy',tar.extractfile(member).read(),True)
    state=WEB/'state';state.mkdir(mode=0o700,exist_ok=True);os.chown(state,user.pw_uid,user.pw_gid)
    write(WEB/'network-ca.pem',Path(config['point_registration']['ca_certificate']).read_bytes());write(WEB/'genesis.json',Path(config['genesis']).read_bytes())
    bridge={'version':str(version),'network':config['network'],'nodeId':own['node_id'],'publicKey':own['public_key'],'origin':'https://'+host,'label':own['label'],'state':str(state),'ca':str(WEB/'network-ca.pem'),'genesis':str(WEB/'genesis.json'),'verifier':config['verifier_binary'],'gateway':config['consensus_gateways'][0],'peers':[{'label':n['label'],'url':'https://'+n['host'],'nodeId':n['node_id']} for n in job['nodes']]}
    write(WEB/'bridge.json',json.dumps(bridge).encode())
    caddy='''{
 admin off
}
https://HOST {
 tls {
  issuer acme https://acme-v02.api.letsencrypt.org/directory {
   profile shortlived
  }
 }
 header {
  X-Content-Type-Options nosniff
  Referrer-Policy no-referrer
  Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
 }
 handle /mesh/auth/* {
  reverse_proxy https://127.0.0.1:8443 {
   transport http {
    tls_server_name HOST
    tls_trust_pool file /opt/sphere-web/network-ca.pem
   }
  }
 }
 handle /web-api/* {
  reverse_proxy 127.0.0.1:9080
 }
 handle {
  root * /opt/sphere-web/site
  header Cache-Control no-cache
  try_files {path} /index.html
  file_server
 }
}
'''.replace('HOST',host)
    write(WEB/'Caddyfile',caddy.encode());command([code/'caddy','validate','--config',WEB/'Caddyfile','--adapter','caddyfile'])
    python=ROOT/'code/environment/venv/bin/python'
    if 'environment' in settings:python=Path(settings['environment'])/'venv/bin/python'
    common='[Unit]\nAfter=network-online.target\nWants=network-online.target\n[Service]\nUser=sphere-web\nGroup=sphere-web\nSupplementaryGroups=sphere-point\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=/opt/sphere-web/state\nRestart=on-failure\nRestartSec=5\nEnvironment=PYTHONDONTWRITEBYTECODE=1\nEnvironment=HOME=/opt/sphere-web/state\nEnvironment=XDG_DATA_HOME=/opt/sphere-web/state\nEnvironment=XDG_CONFIG_HOME=/opt/sphere-web/state\n'
    services={'sphere-web.service':common+'ExecStart='+str(python)+' -B '+str(WEB/'server_point_web.py')+' --config '+str(WEB/'bridge.json')+'\n[Install]\nWantedBy=multi-user.target\n','sphere-web-edge.service':common+'AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\nExecStart='+str(code/'caddy')+' run --config '+str(WEB/'Caddyfile')+' --adapter caddyfile\n[Install]\nWantedBy=multi-user.target\n'}
    for name,text in services.items():
        target=Path('/etc/systemd/system')/name
        if target.exists() and not (WEB/'installation.json').exists():raise ValueError('existing_web_unit_preserved')
        target.write_text(text);target.chmod(0o644)
    command(['systemctl','daemon-reload'])
    if subprocess.run(['which','ufw'],capture_output=True).returncode==0 and 'Status: active' in subprocess.run(['ufw','status'],capture_output=True,text=True).stdout:
        command(['ufw','allow','80/tcp']);command(['ufw','allow','443/tcp'])
    for unit in services:command(['systemctl','enable','--now',unit]);command(['systemctl','restart',unit])
    result={'host':host,'url':'https://'+host,'node_id':own['node_id'],'web_services_started':True,'node_private_key_copied':False,'public_https_pending_verification':True};write(WEB/'installation.json',json.dumps(result).encode());print('SPHERE_WEB_INSTALLED='+json.dumps(result),flush=True)


if __name__=='__main__':main()
