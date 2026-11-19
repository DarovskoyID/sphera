"""Verify the publisher's ordinary-point Python/runtime plan before execution."""
import argparse
import hashlib
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
from release_v1 import canonical,parse,document,certificate,trust_document
from server_point_install import download,asset
from server_wan_prepare import safe_python_archive

DEFAULT='https://github.com/DarovskoyID/sphera/releases/download/wan-trial-20261118/point-bootstrap.json'


def approved(packet,trust):
    trust_document(trust);body=document(packet,trust['root_public_key'],trust['channel'],'release');cert=certificate(packet['certificate'],trust['root_public_key'],trust['channel'],'release')
    fields={'domain','product','channel','issued_at','expires_at','python','wheels','network_profile'}
    if set(body)!=fields or body['domain']!='sphere-point-bootstrap-v1' or body['product']!='sphere' or body['channel']!=trust['channel'] or not body['issued_at']<=int(time.time())<body['expires_at']<=cert['expires_at']:raise ValueError('approved_point_bootstrap_required')
    from urllib.parse import urlsplit
    metas=[body['python'],body['network_profile'],*body['wheels'].values()]
    for meta in metas:
        if set(meta)!={'url','size','sha256'} or urlsplit(meta['url']).hostname!='github.com' or urlsplit(meta['url']).scheme!='https':raise ValueError('github_point_bootstrap_assets_required')
    if len(body['wheels'])!=3 or any(Path(n).name!=n or not n.endswith('.whl') for n in body['wheels']):raise ValueError('three_bootstrap_wheels_required')
    return body


def bootstrap(body,trust,root,entry):
    root=Path(root)
    if platform.machine()!='x86_64' or not root.is_absolute() or any(p.is_symlink() for p in (root,*root.parents)):raise ValueError('x86_64_private_managed_bootstrap_required')
    pin=hashlib.sha256(canonical(body)).hexdigest();marker=root/'bootstrap.json'
    if root.exists():
        if root.stat().st_uid!=0 or not marker.is_file() or marker.is_symlink() or parse(marker.read_bytes())!={'profile_sha256':pin}:raise ValueError('existing_python_bootstrap_preserved')
    else:
        root.mkdir(mode=0o755);marker.write_bytes(canonical({'profile_sha256':pin}));marker.chmod(0o600)
    archive=asset(body['python'],root/'python-runtime.tar.gz',128*1024*1024)
    python=root/'python/bin/python3'
    if not python.exists():
        if (root/'python').exists():raise ValueError('incomplete_python_bootstrap_preserved')
        safe_python_archive(archive,root)
    # This directory contains public runtime code only. A dedicated service user
    # must be able to read the base stdlib of the isolated copied venv later.
    root.chmod(0o755)
    for parent,dirs,files in os.walk(root/'python'):
        os.chmod(parent,0o755)
        for name in files:
            path=Path(parent)/name
            if not path.is_symlink():os.chmod(path,0o755 if path.stat().st_mode&0o111 else 0o644)
    wheels=root/'wheels';wheels.mkdir(mode=0o700,exist_ok=True);requirements=[]
    for name,meta in body['wheels'].items():
        path=asset(meta,wheels/name,64*1024*1024);requirements.append(path.as_uri()+' --hash=sha256:'+meta['sha256'])
    lock=root/'requirements.lock';lock.write_text('\n'.join(requirements)+'\n',encoding='ascii')
    subprocess.run([str(python),'-I','-m','pip','--isolated','install','--no-index','--no-deps','--require-hashes','--only-binary=:all:','--disable-pip-version-check','-r',str(lock)],check=True,timeout=240)
    profile=asset(body['network_profile'],root/'network-profile.json',32768)
    # Verify again using the same release root; the consumer installer performs
    # its own profile verification before generating its local point identity.
    from server_point_install import network_profile
    network_profile(parse(profile.read_bytes()),trust)
    print('SPHERE_BOOTSTRAP_VERIFIED python=3.12 profile_sha256='+body['network_profile']['sha256'],flush=True)
    os.execv(str(python),[str(python),'-B',str(entry),'install','--profile',body['network_profile']['url']])


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--profile',default=DEFAULT);p.add_argument('--runtime-root',default='/opt/sphere-bootstrap');a=p.parse_args()
    if sys.platform!='linux' or os.geteuid()!=0:raise ValueError('root_linux_bootstrap_required')
    checkout=Path(__file__).resolve().parents[1];trust=parse((checkout/'release/trust.public.json').read_bytes());body=approved(parse(download(a.profile,32768)),trust)
    bootstrap(body,trust,Path(a.runtime_root),checkout/'scripts/server_point_install.py')


if __name__=='__main__':main()
