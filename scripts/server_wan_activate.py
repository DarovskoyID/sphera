"""Third-command activation of previously prepared, explicitly simulated VPS."""
import argparse
import base64
from datetime import datetime,timedelta,timezone
import grp
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import time
import zipfile

ROOT=Path('/opt/sphere-point');URL='https://github.com/DarovskoyID/sphera/releases/download/wan-trial-20261118/network-activation.json'


def save(path,raw):
    path=Path(path)
    if path.exists():
        if path.is_symlink() or path.read_bytes()!=raw:raise ValueError('existing_trial_file_differs:'+path.name)
    else:
        with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())


def cmd(argv):return subprocess.run(argv,check=True,timeout=180)


def unit(name,argv,*,user='root',writable=None):
    from release_v1 import canonical
    if any(not str(v).startswith('/') for v in (argv[0],)):raise ValueError('absolute_trial_command')
    logs=ROOT/'logs';logs.mkdir(mode=0o700,exist_ok=True)
    text='[Unit]\nDescription=Sphere WAN simulation '+name+'\nAfter=network-online.target\n[Service]\nType=simple\nUser='+user+'\nGroup='+user+'\nExecStart='+' '.join(map(str,argv))+'\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=60\nUMask=0077\nNoNewPrivileges=true\nEnvironment=PYTHONDONTWRITEBYTECODE=1\nStandardOutput=append:'+str(logs/name)+'.log\nStandardError=append:'+str(logs/name)+'.log\n[Install]\nWantedBy=multi-user.target\n'
    save(Path('/etc/systemd/system')/name,text.encode());cmd(['systemctl','daemon-reload']);cmd(['systemctl','enable','--now',name])


def bootstrap_seed(host):
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization,hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID
    from sfera_mesh.identity import create_identity,load_identity
    from release_v1 import canonical
    seed=ROOT/'seed';seed.mkdir(mode=0o700,exist_ok=True)
    issuer=load_identity(seed/'issuer.key') if (seed/'issuer.key').exists() else create_identity(seed/'issuer.key')
    key=load_identity(seed/'node.key') if (seed/'node.key').exists() else create_identity(seed/'node.key')
    if not (seed/'ca.key').exists():
        ca_key=ec.generate_private_key(ec.SECP256R1());now=datetime.now(timezone.utc);name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'Sphere WAN simulation CA')])
        ca=x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(ca_key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=5)).not_valid_after(now+timedelta(days=30)).add_extension(x509.BasicConstraints(ca=True,path_length=None),critical=True).sign(ca_key,hashes.SHA256())
        save(seed/'ca.key',ca_key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()));save(seed/'ca.pem',ca.public_bytes(serialization.Encoding.PEM))
    ca_key=serialization.load_pem_private_key((seed/'ca.key').read_bytes(),password=None);ca=x509.load_pem_x509_certificate((seed/'ca.pem').read_bytes())
    if not (seed/'tls.pem').exists():
        now=datetime.now(timezone.utc);leaf=x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'trial enrollment')])).issuer_name(ca.subject).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=5)).not_valid_after(now+timedelta(days=7)).add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address(host))]),critical=False).add_extension(x509.BasicConstraints(ca=False,path_length=None),critical=True).sign(ca_key,hashes.SHA256())
        save(seed/'tls.pem',leaf.public_bytes(serialization.Encoding.PEM));save(seed/'tls.key',key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
    save(seed/'bootstrap-public.json',canonical({'host':host,'issuer_public_key':issuer.public_key().public_bytes_raw().hex(),'ca_certificate':(seed/'ca.pem').read_text()}))
    print('SPHERE_BOOTSTRAP_PUBLIC_READY',flush=True)


def activate(profile,settings,receipt):
    from release_v1 import canonical
    from sfera_mesh.identity import load_identity,node_id
    from sfera_mesh.consensus_directory import ConsensusDirectory
    from sfera_mesh.consensus_gateway import GatewaySource
    from sfera_mesh.point_join import credential,publish,write_private
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    import ssl
    code=ROOT/'code';data=ROOT/'data';host=receipt['host'];python=code/'environment/venv/bin/python';version=Path(settings['version']);genesis=canonical(profile['genesis'])
    if profile['domain']!='sphere-wan-activation-v1' or profile['ownership_model']!='same-owner-simulation' or profile['network']!=receipt['network'] or profile['source_sha256']!=receipt['source_sha256']:raise ValueError('activation_network_context')
    own=next(n for n in profile['nodes'] if n['host']==host)
    for field in ('node_id','public_key','validator_address','p2p_id'):
        if own[field]!=receipt[field]:raise ValueError('activation_identity_changed')
    save(ROOT/'genesis.json',genesis);save(data/'genesis.json',genesis);save(data/'network-ca.pem',profile['ca_certificate'].encode())
    home=ROOT/'consensus'
    if not home.exists():os.rename(data/'consensus',home)
    if host in profile['validators']:
        save(home/'config/genesis.json',genesis)
        config={'domain':'sphere-validator-runtime-v1','home':str(home),'network':profile['network'],'genesis_sha256':hashlib.sha256(genesis).hexdigest(),'p2p_listen':'tcp://0.0.0.0:26656','p2p_external':'tcp://'+host+':26656',
            'persistent_peers':[n['p2p_id']+'@'+n['host']+':26656' for n in profile['nodes'] if n['host'] in profile['validators'] and n['host']!=host],'rpc_listen':'tcp://127.0.0.1:26657','max_inbound':16,'max_outbound':16}
        save(ROOT/'validator.json',canonical(config));cmd([str(code/'mesh-verifier'),'--node-config',str(ROOT/'validator.json'),'--check-node-config']);unit('sphere-trial-validator.service',[code/'mesh-verifier','--node-config',ROOT/'validator.json'])
    if host==profile['bootstrap_host']:
        with zipfile.ZipFile(sys.argv[0]) as archive:save(code/'trial-seed.py',archive.read('server_trial_seed.py'))
        unit('sphere-trial-seed.service',[python,'-B',code/'trial-seed.py'])
    if shutil.which('ufw'):
        result=subprocess.run(['ufw','status'],capture_output=True,text=True)
        if 'Status: active' in result.stdout:
            for port in (8443,26656,9443):cmd(['ufw','allow',str(port)+'/tcp'])
    os.environ['SSL_CERT_FILE']=str(data/'network-ca.pem');context=ssl.create_default_context(cafile=str(data/'network-ca.pem'));key=load_identity(data/'node.key');source=GatewaySource('https://'+profile['bootstrap_host']+':9443')
    directory=ConsensusDirectory(str(data/'bootstrap.sqlite'),str(code/'mesh-verifier'),str(data/'genesis.json'))
    try:
        deadline=time.monotonic()+600
        while True:
            try:directory.refresh(source);break
            except (ValueError,OSError):
                if time.monotonic()>deadline:raise
                time.sleep(5)
        joined=credential(key,directory,str(source),8443,x509.load_pem_x509_certificate((data/'network-ca.pem').read_bytes()),context=context);publish(key,directory,source,joined)
    finally:directory.close()
    write_private(data/'tls.key',key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()));write_private(data/'tls.pem',joined['certificate'].encode())
    identity=node_id(key.public_key().public_bytes_raw());state=data/'state';operations=data/'operations';state.mkdir(mode=0o700,exist_ok=True);operations.mkdir(mode=0o700,exist_ok=True)
    config={'domain':'sphere-mesh-point-runtime-v1','network':profile['network'],'listen_host':'0.0.0.0','listen_port':8443,'public_endpoint':joined['endpoint'],'state_directory':str(state),'node_key':str(data/'node.key'),
        'genesis':str(data/'genesis.json'),'genesis_sha256':hashlib.sha256(genesis).hexdigest(),'verifier_binary':str(code/'mesh-verifier'),'verifier_sha256':hashlib.sha256((code/'mesh-verifier').read_bytes()).hexdigest(),'tls_certificate':str(data/'tls.pem'),'tls_private_key':str(data/'tls.key'),
        'peers':{identity:{'public_key':key.public_key().public_bytes_raw().hex(),'endpoint':joined['endpoint']}},'consensus_rpc':[],'consensus_gateways':[str(source)],'max_blob_bytes':67108864,'max_connections':32,'replication_worker':True,'follow_network_peers':True,
        'point_registration':{'enrollment':str(source),'ca_certificate':str(data/'network-ca.pem'),'ca_sha256':hashlib.sha256((data/'network-ca.pem').read_bytes()).hexdigest()}}
    save(data/'point.json',canonical(config));deployment={'version':str(version),'manifest':str(code/'release.json'),'archive':str(next(code.glob('sphere-server-source-*.tar.gz'))),'environment':str(code/'environment'),'lock_sha256':settings['wheel_lock_sha256']}
    save(data/'deployment.json',canonical(deployment))
    try:user=pwd.getpwnam('sphere-point')
    except KeyError:cmd(['useradd','--system','--user-group','--no-create-home','--shell','/usr/sbin/nologin','sphere-point']);user=pwd.getpwnam('sphere-point')
    if user.pw_uid==0:raise ValueError('dedicated_point_account_required')
    for folder in (ROOT,code):os.chown(folder,0,user.pw_gid);os.chmod(folder,0o750)
    for parent,dirs,files in os.walk(code):
        for name in dirs:
            path=Path(parent)/name
            if not path.is_symlink():os.chown(path,0,user.pw_gid);os.chmod(path,0o750)
        for name in files:
            path=Path(parent)/name
            if not path.is_symlink():executable=bool(path.stat().st_mode&0o111);os.chown(path,0,user.pw_gid);os.chmod(path,0o750 if executable else 0o640)
    for parent,dirs,files in os.walk(data):
        os.chown(parent,user.pw_uid,user.pw_gid);os.chmod(parent,0o700)
        for name in files:os.chown(Path(parent)/name,user.pw_uid,user.pw_gid);os.chmod(Path(parent)/name,0o600)
    argv=[python,'-B',version/'scripts/server_update.py','--deployment',data/'deployment.json','--trust',code/'trust.json','--config',data/'point.json','--operations-directory',operations,'--minimum-sequence','9']
    unit('sphere-point.service',argv,user='sphere-point')
    from server_monitor import check
    deadline=time.monotonic()+180
    while not check(joined['endpoint'],context=context,key=key,network=profile['network'])['ready']:
        if time.monotonic()>deadline:raise ValueError('trial_point_readiness_timeout')
        time.sleep(3)
    result={'host':host,'network':profile['network'],'node_id':identity,'point_ready':True,'source_sequence':9,'consensus_rpc_public':False,'validator':host in profile['validators'],'ui_enabled':False,'ownership_model':'same-owner-simulation'}
    save(ROOT/'activation.json',canonical(result));print('SPHERE_ACTIVATED='+canonical(result).decode(),flush=True)


def main():
    os.umask(0o077);settings=json.loads((ROOT/'code/preparing.json').read_bytes());receipt=json.loads((ROOT/'preparation.json').read_bytes());version=Path(settings['version']);sys.path[:0]=[str(version/'scripts'),str(version/'django-server/sfera_server')]
    from release_v1 import parse,document,certificate
    from server_point_install import download
    trust=json.loads((ROOT/'code/trust.json').read_bytes())
    if receipt['host']=='38.180.140.174':bootstrap_seed(receipt['host'])
    deadline=time.monotonic()+1200
    while True:
        try:
            packet=parse(download(URL,32768));profile=document(packet,trust['root_public_key'],trust['channel'],'release');cert=certificate(packet['certificate'],trust['root_public_key'],trust['channel'],'release')
            if not profile['issued_at']<=int(time.time())<profile['expires_at']<=cert['expires_at']:raise ValueError('activation_profile_expired')
            break
        except OSError:
            if time.monotonic()>deadline:raise
            time.sleep(5)
    activate(profile,settings,receipt)
    if 'managed_roles' in profile:
        from server_wan_managed import activate_roles
        result=activate_roles(profile,settings,receipt);save(ROOT/'managed-activation.json',__import__('release_v1').canonical(result));print('SPHERE_MANAGED_ROLES='+json.dumps(result),flush=True)


if __name__=='__main__':main()
