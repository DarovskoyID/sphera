"""Verified source version storage and first activation only; no service or DB changes.

Dependency builds and service startup remain separate. Existing installations are
deliberately refused until state compatibility and recovery are implemented.
Run only in an operator-owned directory without concurrent untrusted writers.
"""
import argparse
import hashlib
import os
import sys
from pathlib import Path

from release_v1 import canonical, parse, manifest, artifact
from server_release import archive_members, stage


def directory(path):
    path=Path(path)
    if not path.is_absolute():raise ValueError('absolute_install_directory_required')
    if any(part.is_symlink() for part in (path,*path.parents)):raise ValueError('install_directory_link')
    if not path.is_dir():raise ValueError('existing_install_directory_required')
    return path


def verify(version,bundle,archive,trust,minimum,*,accepted_at=None):
    version=directory(version)
    body=manifest(bundle,trust['root_public_key'],trust['channel'],'linux-server-source',max(minimum,trust['minimum_sequence']),now=accepted_at)
    archive=artifact(body,archive);expected=archive_members(archive)
    found=set()
    for parent,dirs,files in os.walk(version,followlinks=False):
        for name in dirs:
            if (Path(parent)/name).is_symlink():raise ValueError('installed_source_link')
        for name in files:
            path=Path(parent)/name;relative=path.relative_to(version).as_posix()
            if path.is_symlink():raise ValueError('installed_source_link')
            if relative=='verified-server-release.json':
                if path.read_bytes()!=canonical(bundle):raise ValueError('installed_manifest_changed')
                continue
            if relative not in expected:raise ValueError('unexpected_installed_source')
            entry=expected[relative]
            if path.stat().st_size!=entry['size'] or hashlib.sha256(path.read_bytes()).hexdigest()!=entry['sha256']:
                raise ValueError('installed_source_changed')
            found.add(relative)
    if found!=set(expected) or not (version/'verified-server-release.json').is_file():raise ValueError('incomplete_installed_source')
    artifact(body,archive)
    return body


def prepare(root,bundle,archive,trust,minimum):
    root=directory(root)
    body=manifest(bundle,trust['root_public_key'],trust['channel'],'linux-server-source',max(minimum,trust['minimum_sequence']))
    # Exclusive deterministic version paths prevent replacement/forks in place.
    destination=root/('release-'+str(body['sequence'])+'-'+body['sha256'])
    result=stage(bundle,archive,trust,destination,minimum)
    verify(destination,bundle,archive,trust,minimum)
    return {**result,'version_directory':str(destination),'dependencies_prepared':False,'activated':False}


def activate_first(root,version,bundle,archive,trust,minimum):
    if sys.platform!='linux':raise ValueError('linux_activation_required')
    root=directory(root);version=directory(version)
    body=verify(version,bundle,archive,trust,minimum)
    if version.parent!=root or version.name!='release-'+str(body['sequence'])+'-'+body['sha256']:
        raise ValueError('managed_version_required')
    # symlink() is exclusive and atomic: even a dangling existing current blocks.
    # Never replace an active version or touch state, services or configuration.
    try:os.symlink(version.name,root/'current',target_is_directory=True)
    except FileExistsError:raise ValueError('existing_installation_requires_validated_upgrade') from None
    descriptor=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(descriptor)
    finally:os.close(descriptor)
    return {'sequence':body['sequence'],'source_activated':True,'service_started':False,'dependencies_prepared':False,'state_changed':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=('prepare','verify','activate-first'))
    for name in ('root','manifest','archive','trust'):parser.add_argument('--'+name,required=True)
    parser.add_argument('--minimum-sequence',required=True,type=int)
    parser.add_argument('--version-directory')
    args=parser.parse_args()
    bundle=parse(Path(args.manifest).read_bytes());trust=parse(Path(args.trust).read_bytes())
    if args.command=='prepare':result=prepare(args.root,bundle,args.archive,trust,args.minimum_sequence)
    else:
        if not args.version_directory:parser.error('--version-directory required')
        if args.command=='verify':result={'sequence':verify(args.version_directory,bundle,args.archive,trust,args.minimum_sequence)['sequence'],'verified':True}
        else:result=activate_first(args.root,args.version_directory,bundle,args.archive,trust,args.minimum_sequence)
    print(canonical(result).decode())


if __name__=='__main__':main()
