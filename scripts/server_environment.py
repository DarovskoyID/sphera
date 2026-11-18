"""Build an isolated headless runtime from independently approved offline wheels.

No package index, shell, source distributions, service changes or application DBs.
The lock SHA-256 is supplied by the operator through an independent channel.
"""
import argparse
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
from release_v1 import canonical,parse
from server_install import directory


def wheel_inventory(lock,expected,wheelhouse):
    lock=Path(lock);wheelhouse=directory(wheelhouse)
    raw=lock.read_bytes()
    if not re.fullmatch('[0-9a-f]{64}',expected) or hashlib.sha256(raw).hexdigest()!=expected:raise ValueError('wheel_lock_pin_mismatch')
    value=parse(raw,65536)
    if not isinstance(value,dict) or set(value)!={'domain','files'} or value['domain']!='sphere-headless-wheels-v1':raise ValueError('wheel_lock_schema')
    files=value['files']
    if not isinstance(files,dict) or len(files)!=3:raise ValueError('headless_wheel_set_required')
    packages=set();paths=[]
    for name,entry in sorted(files.items()):
        if not re.fullmatch(r'[A-Za-z0-9_.+-]+\.whl',name):raise ValueError('wheel_filename')
        package=name.split('-')[0].lower()
        if package not in {'cryptography','cffi','pycparser'} or package in packages:raise ValueError('headless_wheel_set_required')
        packages.add(package)
        if package=='cryptography' and not name.startswith('cryptography-46.0.6-'):raise ValueError('approved_cryptography_version_required')
        if not isinstance(entry,dict) or set(entry)!={'size','sha256'} or type(entry['size']) is not int or not 1<=entry['size']<=64*1024*1024 or not re.fullmatch('[0-9a-f]{64}',entry['sha256']):raise ValueError('wheel_record')
        path=wheelhouse/name
        if path.is_symlink() or not path.is_file() or path.stat().st_size!=entry['size']:raise ValueError('wheel_size_or_link')
        with path.open('rb') as source:
            if hashlib.file_digest(source,'sha256').hexdigest()!=entry['sha256']:raise ValueError('wheel_hash_mismatch')
        paths.append((path,entry))
    return paths


def build(lock,pin,wheelhouse,destination):
    if sys.platform!='linux':raise ValueError('linux_runtime_environment_required')
    paths=wheel_inventory(lock,pin,wheelhouse);destination=Path(destination)
    directory(destination.parent)
    if not destination.is_absolute() or destination.exists() or destination.is_symlink():raise ValueError('new_environment_required')
    destination.mkdir(mode=0o700)
    # Snapshot authenticated wheels before pip so the mutable wheelhouse is never
    # an execution input after checking; pip rechecks the explicit file hashes.
    wheels=destination/'approved-wheels';wheels.mkdir(mode=0o700);requirements=[]
    for path,entry in paths:
        target=wheels/path.name
        with path.open('rb') as reader,target.open('xb') as writer:
            while chunk:=reader.read(1024*1024):writer.write(chunk)
        if hashlib.sha256(target.read_bytes()).hexdigest()!=entry['sha256']:raise ValueError('wheel_changed_during_copy')
        requirements.append(target.as_uri()+' --hash=sha256:'+entry['sha256'])
    requirements_file=destination/'requirements.lock';requirements_file.write_text('\n'.join(requirements)+'\n',encoding='ascii')
    env={key:value for key,value in os.environ.items() if not key.startswith(('PYTHON','PIP_','VIRTUAL_ENV'))}
    env.update({'PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1','PIP_CONFIG_FILE':os.devnull})
    subprocess.run([sys.executable,'-I','-m','venv','--copies',str(destination/'venv')],check=True,env=env,timeout=120)
    python=destination/'venv/bin/python'
    subprocess.run([str(python),'-I','-m','pip','--isolated','install','--no-index','--no-deps','--require-hashes','--only-binary=:all:','--disable-pip-version-check','-r',str(requirements_file)],check=True,env=env,timeout=180)
    subprocess.run([str(python),'-I','-c',"import cryptography,cffi,pycparser; assert cryptography.__version__=='46.0.6'"],check=True,env=env,timeout=30)
    receipt={'domain':'sphere-headless-environment-v1','wheel_lock_sha256':pin,'python':str(python),'service_started':False}
    with (destination/'environment-ready.json').open('xb') as output:output.write(canonical(receipt));output.flush();os.fsync(output.fileno())
    return receipt


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('lock','lock-sha256','wheelhouse','destination'):parser.add_argument('--'+name,required=True)
    args=parser.parse_args();print(canonical(build(args.lock,args.lock_sha256,args.wheelhouse,args.destination)).decode())


if __name__=='__main__':main()
