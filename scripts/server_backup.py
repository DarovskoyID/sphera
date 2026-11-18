"""Encrypted SQLite group snapshots and isolated restore; never replaces live data.

This primitive is not a PostgreSQL/CometBFT/application-wide backup. Callers must
quiesce application workflows and perform protocol-specific restore validation.
"""
import argparse
from contextlib import ExitStack,closing
import getpass
import hashlib
import io
import os
from pathlib import Path
import re
import sqlite3
import struct
import tarfile
import tempfile
from cryptography.hazmat.primitives.ciphers import Cipher,algorithms,modes
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from release_v1 import canonical,parse

MAGIC=b'SPHERE-BACKUP-1\n'
MAX_SIZE=1024*1024*1024
BLOCK=1024*1024


def digest(path):
    with Path(path).open('rb') as source:return hashlib.file_digest(source,'sha256').hexdigest()
def integrity(connection):
    if connection.execute('PRAGMA integrity_check').fetchall()!=[('ok',)]:raise ValueError('server_snapshot_sqlite_integrity')
def derive(password,salt):
    if len(password)<16:raise ValueError('long_backup_password_required')
    return Scrypt(salt=salt,length=32,n=32768,r=8,p=1).derive(password.encode('utf-8'))
def encrypt(source,destination,password):
    salt=os.urandom(16);nonce=os.urandom(12)
    header=canonical({'domain':'sphere-server-backup-v1','kdf':'scrypt-32768-8-1','salt':salt.hex(),'nonce':nonce.hex()})
    cipher=Cipher(algorithms.AES(derive(password,salt)),modes.GCM(nonce)).encryptor();cipher.authenticate_additional_data(header)
    with Path(source).open('rb') as plain,os.fdopen(os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as sealed:
        sealed.write(MAGIC+struct.pack('>I',len(header))+header)
        while chunk:=plain.read(BLOCK):sealed.write(cipher.update(chunk))
        sealed.write(cipher.finalize());sealed.write(cipher.tag);sealed.flush();os.fsync(sealed.fileno())
def decrypt(source,destination,password):
    path=Path(source)
    if path.is_symlink() or not path.is_file() or not len(MAGIC)+20<path.stat().st_size<=MAX_SIZE:raise ValueError('server_backup_size')
    with path.open('rb') as sealed:
        if sealed.read(len(MAGIC))!=MAGIC:raise ValueError('server_backup_format')
        length=struct.unpack('>I',sealed.read(4))[0]
        if not 1<=length<=4096:raise ValueError('server_backup_header')
        header=sealed.read(length);body=parse(header,4096)
        if set(body)!={'domain','kdf','salt','nonce'} or body['domain']!='sphere-server-backup-v1' or body['kdf']!='scrypt-32768-8-1':raise ValueError('server_backup_header')
        if not re.fullmatch('[0-9a-f]{32}',body['salt']) or not re.fullmatch('[0-9a-f]{24}',body['nonce']):raise ValueError('server_backup_header')
        start=sealed.tell();sealed.seek(-16,2);tag=sealed.read(16);remaining=path.stat().st_size-start-16
        if remaining<0:raise ValueError('server_backup_truncated')
        sealed.seek(start)
        cipher=Cipher(algorithms.AES(derive(password,bytes.fromhex(body['salt']))),modes.GCM(bytes.fromhex(body['nonce']),tag)).decryptor();cipher.authenticate_additional_data(header)
        with os.fdopen(os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as plain:
            while remaining:
                chunk=sealed.read(min(remaining,BLOCK))
                if not chunk:raise ValueError('server_backup_truncated')
                remaining-=len(chunk);plain.write(cipher.update(chunk))
            plain.write(cipher.finalize());plain.flush();os.fsync(plain.fileno())


def backup(databases,destination,password):
    destination=Path(destination)
    if not isinstance(databases,dict) or not 1<=len(databases)<=64 or any(not re.fullmatch('[a-z][a-z0-9_-]{0,63}',name) for name in databases):raise ValueError('explicit_sqlite_inventory_required')
    if not destination.is_absolute() or destination.is_symlink() or destination.exists() or not destination.parent.is_dir():raise ValueError('new_encrypted_backup_required')
    sources={}
    for name,source in databases.items():
        path=Path(source)
        if not path.is_absolute() or path.is_symlink() or not path.is_file():raise ValueError('regular_database_required')
        sources[name]=path.resolve()
    if len(set(sources.values()))!=len(sources):raise ValueError('duplicate_database')
    with tempfile.TemporaryDirectory(prefix='server-snapshot-',dir=destination.parent) as temporary:
        folder=Path(temporary);records={}
        with ExitStack() as locks:
            # Holding all writer locks stops database writers during the entire group
            # copy. Separate read handles include committed WAL without deadlocking
            # sqlite3.backup against its own write transaction.
            for name,path in sorted(sources.items()):
                connection=locks.enter_context(closing(sqlite3.connect(path.as_uri()+'?mode=rw',uri=True,timeout=2,isolation_level=None)))
                connection.execute('BEGIN IMMEDIATE')
            for name,path in sorted(sources.items()):
                target=folder/(name+'.sqlite3')
                with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=2)) as reader,closing(sqlite3.connect(target)) as copy:
                    reader.backup(copy,pages=256);integrity(copy)
                records[target.name]={'size':target.stat().st_size,'sha256':digest(target)}
        total=sum(value['size'] for value in records.values())
        if total>MAX_SIZE-1024*1024:raise ValueError('server_snapshot_size_limit')
        index=canonical({'domain':'sphere-sqlite-group-v1','files':records,'requires_protocol_validation':True})
        archive=folder/'snapshot.tar'
        with tarfile.open(archive,'w',format=tarfile.USTAR_FORMAT) as tar:
            for name in records:
                entry=tarfile.TarInfo(name);entry.size=records[name]['size'];entry.mode=0o600
                with (folder/name).open('rb') as source:tar.addfile(entry,source)
            entry=tarfile.TarInfo('snapshot.json');entry.size=len(index);entry.mode=0o600;tar.addfile(entry,io.BytesIO(index))
        encrypt(archive,destination,password)
    return {'databases':len(records),'encrypted':True,'application_consistent':False,'live_data_replaced':False}


def restore(source,destination,password):
    destination=Path(destination)
    if not destination.is_absolute() or destination.exists() or destination.is_symlink() or not destination.parent.is_dir():raise ValueError('new_isolated_restore_directory_required')
    with tempfile.TemporaryDirectory(prefix='server-restore-',dir=destination.parent) as temporary:
        archive=Path(temporary)/'verified.tar';decrypt(source,archive,password)
        # Nothing is extracted or published before GCM authentication succeeds.
        with tarfile.open(archive,'r:') as tar:
            members=tar.getmembers()
            if not 2<=len(members)<=65:raise ValueError('server_restore_inventory')
            names=set()
            for entry in members:
                if not entry.isfile() or entry.issparse() or entry.pax_headers or entry.name in names or not 0<=entry.size<=MAX_SIZE:raise ValueError('server_restore_member')
                if entry.name!='snapshot.json' and not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}\.sqlite3',entry.name):raise ValueError('server_restore_path')
                names.add(entry.name)
            metadata=tar.getmember('snapshot.json')
            if metadata.size>32768:raise ValueError('server_restore_metadata')
            index=parse(tar.extractfile(metadata).read(),32768)
            if set(index)!={'domain','files','requires_protocol_validation'} or index['domain']!='sphere-sqlite-group-v1' or index['requires_protocol_validation'] is not True or set(index['files'])!=names-{'snapshot.json'}:raise ValueError('server_restore_inventory')
            staging=Path(temporary)/'verified';staging.mkdir(mode=0o700)
            for name,record in index['files'].items():
                entry=tar.getmember(name);target=staging/name
                if set(record)!={'size','sha256'} or type(record['size']) is not int or record['size']!=entry.size:raise ValueError('server_restore_size')
                with tar.extractfile(entry) as reader,target.open('xb') as output:
                    while chunk:=reader.read(BLOCK):output.write(chunk)
                    output.flush();os.fsync(output.fileno())
                if digest(target)!=record['sha256']:raise ValueError('server_restore_hash')
                with closing(sqlite3.connect(target.as_uri()+'?mode=ro',uri=True)) as connection:integrity(connection)
            (staging/'RESTORE_REQUIRES_PROTOCOL_VALIDATION.json').write_bytes(canonical(index))
            destination.mkdir(mode=0o700)
            for member in list(index['files'])+['RESTORE_REQUIRES_PROTOCOL_VALIDATION.json']:
                with (staging/member).open('rb') as reader,(destination/member).open('xb') as output:
                    while chunk:=reader.read(BLOCK):output.write(chunk)
                    output.flush();os.fsync(output.fileno())
    return {'databases':len(index['files']),'restored_to_new_directory':True,'application_validated':False,'live_data_replaced':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='command',required=True)
    create=sub.add_parser('backup');create.add_argument('--inventory',required=True,help='JSON map of database labels to absolute local SQLite paths');create.add_argument('--output',required=True)
    recover=sub.add_parser('restore');recover.add_argument('--backup',required=True);recover.add_argument('--destination',required=True)
    args=parser.parse_args();password=getpass.getpass('Encrypted server backup password: ')
    if args.command=='backup':
        if getpass.getpass('Repeat password: ')!=password:raise ValueError('backup_password_mismatch')
        result=backup(parse(Path(args.inventory).read_bytes()),args.output,password)
    else:result=restore(args.backup,args.destination,password)
    print(canonical(result).decode('ascii'))


if __name__=='__main__':main()
