"""Create the first Android production identity and build with protected custody.

This never replaces an existing keystore and never installs an APK. Android
debug installations cannot be updated with this new production certificate.
"""
import argparse
import base64
import hashlib
import getpass
import os
from pathlib import Path
import secrets
import subprocess
from cryptography import x509
from release_keys import _dpapi
from release_v1 import canonical, parse


def main():
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='operation',required=True)
    first=sub.add_parser('init');first.add_argument('--directory',required=True);first.add_argument('--keytool',required=True)
    build=sub.add_parser('build');build.add_argument('--directory',required=True);build.add_argument('--project',required=True)
    build.add_argument('--sequence',type=int,required=True);build.add_argument('--version',required=True)
    backup=sub.add_parser('backup');backup.add_argument('--directory',required=True);backup.add_argument('--output',required=True);backup.add_argument('--keytool',required=True)
    args=parser.parse_args();folder=Path(args.directory)
    if not folder.is_absolute() or not folder.is_dir() or folder.is_symlink(): raise ValueError('dedicated_absolute_private_directory_required')
    store=folder/'android-release.p12';password_file=folder/'android-password.dpapi';public_file=folder/'android-public.json'
    if args.operation=='init':
        if any(path.exists() for path in (store,password_file,public_file)): raise ValueError('android_identity_already_exists')
        if not Path(args.keytool).is_file(): raise ValueError('JDK_keytool_required')
        password=secrets.token_urlsafe(48);protected=_dpapi(password.encode('ascii'),True)
        environment={**os.environ,'SPHERE_KEYTOOL_PASSWORD':password}
        subprocess.run([args.keytool,'-genkeypair','-keystore',str(store),'-storetype','PKCS12','-storepass:env','SPHERE_KEYTOOL_PASSWORD',
            '-keypass:env','SPHERE_KEYTOOL_PASSWORD','-alias','sphere-release','-keyalg','RSA','-keysize','3072','-sigalg','SHA256withRSA',
            '-validity','10000','-dname','CN=Sphere Android Release','-noprompt'],env=environment,check=True,capture_output=True,timeout=60)
        with password_file.open('xb') as output:output.write(protected);output.flush();os.fsync(output.fileno())
        result=subprocess.run([args.keytool,'-exportcert','-keystore',str(store),'-storepass:env','SPHERE_KEYTOOL_PASSWORD','-alias','sphere-release'],
            env=environment,check=True,capture_output=True,timeout=30)
        certificate=x509.load_der_x509_certificate(result.stdout);fingerprint=hashlib.sha256(result.stdout).hexdigest()
        metadata={'domain':'sphere-android-publisher-v1','package':'com.sfera.ru','alias':'sphere-release','certificate_sha256':fingerprint,
            'certificate_der':base64.b64encode(result.stdout).decode(),'not_after':certificate.not_valid_after_utc.isoformat()}
        with public_file.open('xb') as output:output.write(canonical(metadata))
        print('Android production identity created. Its keystore is password-encrypted; that password is protected by current-user DPAPI. No APK installed.')
        print('Public publisher SHA-256: '+fingerprint)
    else:
        if any(path.is_symlink() or not path.is_file() for path in (store,password_file,public_file)): raise ValueError('complete_protected_android_identity_required')
        if password_file.stat().st_size>16384: raise ValueError('invalid_android_custody')
        metadata=parse(public_file.read_bytes());password=_dpapi(password_file.read_bytes(),False).decode('ascii')
        if args.operation=='backup':
            destination=Path(args.output)
            if not destination.is_absolute() or destination.exists() or destination.is_symlink() or not destination.parent.is_dir(): raise ValueError('new_encrypted_backup_path_required')
            chosen=getpass.getpass('Offline Android keystore password: ')
            if len(chosen)<16 or getpass.getpass('Repeat password: ')!=chosen: raise ValueError('long_matching_backup_password_required')
            environment={**os.environ,'SPHERE_SOURCE_PASSWORD':password,'SPHERE_DESTINATION_PASSWORD':chosen}
            subprocess.run([args.keytool,'-importkeystore','-srckeystore',str(store),'-srcstoretype','PKCS12','-srcstorepass:env','SPHERE_SOURCE_PASSWORD',
                '-srcalias',metadata['alias'],'-destkeystore',str(destination),'-deststoretype','PKCS12','-deststorepass:env','SPHERE_DESTINATION_PASSWORD',
                '-destkeypass:env','SPHERE_DESTINATION_PASSWORD','-noprompt'],env=environment,check=True,capture_output=True,timeout=60)
            check=subprocess.run([args.keytool,'-exportcert','-keystore',str(destination),'-storepass:env','SPHERE_DESTINATION_PASSWORD','-alias',metadata['alias']],
                env=environment,check=True,capture_output=True,timeout=30)
            if hashlib.sha256(check.stdout).hexdigest()!=metadata['certificate_sha256']: raise ValueError('offline_android_backup_identity_mismatch')
            print('Password-encrypted portable Android keystore backup verified locally. No password printed.')
            return
        project=Path(args.project).resolve(strict=True)
        environment={**os.environ,'SPHERE_ANDROID_KEYSTORE':str(store),'SPHERE_ANDROID_STORE_PASSWORD':password,
            'SPHERE_ANDROID_KEY_PASSWORD':password,'SPHERE_ANDROID_KEY_ALIAS':metadata['alias'],
            'SPHERE_RELEASE_SEQUENCE':str(args.sequence),'SPHERE_RELEASE_VERSION':args.version}
        subprocess.run([str(project/('gradlew.bat' if os.name=='nt' else 'gradlew')),':app:assembleRelease','--no-daemon','--console=plain'],
            cwd=project,env=environment,check=True,timeout=600)


if __name__=='__main__':main()
