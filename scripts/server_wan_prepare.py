"""GitHub-only trial preparation. Does not claim a running or admitted point."""
import argparse
import base64
import hashlib
import ipaddress
import json
import os
from pathlib import Path,PurePosixPath
import posixpath
import shutil
import platform
import subprocess
import sys
import tarfile
import time


def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()


def write_new(path,value):
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as stream:stream.write(value);stream.flush();os.fsync(stream.fileno())


def safe_python_archive(archive,destination):
    total=0
    with tarfile.open(archive,'r:gz') as source:
        members=source.getmembers()
        if len(members)>20000:raise ValueError('python_runtime_member_limit')
        for member in members:
            parts=PurePosixPath(member.name).parts;total+=member.size
            if not parts or parts[0]!='python' or '..' in parts or member.name.startswith('/') or not (member.isfile() or member.isdir() or member.issym() or member.islnk()) or total>512*1024*1024:raise ValueError('python_runtime_archive_path')
            if member.issym() or member.islnk():
                target=posixpath.normpath(posixpath.join(posixpath.dirname(member.name),member.linkname)) if member.issym() else posixpath.normpath(member.linkname)
                if member.linkname.startswith('/') or not target.startswith('python/'):raise ValueError('python_runtime_external_link')
    subprocess.run(['tar','--extract','--gzip','--file',str(archive),'--directory',str(destination),'--no-same-owner','--no-same-permissions'],check=True)


def finish(root):
    settings=json.loads((root/'code/preparing.json').read_bytes());code=root/'code';data=root/'data'
    subprocess.run([sys.executable,'-I','-m','pip','--isolated','install','--no-index','--no-deps','--require-hashes','--only-binary=:all:','--disable-pip-version-check','-r',str(code/'requirements.lock')],check=True,timeout=240)
    import cryptography
    if cryptography.__version__!='46.0.6':raise ValueError('prepared_crypto_version')
    version=Path(settings['version']);sys.path.insert(0,str(version/'scripts'));sys.path.insert(0,str(version/'django-server/sfera_server'))
    from sfera_mesh.identity import create_identity,load_identity,node_id
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    subprocess.run([str(code/'mesh-verifier'),'--help'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True,timeout=15)
    subprocess.run([sys.executable,'-B','-c','import sys;sys.path[:0]='+repr([str(version/'scripts'),str(version/'django-server/sfera_server')])+';import mesh_point;print("SPHERE_RUNTIME_IMPORT_OK")'],check=True,timeout=30)
    point=data/'node.key';key=load_identity(point) if point.exists() else create_identity(point)
    home=data/'consensus'
    if not home.exists():
        home.mkdir(mode=0o700);(home/'config').mkdir(mode=0o700);(home/'data').mkdir(mode=0o700)
        for name in ('priv_validator_key','node_key'):
            private=Ed25519PrivateKey.generate();public=private.public_key().public_bytes_raw()
            secret={'type':'tendermint/PrivKeyEd25519','value':base64.b64encode(private.private_bytes_raw()+public).decode()}
            value={'priv_key':secret}
            if name=='priv_validator_key':value.update(address=hashlib.sha256(public).digest()[:20].hex().upper(),pub_key={'type':'tendermint/PubKeyEd25519','value':base64.b64encode(public).decode()})
            write_new(home/'config'/(name+'.json'),canonical(value))
        write_new(home/'data/priv_validator_state.json',canonical({'height':'0','round':0,'step':0}))
    validator=json.loads((home/'config/priv_validator_key.json').read_bytes());p2p=json.loads((home/'config/node_key.json').read_bytes())
    state=json.loads((home/'data/priv_validator_state.json').read_bytes())
    if state!={'height':'0','round':0,'step':0}:raise ValueError('existing_signing_state_never_reset')
    environment=code/'environment';receipt={'domain':'sphere-headless-environment-v1','wheel_lock_sha256':settings['wheel_lock_sha256'],'python':sys.executable,'service_started':False}
    write_new(environment/'environment-ready.json',canonical(receipt))
    result={'domain':'sphere-wan-preparation-v1','host':settings['host'],'network':settings['profile']['network'],'node_id':node_id(key.public_key().public_bytes_raw()),'public_key':key.public_key().public_bytes_raw().hex(),
        'validator_public_key':validator['pub_key'],'validator_address':validator['address'],'p2p_id':hashlib.sha256(base64.b64decode(p2p['priv_key']['value'])[32:]).digest()[:20].hex(),
        'source_sequence':settings['sequence'],'source_sha256':settings['source_sha256'],'python':sys.version.split()[0],'cryptography':cryptography.__version__,
        'prepared':True,'network_started':False,'point_admitted':False,'phase':'awaiting_signed_network_configuration','independent_operator':False}
    write_new(root/'preparation.json',canonical(result));print('SPHERE_PREPARATION='+canonical(result).decode(),flush=True)


def prepare(root,host,profile_path,trust_path):
    from release_v1 import parse,document,certificate,trust_document,manifest
    from server_point_install import asset
    from server_install import prepare as prepare_source
    trust=trust_document(parse(Path(trust_path).read_bytes()));packet=parse(Path(profile_path).read_bytes());profile=document(packet,trust['root_public_key'],trust['channel'],'release');cert=certificate(packet['certificate'],trust['root_public_key'],trust['channel'],'release')
    fields={'domain','product','channel','network','issued_at','expires_at','hosts','source','python','verifier','wheels'}
    if set(profile)!=fields or profile['domain']!='sphere-wan-preparation-profile-v1' or profile['product']!='sphere' or profile['channel']!=trust['channel']:raise ValueError('wan_preparation_profile')
    now=int(time.time())
    if not profile['issued_at']<=now<profile['expires_at']<=cert['expires_at'] or host not in profile['hosts'] or not ipaddress.ip_address(host).is_global:raise ValueError('wan_preparation_scope')
    if not root.is_absolute() or any(p.is_symlink() for p in (root,*root.parents)) or root.exists():raise ValueError('existing_installation_preserved')
    if platform.machine()!='x86_64' or shutil.disk_usage(root.parent).free<1024*1024*1024:raise ValueError('x86_64_and_1gib_free_required')
    root.mkdir(mode=0o700);code=root/'code';data=root/'data';code.mkdir(mode=0o700);data.mkdir(mode=0o700);versions=code/'versions';versions.mkdir(mode=0o700)
    body=manifest(profile['source']['manifest'],trust['root_public_key'],trust['channel'],'linux-server-source')
    archive=asset(profile['source']['archive'],code/body['filename'],512*1024*1024)
    staged=prepare_source(versions,profile['source']['manifest'],archive,trust,body['sequence']);version=Path(staged['version_directory'])
    print('SPHERE_SOURCE_VERIFIED sequence='+str(body['sequence'])+' sha256='+body['sha256'],flush=True)
    write_new(code/'release.json',canonical(profile['source']['manifest']));write_new(code/'trust.json',canonical(trust))
    binary=asset(profile['verifier'],code/'mesh-verifier',128*1024*1024);binary.chmod(0o700)
    wheels=code/'wheels';wheels.mkdir(mode=0o700);requirements=[];records={}
    for name,meta in profile['wheels'].items():
        if Path(name).name!=name or not name.endswith('.whl'):raise ValueError('wheel_name')
        path=asset(meta,wheels/name,64*1024*1024);records[name]={'size':meta['size'],'sha256':meta['sha256']};requirements.append(path.as_uri()+' --hash=sha256:'+meta['sha256'])
    if len(records)!=3:raise ValueError('three_approved_wheels_required')
    lock=canonical({'domain':'sphere-headless-wheels-v1','files':records});write_new(code/'wheels.json',lock);write_new(code/'requirements.lock',('\n'.join(requirements)+'\n').encode())
    runtime=asset(profile['python'],code/'python-runtime.tar.gz',128*1024*1024);unpack=code/'python-unpack';unpack.mkdir(mode=0o700);safe_python_archive(runtime,unpack)
    print('SPHERE_PYTHON_VERIFIED sha256='+profile['python']['sha256'],flush=True)
    environment=code/'environment';environment.mkdir(mode=0o700);os.rename(unpack/'python',environment/'venv');python=environment/'venv/bin/python'
    if python.is_symlink():
        target=python.resolve()
        if not target.is_relative_to(environment):raise ValueError('python_binary_link')
        python.unlink();shutil.copy2(target,python)
    settings={'profile':profile,'host':host,'sequence':body['sequence'],'source_sha256':body['sha256'],'version':str(version),'wheel_lock_sha256':hashlib.sha256(lock).hexdigest()}
    write_new(code/'preparing.json',canonical(settings))
    subprocess.run([str(python),'-B',str(Path(__file__).resolve()),'--finish',str(root)],check=True,timeout=300)


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',default='/opt/sphere-point');p.add_argument('--host');p.add_argument('--profile');p.add_argument('--trust');p.add_argument('--finish');a=p.parse_args();os.umask(0o077)
    if sys.platform!='linux' or os.geteuid()!=0:raise ValueError('root_linux_preparation_required')
    if a.finish:finish(Path(a.finish))
    else:
        if not all((a.host,a.profile,a.trust)):p.error('--host --profile --trust required')
        prepare(Path(a.root),a.host,a.profile,a.trust)


if __name__=='__main__':main()
