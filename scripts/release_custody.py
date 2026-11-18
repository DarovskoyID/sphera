"""Interactive encrypted offline backup/restore of an owner-held release root.

Passwords are prompted locally, never command-line arguments or environment vars.
"""
import argparse
import getpass
from pathlib import Path
from cryptography.hazmat.primitives import serialization
from release_keys import load_key, save_key
from release_v1 import parse, public_text


def backup(private, destination, password):
    target=Path(destination)
    if len(password)<16 or not target.is_absolute() or target.exists() or target.is_symlink() or not target.parent.is_dir(): raise ValueError('new_backup_path_and_long_password_required')
    key=load_key(private)
    encrypted=key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.BestAvailableEncryption(password.encode('utf-8')))
    # Verify the exact encrypted representation before committing the backup.
    restored=serialization.load_pem_private_key(encrypted,password.encode('utf-8'))
    if public_text(restored.public_key())!=public_text(key.public_key()): raise ValueError('backup_verification_failed')
    with target.open('xb') as output:
        import os
        output.write(encrypted);output.flush();os.fsync(output.fileno())


def restore(backup_path, private, trust, password):
    path=Path(backup_path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size>16384: raise ValueError('invalid_root_backup')
    key=serialization.load_pem_private_key(path.read_bytes(),password.encode('utf-8'))
    if public_text(key.public_key())!=parse(Path(trust).read_bytes())['root_public_key']: raise ValueError('restored_root_does_not_match_independent_trust')
    save_key(private,key)


def main():
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='operation',required=True)
    first=sub.add_parser('backup');first.add_argument('--private',required=True);first.add_argument('--output',required=True)
    second=sub.add_parser('restore');second.add_argument('--backup',required=True);second.add_argument('--private',required=True);second.add_argument('--trust',required=True)
    args=parser.parse_args();password=getpass.getpass('Offline backup password: ')
    if args.operation=='backup':
        if getpass.getpass('Repeat password: ')!=password: raise ValueError('password_mismatch')
        backup(args.private,args.output,password)
    else:restore(args.backup,args.private,args.trust,password)
    print('Custody operation verified locally. No private key was printed or uploaded.')


if __name__=='__main__':main()
