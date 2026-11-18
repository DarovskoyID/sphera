"""Server-only source snapshots and verified extraction. Never starts services.

No UI, client binaries, runtime databases, accounts or private module service.
Source deployment/dependency installation is a separate operator operation.
"""
import argparse
import gzip
import hashlib
import io
import os
from pathlib import Path, PurePosixPath
import re
import tarfile
from release_v1 import canonical, parse, manifest, artifact

MAX_FILES=20000
MAX_TOTAL=512*1024*1024
MAX_SINGLE=32*1024*1024


def allowed(name):
    if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9_./-]+',name):return False
    path=PurePosixPath(name)
    if path.is_absolute() or path.as_posix()!=name or any(part in ('','.','..') or part.startswith('.') for part in name.split('/')):return False
    if any(part in ('myenv','venv','node_modules','__pycache__','media','output','commercial-service','target','bin','obj') for part in path.parts):return False
    if name in ('django-server/requirements.txt','ws-gateway/Cargo.toml','ws-gateway/Cargo.lock','mesh-consensus/go.mod','mesh-consensus/go.sum','deploy/server/sfera-point.service','deploy/server/sfera-point-supervised.service','deploy/server/point.example.json','deploy/server/sfera-validator.service','deploy/server/validator.example.json','release/production-policy.json','release/trust.public.json'):return True
    if name.startswith('django-server/sfera_server/'):
        return path.suffix=='.py' or re.fullmatch(r'django-server/sfera_server/local_workspaces/[a-z0-9_]+/module.json',name) is not None
    if name.startswith('mesh-consensus/') and len(path.parts)==2:return path.suffix=='.go'
    if name.startswith('ws-gateway/src/'):return path.suffix=='.rs'
    if name.startswith('scripts/') and len(path.parts)==2:
        return path.suffix=='.py' and path.name.startswith(('mesh_','mesh-','release_','server_')) and 'fixture' not in path.name
    return False


def safe_root(root):
    root=Path(root)
    if root.is_symlink() or not root.is_dir():raise ValueError('regular_source_directory_required')
    return root.resolve(strict=True)


def archive_members(path):
    path=Path(path)
    if path.is_symlink() or not path.is_file() or not 0<path.stat().st_size<=MAX_TOTAL:raise ValueError('server_archive_size')
    result={};total=0;index=None
    with tarfile.open(path,'r:gz') as archive:
        for item in archive:
            if len(result)>=MAX_FILES or not item.isfile() or item.issparse() or item.pax_headers or item.size<0 or item.size>MAX_SINGLE:raise ValueError('server_archive_member')
            name=item.name
            if name in result or name!='server-source.json' and not allowed(name):raise ValueError('server_archive_path')
            total+=item.size
            if total>MAX_TOTAL:raise ValueError('server_archive_expansion')
            with archive.extractfile(item) as stream:
                raw=stream.read(item.size+1)
            if len(raw)!=item.size:raise ValueError('server_archive_truncated')
            result[name]={'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
            if name=='server-source.json':index=parse(raw,MAX_SINGLE)
    if not isinstance(index,dict) or set(index)!={'domain','files'} or index['domain']!='sphere-server-source-v1':raise ValueError('server_archive_inventory')
    actual={name:value for name,value in result.items() if name!='server-source.json'}
    if not actual or index['files']!=actual:raise ValueError('server_archive_inventory_mismatch')
    return actual


def pack(source,destination):
    root=safe_root(source);destination=Path(destination)
    if not destination.is_absolute() or destination.is_symlink() or destination.exists() or not destination.parent.is_dir():raise ValueError('new_server_archive_required')
    inputs=[];inventory={};total=0
    # Explicit code roots avoid traversing media, virtualenvs and private repos.
    for prefix in ('django-server/sfera_server','mesh-consensus','ws-gateway/src','scripts'):
        folder=root/prefix
        if not folder.exists():continue
        if folder.is_symlink() or not folder.resolve().is_relative_to(root):raise ValueError('server_source_link')
        for current,dirs,files in os.walk(folder,followlinks=False):
            base=Path(current)
            dirs[:]=sorted(name for name in dirs if not name.startswith('.') and name not in ('__pycache__','media','node_modules','target','myenv','venv','output','bin','obj'))
            for name in dirs:
                if (base/name).is_symlink():raise ValueError('server_source_link')
            for name in sorted(files):
                path=base/name;relative=path.relative_to(root).as_posix()
                if allowed(relative):inputs.append((relative,path))
    for name in ('django-server/requirements.txt','ws-gateway/Cargo.toml','ws-gateway/Cargo.lock','mesh-consensus/go.mod','mesh-consensus/go.sum','deploy/server/sfera-point.service','deploy/server/sfera-point-supervised.service','deploy/server/point.example.json','deploy/server/sfera-validator.service','deploy/server/validator.example.json','release/production-policy.json','release/trust.public.json'):
        if (root/name).exists():inputs.append((name,root/name))
    # Snapshot each file once: no secret/private files, file links or live DBs.
    snapshot=[]
    for name,path in sorted(dict(inputs).items()):
        if path.is_symlink() or not path.is_file() or path.stat().st_size>MAX_SINGLE:raise ValueError('server_source_file')
        raw=path.read_bytes();total+=len(raw)
        if total>MAX_TOTAL or len(snapshot)>=MAX_FILES-1:raise ValueError('server_source_limit')
        snapshot.append((name,raw));inventory[name]={'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
    if not snapshot:raise ValueError('empty_server_source')
    snapshot.append(('server-source.json',canonical({'domain':'sphere-server-source-v1','files':inventory})))
    with destination.open('xb') as output:
        with gzip.GzipFile(filename='',fileobj=output,mode='wb',mtime=0) as zipped:
            with tarfile.open(fileobj=zipped,mode='w',format=tarfile.USTAR_FORMAT) as archive:
                for name,raw in snapshot:
                    item=tarfile.TarInfo(name);item.size=len(raw);item.mode=0o644;item.mtime=0;item.uid=item.gid=0
                    archive.addfile(item,io.BytesIO(raw))
        output.flush();os.fsync(output.fileno())
    archive_members(destination)
    return {'files':len(inventory),'bytes':total,'ui_included':False,'installed':False}


def stage(bundle,path,trust,destination,minimum=1):
    body=manifest(bundle,trust['root_public_key'],trust['channel'],'linux-server-source',max(minimum,trust['minimum_sequence']))
    path=artifact(body,path);expected=archive_members(path);destination=Path(destination)
    if not destination.is_absolute() or destination.exists() or destination.is_symlink() or not destination.parent.is_dir():raise ValueError('new_server_staging_directory_required')
    destination.mkdir(mode=0o700)
    # Copy verified bytes, never tar.extract/extractall; every destination is new.
    with tarfile.open(path,'r:gz') as archive:
        seen=set()
        for item in archive:
            if item.name=='server-source.json':continue
            if not item.isfile() or item.name not in expected or item.name in seen or not allowed(item.name):raise ValueError('server_archive_changed')
            seen.add(item.name);target=destination.joinpath(*PurePosixPath(item.name).parts)
            target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            data=archive.extractfile(item).read(MAX_SINGLE+1)
            if {'size':len(data),'sha256':hashlib.sha256(data).hexdigest()}!=expected[item.name]:raise ValueError('server_archive_changed')
            with target.open('xb') as output:output.write(data);output.flush();os.fsync(output.fileno())
        if seen!=set(expected):raise ValueError('server_archive_changed')
    artifact(body,path)
    # Marker is the completion barrier; failures leave no ready release marker.
    with (destination/'verified-server-release.json').open('xb') as output:
        output.write(canonical(bundle));output.flush();os.fsync(output.fileno())
    return {'sequence':body['sequence'],'files':len(expected),'staged':True,'installed':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='command',required=True)
    create=sub.add_parser('pack');create.add_argument('--source',required=True);create.add_argument('--output',required=True)
    check=sub.add_parser('verify');check.add_argument('--archive',required=True)
    extract=sub.add_parser('stage')
    for name in ('manifest','archive','trust','destination'):extract.add_argument('--'+name,required=True)
    extract.add_argument('--minimum-sequence',type=int,required=True,help='Independently trusted persistent floor; do not reset on update')
    args=parser.parse_args()
    if args.command=='pack':result=pack(args.source,args.output)
    elif args.command=='verify':result={'files':len(archive_members(args.archive)),'installed':False}
    else:result=stage(parse(Path(args.manifest).read_bytes()),args.archive,parse(Path(args.trust).read_bytes()),args.destination,args.minimum_sequence)
    print(canonical(result).decode('ascii'))


if __name__=='__main__':main()
