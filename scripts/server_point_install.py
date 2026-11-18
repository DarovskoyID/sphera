"""Consumer point installer. Network details are publisher-managed, never user roles."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import ssl
import subprocess
import sys
import time
from urllib.parse import urlsplit
from urllib.request import Request,build_opener,HTTPSHandler,ProxyHandler,HTTPRedirectHandler
import zipfile
from release_v1 import canonical,parse,document,certificate,manifest,trust_document
from server_release_client import GitHubRedirects
from server_install import prepare
from server_environment import build


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise ValueError('unapproved_install_redirect')


def download(url,limit,*,meta=None):
    value=urlsplit(url)
    if value.scheme!='https' or not value.hostname or value.username or value.password or value.fragment:raise ValueError('https_install_source_required')
    policy=GitHubRedirects(url) if value.hostname=='github.com' else NoRedirect()
    opener=build_opener(ProxyHandler({}),HTTPSHandler(context=ssl.create_default_context()),policy)
    with opener.open(Request(url,headers={'Accept-Encoding':'identity'}),timeout=15) as response:
        raw=response.read(limit+1)
        if response.status!=200 or len(raw)>limit or response.headers.get('Content-Encoding') not in (None,'identity'):raise ValueError('install_download_limit')
    if meta is not None and (len(raw)!=meta['size'] or hashlib.sha256(raw).hexdigest()!=meta['sha256']):raise ValueError('install_asset_hash_mismatch')
    return raw


def asset(meta,path,limit):
    if not isinstance(meta,dict) or set(meta)!={'url','sha256','size'} or type(meta['size']) is not int or not 1<=meta['size']<=limit:raise ValueError('install_asset_schema')
    path=Path(path)
    if path.exists():
        if path.is_symlink() or not path.is_file() or path.stat().st_size!=meta['size'] or hashlib.sha256(path.read_bytes()).hexdigest()!=meta['sha256']:raise ValueError('existing_install_asset_changed')
        return path
    raw=download(meta['url'],limit,meta=meta)
    import tempfile
    fd,temporary=tempfile.mkstemp(prefix='asset-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as output:output.write(raw);output.flush();os.fsync(output.fileno())
        os.link(temporary,path)
    finally:os.unlink(temporary)
    return path


def network_profile(packet,trust):
    trust_document(trust);body=document(packet,trust['root_public_key'],trust['channel'],'release');cert=certificate(packet['certificate'],trust['root_public_key'],trust['channel'],'release')
    fields={'domain','product','channel','sequence','issued_at','expires_at','network','genesis','ca','gateways','enrollment','verifier','wheels','source','port','max_blob_bytes'}
    now=int(time.time())
    if (not isinstance(body,dict) or set(body) not in (fields,fields|{'update_transition'}) or body['domain']!='sphere-point-network-v1' or body['product']!='sphere' or body['channel']!=trust['channel']
            or type(body['sequence']) is not int or body['sequence']<1 or type(body['issued_at']) is not int or type(body['expires_at']) is not int
            or not now-31*86400<=body['issued_at']<=now+5 or not now<body['expires_at']<=min(body['issued_at']+31*86400,cert['expires_at'])
            or not isinstance(body['gateways'],list) or not 1<=len(body['gateways'])<=8 or type(body['port']) is not int or not 1024<=body['port']<=65535
            or type(body['max_blob_bytes']) is not int or not 1<=body['max_blob_bytes']<=2**53-1):raise ValueError('approved_network_profile_required')
    for url in [*body['gateways'],body['enrollment']]:
        parts=urlsplit(url)
        if parts.scheme!='https' or not parts.hostname or parts.username or parts.password or parts.path not in ('','/') or parts.query or parts.fragment:raise ValueError('network_https_origin_required')
    return body


def prepared_version(versions,bundle,archive,trust,minimum):
    from server_install import verify
    body=manifest(bundle,trust['root_public_key'],trust['channel'],'linux-server-source',minimum)
    version=versions/('release-'+str(body['sequence'])+'-'+body['sha256'])
    if version.exists():
        if (version/'verified-server-release.json').is_file():verify(version,bundle,archive,trust,minimum);return version
        if version.is_symlink() or version.resolve().parent!=versions.resolve() or not version.is_dir():raise ValueError('invalid_incomplete_source_directory')
        if len(list(versions.glob('incomplete-*')))>=3:raise ValueError('incomplete_source_attempt_limit')
        import secrets
        version.rename(versions/('incomplete-'+secrets.token_hex(8)))
    prepare(versions,bundle,archive,trust,minimum)
    return version


def read_data_file(path,limit):
    import stat
    fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
    try:
        value=os.fstat(fd)
        if not stat.S_ISREG(value.st_mode) or not 0<value.st_size<=limit:raise ValueError('bounded_point_data_file_required')
        with os.fdopen(fd,'rb',closefd=False) as stream:raw=stream.read(limit+1)
        if len(raw)>limit:raise ValueError('point_data_file_changed')
        return raw
    finally:os.close(fd)


def consumer_status(root):
    root=Path(root);code=root/'code';data=root/'data';settings=parse((code/'pending.json').read_bytes());marker=parse((root/'installation.json').read_bytes())
    sys.path.insert(0,str(Path(settings['version'])/'django-server/sfera_server'))
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    from sfera_mesh.identity import node_id
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from server_monitor import check
    private=data/'node.key';ca_file=data/'network-ca.pem'
    if private.is_symlink() or not private.is_file():raise ValueError('point_identity_missing_restore_required')
    key=Ed25519PrivateKey.from_private_bytes(read_data_file(private,32))
    if node_id(key.public_key().public_bytes_raw())!=marker['node']:raise ValueError('point_identity_changed_restore_required')
    ca_raw=read_data_file(ca_file,65536)
    if hashlib.sha256(ca_raw).hexdigest()!=settings['profile']['ca']['sha256']:raise ValueError('point_network_ca_changed')
    leaf=x509.load_pem_x509_certificate(read_data_file(data/'tls.pem',65536));leaf.verify_directly_issued_by(x509.load_pem_x509_certificate(ca_raw))
    if leaf.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw)!=key.public_key().public_bytes_raw():raise ValueError('point_tls_identity_changed')
    import ipaddress
    addresses=leaf.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.IPAddress)
    if len(addresses)!=1 or addresses[0].version!=4:raise ValueError('point_tls_endpoint_invalid')
    endpoint='https://'+str(addresses[0])+':'+str(urlsplit(marker['endpoint']).port)
    return check(endpoint,context=ssl.create_default_context(cadata=ca_raw.decode('ascii')),key=key,network=marker['network'])


def managed_update(root,profile,trust,marker,*,foreground=False):
    import tempfile
    code=root/'code';data=root/'data';operations=data/'operations';config_path=data/'point.json';config=parse(config_path.read_bytes())
    if config['genesis_sha256']!=profile['genesis']['sha256'] or config.get('point_registration',{}).get('ca_sha256')!=profile['ca']['sha256']:raise ValueError('network_identity_migration_not_automatic')
    if (operations/'request.json').exists() or (operations/'processing.json').exists():raise ValueError('point_update_already_in_progress')
    tag=marker.get('python_tag','cp'+str(sys.version_info.major)+str(sys.version_info.minor));transition_meta=profile.get('update_transition',{}).get(tag)
    if transition_meta is None:raise ValueError('compatible_point_update_not_published')
    body=manifest(profile['source']['manifest'],trust['root_public_key'],trust['channel'],'linux-server-source',marker['source_sequence']+1)
    archive=code/body['filename']
    if not archive.exists():asset(profile['source']['archive'],archive,512*1024*1024)
    version=str(prepared_version(code/'versions',profile['source']['manifest'],archive,trust,body['sequence']))
    manifest_path=code/('release-'+str(body['sequence'])+'.json');manifest_path.write_bytes(canonical(profile['source']['manifest']))
    transition=asset(transition_meta,code/('transition-'+transition_meta['sha256']+'.json'),32768)
    journal=parse((operations/'update.json').read_bytes(),1024*1024);old=journal['active']
    candidate={**old['deployment'],'version':version,'manifest':str(manifest_path),'archive':str(archive),'transition':str(transition)}
    gid=code.stat().st_gid
    for path in (archive,manifest_path,transition,Path(version)):
        if path.is_dir():
            for parent,dirs,files in os.walk(path):
                os.chown(parent,0,gid);os.chmod(parent,0o750)
                for name in files:os.chown(Path(parent)/name,0,gid);os.chmod(Path(parent)/name,0o640)
        else:os.chown(path,0,gid);os.chmod(path,0o640)
    # Reuse the original supervisor/environment. It admits only a publisher-
    # signed exact release pair and approved schema, then performs the handoff.
    raw=canonical(candidate);fd,name=tempfile.mkstemp(prefix='request-',dir=data)
    try:
        with os.fdopen(fd,'wb') as output:output.write(raw);output.flush();os.fsync(output.fileno())
        owner=operations.stat();os.chown(name,owner.st_uid,owner.st_gid);os.chmod(name,0o600);os.link(name,operations/'request.json')
    finally:os.unlink(name)
    digest=hashlib.sha256(raw).hexdigest();deadline=time.monotonic()+150
    while time.monotonic()<deadline:
        result_path=operations/'result.json'
        if result_path.is_file():
            result=parse(result_path.read_bytes(),1024*1024)
            if result.get('request_sha256')==digest:
                if not result.get('activated'):raise ValueError('point_update_refused_previous_data_preserved')
                marker.update(source_sequence=body['sequence']);(root/'installation.json').write_bytes(canonical(marker));(data/'deployment.json').write_bytes(canonical(candidate))
                return {'installed':True,'updated':True,'sequence':body['sequence'],'identity_preserved':True,'data_restored':False}
        time.sleep(.5)
    raise ValueError('point_update_pending_do_not_reset_state')


def install(root,packet,trust,*,foreground=False):
    if sys.platform!='linux' or platform.machine() not in ('x86_64','amd64'):raise ValueError('linux_x86_64_installer_required')
    profile=network_profile(packet,trust);root=Path(root)
    tag='cp'+str(sys.version_info.major)+str(sys.version_info.minor)
    wheel_plan=profile['wheels'].get(tag)
    if wheel_plan is None:raise ValueError('network_release_has_no_wheels_for_'+tag)
    if not root.is_absolute() or any(p.is_symlink() for p in (root,*root.parents)):raise ValueError('private_absolute_install_root_required')
    resuming=False
    if root.exists():
        if root.stat().st_uid!=os.geteuid():raise ValueError('installation_root_owner_mismatch')
        marker=root/'installation.json'
        if marker.is_file():
            installed=parse(marker.read_bytes())
            if installed.get('root_key_id')!=trust['root_key_id'] or installed.get('network')!=profile['network']:raise ValueError('existing_point_network_mismatch')
            candidate=manifest(profile['source']['manifest'],trust['root_public_key'],trust['channel'],'linux-server-source',trust['minimum_sequence'])
            if candidate['sequence']>installed['source_sequence']:return managed_update(root,profile,trust,installed,foreground=foreground)
            if candidate['sequence']<installed['source_sequence']:raise ValueError('point_update_rollback_rejected')
            settings=parse((root/'code/pending.json').read_bytes());python=Path(settings['environment'])/'venv/bin/python';entry=Path(settings['version'])/'scripts/server_point_install.py'
            if not python.resolve().is_relative_to(root/'code') or python.stat().st_uid!=os.geteuid() or python.stat().st_mode&0o022:raise ValueError('managed_install_environment_required')
            checked=subprocess.run([str(python),'-B',str(entry),'status','--root',str(root)],capture_output=True)
            if checked.returncode or not parse(checked.stdout).get('ready'):raise ValueError('point_not_ready_existing_identity_preserved')
            return {'installed':True,'already_installed':True,'node':installed['node'],'identity_preserved':True}
        pending=root/'code/pending.json';initial=root/'INSTALLING.json'
        if initial.is_file() and pending.is_file():
            record=parse(initial.read_bytes());settings=parse(pending.read_bytes())
            if record!={'root_key_id':trust['root_key_id'],'profile_sha256':hashlib.sha256(canonical(packet)).hexdigest()}:raise ValueError('incomplete_install_profile_changed')
            from server_install import verify
            manifest_packet=parse((root/'code/release.json').read_bytes())
            source_body=manifest(manifest_packet,trust['root_public_key'],trust['channel'],'linux-server-source',trust['minimum_sequence'])
            expected_version=root/'code/versions'/('release-'+str(source_body['sequence'])+'-'+source_body['sha256'])
            if Path(settings['version'])!=expected_version:raise ValueError('managed_install_source_required')
            verify(settings['version'],manifest_packet,settings['archive'],trust,trust['minimum_sequence'])
            python=Path(settings['environment'])/'venv/bin/python'
            if not python.resolve().is_relative_to(root/'code') or python.stat().st_uid!=os.geteuid() or python.stat().st_mode&0o022:raise ValueError('managed_install_environment_required')
            result=subprocess.run([str(python),'-B',str(Path(settings['version'])/'scripts/server_point_install.py'),'activate','--root',str(root),*(['--foreground'] if foreground else [])])
            if result.returncode:raise ValueError('point_activation_waiting_for_network')
            return {'installed':True,'identity_preserved':True}
        if initial.is_file() and parse(initial.read_bytes())=={'root_key_id':trust['root_key_id'],'profile_sha256':hashlib.sha256(canonical(packet)).hexdigest()}:resuming=True
        else:raise ValueError('existing_directory_not_a_managed_point')
    if not resuming:root.mkdir(mode=0o700)
    code=root/'code';data=root/'data';code.mkdir(mode=0o700,exist_ok=True);data.mkdir(mode=0o700,exist_ok=True)
    (root/'INSTALLING.json').write_bytes(canonical({'root_key_id':trust['root_key_id'],'profile_sha256':hashlib.sha256(canonical(packet)).hexdigest()}))
    (code/'trust.json').write_bytes(canonical(trust));(code/'network.json').write_bytes(canonical(packet))
    source=profile['source'];bundle=source['manifest'];body=manifest(bundle,trust['root_public_key'],trust['channel'],'linux-server-source',trust['minimum_sequence'])
    archive=asset(source['archive'],code/body['filename'],512*1024*1024)
    versions=code/'versions';versions.mkdir(exist_ok=True);version=prepared_version(versions,bundle,archive,trust,body['sequence'])
    (code/'release.json').write_bytes(canonical(bundle));binary=asset(profile['verifier'],code/'mesh-verifier',128*1024*1024);binary.chmod(0o750)
    genesis=asset(profile['genesis'],data/'genesis.json',4*1024*1024);ca=asset(profile['ca'],data/'network-ca.pem',65536)
    wheels=code/'wheels';wheels.mkdir(exist_ok=True);lock=asset(wheel_plan['lock'],code/'wheels.json',65536)
    inventory=parse(lock.read_bytes(),65536)['files']
    if set(inventory)!=set(wheel_plan['files']):raise ValueError('install_wheel_inventory_mismatch')
    for name,meta in wheel_plan['files'].items():
        if Path(name).name!=name or not name.endswith('.whl'):raise ValueError('install_wheel_filename')
        asset(meta,wheels/name,64*1024*1024)
    environment=code/'environment'
    for attempt in range(4):
        candidate=code/('environment' if attempt==0 else 'environment-retry-'+str(attempt))
        if not candidate.exists():environment=candidate;receipt=build(lock,wheel_plan['lock']['sha256'],wheels,environment);break
        if (candidate/'environment-ready.json').is_file():
            receipt=parse((candidate/'environment-ready.json').read_bytes())
            if receipt.get('wheel_lock_sha256')!=wheel_plan['lock']['sha256']:raise ValueError('install_environment_pin_changed')
            environment=candidate;break
    else:raise ValueError('incomplete_environment_attempt_limit')
    settings={'profile':profile,'root_key_id':trust['root_key_id'],'version':str(version),'archive':str(archive),'environment':str(environment),'lock_sha256':receipt['wheel_lock_sha256']}
    (code/'pending.json').write_bytes(canonical(settings))
    # All node operations use the isolated verified environment, never the OS
    # bootstrap crypto package. This invocation contains paths, never secrets.
    result=subprocess.run([receipt['python'],'-B',str(version/'scripts/server_point_install.py'),'activate','--root',str(root),*(['--foreground'] if foreground else [])])
    if result.returncode:raise ValueError('point_activation_failed_existing_files_preserved')
    return {'installed':True,'identity_preserved':True}


def activate(root,*,foreground=False):
    root=Path(root);data=root/'data';code=root/'code';pending=code/'pending.json'
    if pending.is_symlink() or pending.stat().st_uid!=os.geteuid() or pending.stat().st_mode&0o022:raise ValueError('protected_install_activation_required')
    settings=parse(pending.read_bytes());profile=settings['profile'];version=Path(settings['version'])
    sys.path.insert(0,str(version/'django-server/sfera_server'))
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    from sfera_mesh.identity import create_identity,node_id
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from sfera_mesh.consensus_directory import ConsensusDirectory
    from sfera_mesh.consensus_gateway import GatewaySource
    from sfera_mesh.point_join import credential,publish,write_private
    node_file=data/'node.key'
    if not node_file.exists() and ((data/'bootstrap.sqlite').exists() or (code/'node-public.json').exists()):raise ValueError('point_identity_missing_restore_required')
    key=Ed25519PrivateKey.from_private_bytes(read_data_file(node_file,32)) if node_file.exists() else create_identity(node_file);identity=node_id(key.public_key().public_bytes_raw())
    public_record=code/'node-public.json';expected={'node':identity,'public_key':key.public_key().public_bytes_raw().hex()}
    if public_record.exists():
        if parse(public_record.read_bytes())!=expected:raise ValueError('point_identity_changed_restore_required')
    else:public_record.write_bytes(canonical(expected))
    for filename,meta,limit in (('genesis.json',profile['genesis'],4*1024*1024),('network-ca.pem',profile['ca'],65536)):
        if hashlib.sha256(read_data_file(data/filename,limit)).hexdigest()!=meta['sha256']:raise ValueError('pinned_point_network_file_changed')
    os.environ['SSL_CERT_FILE']=str(data/'network-ca.pem');context=ssl.create_default_context(cafile=str(data/'network-ca.pem'))
    bootstrap=ConsensusDirectory(str(data/'bootstrap.sqlite'),str(code/'mesh-verifier'),str(data/'genesis.json'))
    try:
        if bootstrap.network!=profile['network']:raise ValueError('bootstrap_genesis_network_mismatch')
        sources=[GatewaySource(url) for url in profile['gateways']];bootstrap.refresh(sources[0])
        joined=credential(key,bootstrap,profile['enrollment'],profile['port'],x509.load_pem_x509_certificate((data/'network-ca.pem').read_bytes()),context=context)
        publish(key,bootstrap,sources[0],joined)
    finally:bootstrap.close()
    write_private(data/'tls.key',key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
    write_private(data/'tls.pem',joined['certificate'].encode('ascii'))
    state=data/'state';state.mkdir(mode=0o700,exist_ok=True);operations=data/'operations';operations.mkdir(mode=0o700,exist_ok=True)
    config={'domain':'sphere-mesh-point-runtime-v1','network':profile['network'],'listen_host':'0.0.0.0','listen_port':profile['port'],'public_endpoint':joined['endpoint'],
        'state_directory':str(state),'node_key':str(node_file),'genesis':str(data/'genesis.json'),'genesis_sha256':profile['genesis']['sha256'],
        'verifier_binary':str(code/'mesh-verifier'),'verifier_sha256':profile['verifier']['sha256'],'tls_certificate':str(data/'tls.pem'),'tls_private_key':str(data/'tls.key'),
        'peers':{identity:{'public_key':key.public_key().public_bytes_raw().hex(),'endpoint':joined['endpoint']}},'consensus_rpc':[],
        'consensus_gateways':profile['gateways'],'max_blob_bytes':profile['max_blob_bytes'],'max_connections':32,'replication_worker':True,'follow_network_peers':True,
        'point_registration':{'enrollment':profile['enrollment'],'ca_certificate':str(data/'network-ca.pem'),'ca_sha256':profile['ca']['sha256']}}
    (data/'point.json').write_bytes(canonical(config))
    deployment={name:settings[name] for name in ('version','archive','environment','lock_sha256')};deployment['manifest']=str(code/'release.json');(data/'deployment.json').write_bytes(canonical(deployment))
    from release_v1 import manifest
    trust=parse((code/'trust.json').read_bytes());bundle=parse((code/'release.json').read_bytes());sequence=manifest(bundle,trust['root_public_key'],trust['channel'],'linux-server-source')['sequence']
    python=str(Path(settings['environment'])/'venv/bin/python');argv=[python,'-B',str(version/'scripts/server_update.py'),'--deployment',str(data/'deployment.json'),'--trust',str(code/'trust.json'),'--config',str(data/'point.json'),'--operations-directory',str(operations),'--minimum-sequence',str(sequence)]
    marker={'domain':'sphere-point-installation-v1','network':profile['network'],'node':identity,'root_key_id':settings['root_key_id'],'source_sequence':sequence,'role':'point','endpoint':joined['endpoint'],'python_tag':'cp'+str(sys.version_info.major)+str(sys.version_info.minor)}
    if foreground:
        (root/'installation.json').write_bytes(canonical(marker));return subprocess.call(argv,env=os.environ.copy())
    if os.geteuid()!=0 or not Path('/run/systemd/system').is_dir():raise ValueError('systemd_linux_host_required')
    import grp,pwd
    try:user=pwd.getpwnam('sphere-point')
    except KeyError:
        subprocess.run(['useradd','--system','--user-group','--no-create-home','--shell','/usr/sbin/nologin','sphere-point'],check=True);user=pwd.getpwnam('sphere-point')
    if user.pw_uid==0 or user.pw_shell not in ('/usr/sbin/nologin','/sbin/nologin','/bin/false') or grp.getgrnam('sphere-point').gr_gid!=user.pw_gid:raise ValueError('dedicated_noninteractive_point_account_required')
    for folder in (root,code):os.chown(folder,0,user.pw_gid);os.chmod(folder,0o750)
    for parent,dirs,files in os.walk(code):
        for name in dirs:os.chown(Path(parent)/name,0,user.pw_gid);os.chmod(Path(parent)/name,0o750)
        for name in files:
            path=Path(parent)/name;executable=bool(path.stat().st_mode&0o111);os.chown(path,0,user.pw_gid);os.chmod(path,0o750 if executable else 0o640)
    for parent,dirs,files in os.walk(data):
        os.chown(parent,user.pw_uid,user.pw_gid);os.chmod(parent,0o700)
        for name in files:os.chown(Path(parent)/name,user.pw_uid,user.pw_gid);os.chmod(Path(parent)/name,0o600)
    from server_service import unit
    text=unit(argv,data,'sphere-point');target=Path('/etc/systemd/system/sphere-point.service')
    if target.exists():
        if target.is_symlink() or target.stat().st_uid!=0 or target.read_text(encoding='ascii')!=text:raise ValueError('existing_service_preserved')
    else:target.write_text(text,encoding='ascii')
    subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','enable','--now','sphere-point.service'],check=True)
    from server_monitor import check
    deadline=time.monotonic()+90
    while time.monotonic()<deadline:
        try:
            if check(joined['endpoint'],context=context,key=key,network=profile['network'])['ready']:
                from server_maintenance_setup import setup
                setup(root,settings,config,python)
                (root/'installation.json').write_bytes(canonical(marker));print('Поинт подключён к сети. Узел: '+identity);return 0
        except (OSError,ValueError):pass
        time.sleep(1)
    raise ValueError('point_installed_waiting_for_network_readiness')


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',nargs='?',choices=('install','activate','status'),default='install');parser.add_argument('--root',default='/opt/sphere-point');parser.add_argument('--foreground',action='store_true');parser.add_argument('--profile',default=os.environ.get('SPHERE_POINT_PROFILE_URL','https://github.com/DarovskoyID/sphera/releases/latest/download/network-profile.json'));parser.add_argument('--trust')
    parser.add_argument('--check',action='store_true',help='Show the automatic point plan without network or filesystem changes')
    args=parser.parse_args()
    if args.check:
        print(canonical({'commands':2,'role':'point','user_validator_configuration_required':False,'network_accessed':False,'state_changed':False}).decode());return
    if args.action=='activate':raise SystemExit(activate(args.root,foreground=args.foreground))
    if args.action=='status':print(canonical(consumer_status(args.root)).decode());return
    if args.trust:trust=parse(Path(args.trust).read_bytes())
    elif zipfile.is_zipfile(sys.argv[0]):
        with zipfile.ZipFile(sys.argv[0]) as archive:trust=parse(archive.read('trust.public.json'))
    else:trust=parse((Path(__file__).resolve().parents[1]/'release/trust.public.json').read_bytes())
    result=install(args.root,parse(download(args.profile,32768)),trust,foreground=args.foreground);print(canonical(result).decode())


def entry():
    try:main()
    except (ValueError,OSError,KeyError,TypeError) as error:
        from urllib.error import HTTPError
        if isinstance(error,HTTPError) and error.code==404:message='Пакет подключения общей сети ещё не опубликован. Установка остановлена.'
        elif str(error)=='compatible_point_update_not_published':message='Для новой версии ещё не опубликовано совместимое обновление. Текущий поинт сохранён.'
        elif str(error)=='point_update_pending_do_not_reset_state':message='Обновление ещё выполняется. Ключи и состояние сохранены; повторите проверку позже.'
        else:message='Не удалось завершить подключение поинта. Существующие ключи и данные сохранены. Код: '+(str(error) if isinstance(error,ValueError) else type(error).__name__)
        print(message,file=sys.stderr);raise SystemExit(2)


if __name__=='__main__':entry()
