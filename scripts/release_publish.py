"""Prepare root/delegations and sign a natively verified production release.

No command publishes externally, changes OS trust stores, or installs software.
"""
import argparse
import hashlib
from pathlib import Path
import re
import time
from cryptography.hazmat.primitives.asymmetric import rsa
from release_v1 import canonical, parse, public_text, key_id, sign, certificate, manifest, PLATFORMS
from release_keys import save_key, load_key
from release_platform import verify_platform, artifact_digest
from mesh_release_download import release_base


def require_active_platform(platform):
    policy=parse((Path(__file__).resolve().parents[1]/'release'/'production-policy.json').read_bytes())
    if policy.get('domain')!='sphere-release-scope-v1' or platform not in policy.get('active_platforms',[]):
        raise ValueError('platform_release_deferred_by_owner_server_work_first')


def write_new(path, value):
    path = Path(path)
    if path.is_symlink() or not path.parent.is_dir(): raise ValueError('new_output_path_required')
    with path.open('xb') as output: output.write(canonical(value))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='operation', required=True)
    root = sub.add_parser('init-root')
    root.add_argument('--private',required=True); root.add_argument('--trust',required=True)
    root.add_argument('--base-url'); root.add_argument('--channel',default='stable')
    delegate = sub.add_parser('delegate')
    for name in ('root-private','private','certificate','trust'): delegate.add_argument('--'+name,required=True)
    delegate.add_argument('--role',choices=['release','head'],required=True)
    delegate.add_argument('--days',type=int,default=7)
    release = sub.add_parser('sign')
    for name in ('private','certificate','trust','artifact','publisher','version','output'): release.add_argument('--'+name,required=True)
    release.add_argument('--platform',choices=PLATFORMS,required=True); release.add_argument('--sequence',type=int,required=True)
    release.add_argument('--java'); release.add_argument('--apksigner-jar'); release.add_argument('--aapt'); release.add_argument('--days',type=int,default=7)
    args = parser.parse_args()
    if args.operation=='sign':require_active_platform(args.platform)
    if args.operation == 'init-root':
        if not re.fullmatch('[a-z][a-z0-9-]{0,31}',args.channel): raise ValueError('invalid_release_channel')
        base = release_base(args.base_url) if args.base_url else None
        if Path(args.trust).exists(): raise ValueError('trust_already_exists')
        key = rsa.generate_private_key(public_exponent=65537,key_size=3072)
        save_key(args.private,key)
        write_new(args.trust,{'domain':'sphere-release-trust-v1','product':'sphere','channel':args.channel,
            'root_public_key':public_text(key.public_key()),'root_key_id':key_id(public_text(key.public_key())),
            'base_url':base,'minimum_sequence':1})
        print('Protected root created. Back up custody separately; embed ONLY the public trust file in clients. A missing HTTPS base keeps updates disabled.')
    else:
        trust = parse(Path(args.trust).read_bytes())
        if args.operation == 'delegate':
            if not 1 <= args.days <= 31: raise ValueError('delegation_duration')
            root = load_key(args.root_private)
            if public_text(root.public_key()) != trust['root_public_key']: raise ValueError('root_key_mismatch')
            if Path(args.certificate).exists(): raise ValueError('certificate_already_exists')
            key = rsa.generate_private_key(public_exponent=65537,key_size=3072); public = public_text(key.public_key()); now = int(time.time())
            packet = sign({'domain':'sphere-release-delegation-v1','product':'sphere','channel':trust['channel'],
                'key_id':key_id(public),'public_key':public,'roles':[args.role],'not_before':now-5,'expires_at':now+args.days*86400},root)
            certificate(packet,trust['root_public_key'],trust['channel'],args.role)
            save_key(args.private,key); write_new(args.certificate,packet)
            print('Protected delegated key created; root is not needed by the feed server.')
        else:
            path = Path(args.artifact).resolve(strict=True)
            if not 1 <= args.days <= 31: raise ValueError('release_duration')
            key = load_key(args.private); cert = parse(Path(args.certificate).read_bytes())
            checked = certificate(cert,trust['root_public_key'],trust['channel'],'release')
            if public_text(key.public_key()) != checked['public_key']: raise ValueError('delegated_key_mismatch')
            if args.platform == 'ios-arm64': raise ValueError('iOS releases require the App Store workflow; IPA self-installation is not supported')
            digest = verify_platform(args.platform,path,args.publisher,java=args.java,apksigner=args.apksigner_jar,aapt=args.aapt,sequence=args.sequence,version=args.version)
            now = int(time.time())
            body = {'domain':'sphere-release-v1','product':'sphere','channel':trust['channel'],'platform':args.platform,
                'kind':PLATFORMS[args.platform],'sequence':args.sequence,'version':args.version,'filename':path.name,
                'size':path.stat().st_size,'sha256':digest,'publisher':args.publisher,'issued_at':now,
                'expires_at':min(now+args.days*86400,checked['expires_at'])}
            bundle = {'certificate':cert,'document':sign(body,key)}
            manifest(bundle,trust['root_public_key'],trust['channel'],args.platform,trust['minimum_sequence'])
            if artifact_digest(path) != digest: raise ValueError('artifact_changed_during_signing')
            write_new(args.output,bundle)
            print('Server archive and publisher root verified; release signed locally.' if args.platform=='linux-server-source' else 'Native signature and publisher verified; production release signed locally.')


if __name__ == '__main__': main()
