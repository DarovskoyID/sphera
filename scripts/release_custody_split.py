"""Owner-authorized split-drive custody. Never prints keys or recovery secrets.

Encrypted portable keys and the recovery secret must use different physical
disks, both separate from the source key and Windows system disk. This does
not claim that mounted internal disks are physically offline/off-site.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import padding
from release_keys import load_key
from release_v1 import canonical,parse,public_text,key_id,certificate


def seal(key,password):
    encrypted=key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.BestAvailableEncryption(password.encode('ascii')))
    restored=serialization.load_pem_private_key(encrypted,password.encode('ascii'))
    challenge=secrets.token_bytes(32)
    signature=restored.sign(challenge,padding.PSS(mgf=padding.MGF1(hashes.SHA256()),salt_length=32),hashes.SHA256())
    key.public_key().verify(signature,challenge,padding.PSS(mgf=padding.MGF1(hashes.SHA256()),salt_length=32),hashes.SHA256())
    if public_text(restored.public_key())!=public_text(key.public_key()):raise ValueError('portable_custody_key_mismatch')
    return encrypted


def powershell(script,*args):
    code="[object[]]$custodyArgs = ConvertFrom-Json ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SPHERE_CUSTODY_ARGUMENTS))); "+script+" @custodyArgs"
    encoded=base64.b64encode(code.encode('utf-16le')).decode('ascii')
    env={**os.environ,'SPHERE_CUSTODY_ARGUMENTS':base64.b64encode(canonical(list(map(str,args)))).decode('ascii')}
    result=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',encoded],capture_output=True,text=True,env=env)
    if result.returncode:raise RuntimeError('custody_system_operation_failed: '+result.stderr[-4000:])
    return result.stdout.strip()


def disk(path):
    path=Path(path)
    if not path.is_absolute() or len(path.drive)!=2 or path.drive[1]!=':':raise ValueError('local_absolute_drive_required')
    return int(powershell("& {param($letter) (Get-Partition -DriveLetter $letter -ErrorAction Stop).DiskNumber}",path.drive[0]))


def private_directory(path):
    path=Path(path)
    if path.exists() or path.is_symlink() or not path.parent.is_dir():raise ValueError('new_custody_directory_required')
    for parent in path.parents:
        if parent.is_symlink():raise ValueError('custody_parent_link')
    path.mkdir()
    powershell("""& {param($path)
      $owner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
      $system=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
      $acl=New-Object System.Security.AccessControl.DirectorySecurity
      $acl.SetAccessRuleProtection($true,$false)
      foreach($sid in @($owner,$system)) {
        $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
        $acl.AddAccessRule($rule)
      }
      [System.IO.Directory]::SetAccessControl($path,$acl)
      $actual=[System.IO.Directory]::GetAccessControl($path)
      if(-not $actual.AreAccessRulesProtected){throw 'Custody ACL inheritance not protected'}
      foreach($rule in $actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
        if($rule.IdentityReference.Value -notin @($owner.Value,'S-1-5-18')){throw 'Unexpected custody ACL principal'}
      }
    }""",path)
    return path


def write(path,raw):
    with Path(path).open('xb') as output:output.write(raw);output.flush();os.fsync(output.fileno())


def validate_disks(numbers):
    if set(numbers)!={'source','system','backup','secret'} or any(type(value) is not int or value<0 for value in numbers.values()):raise ValueError('physical_custody_disk_inventory_required')
    if numbers['backup']==numbers['secret'] or any(numbers[name] in (numbers['source'],numbers['system']) for name in ('backup','secret')):raise ValueError('independent_custody_disks_required')


def backup(root,delegate,delegation,trust,expected_root,backup_folder,secret_folder):
    if os.name!='nt':raise ValueError('windows_split_drive_custody_required')
    backup_folder=Path(backup_folder);secret_folder=Path(secret_folder)
    numbers={'source':disk(root),'system':disk(Path(os.environ['SystemRoot'])),'backup':disk(backup_folder),'secret':disk(secret_folder)}
    validate_disks(numbers)
    policy=parse(Path(trust).read_bytes());root_key=load_key(root);delegate_key=load_key(delegate)
    if key_id(public_text(root_key.public_key()))!=expected_root or public_text(root_key.public_key())!=policy['root_public_key']:raise ValueError('independent_root_pin_mismatch')
    cert=certificate(parse(Path(delegation).read_bytes()),policy['root_public_key'],policy['channel'],'release')
    if public_text(delegate_key.public_key())!=cert['public_key']:raise ValueError('delegate_key_mismatch')
    backup_folder=private_directory(backup_folder);secret_folder=private_directory(secret_folder)
    password=secrets.token_urlsafe(48)
    # Secret is local, protected by owner/SYSTEM ACL, on a third disk. It is not
    # derived from DPAPI, so recovery does not require the old Windows profile.
    write(secret_folder/'recovery-secret.json',canonical({'domain':'sphere-release-custody-secret-v1','root_key_id':expected_root,'password':password}))
    records={}
    for label,key in (('root',root_key),('release',delegate_key)):
        raw=seal(key,password);path=backup_folder/(label+'.pk8.enc');write(path,raw)
        # Verify actual disk bytes with the separately persisted secret, not the
        # source files or DPAPI. Never write a decrypted private key.
        recovery=parse((secret_folder/'recovery-secret.json').read_bytes())['password']
        restored=serialization.load_pem_private_key(path.read_bytes(),recovery.encode('ascii'))
        if public_text(restored.public_key())!=public_text(key.public_key()):raise ValueError('custody_readback_mismatch')
        records[path.name]={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'public_key_id':key_id(public_text(restored.public_key()))}
    write(backup_folder/'trust.public.json',canonical(policy))
    write(backup_folder/'release-delegation.json',Path(delegation).read_bytes())
    report={'domain':'sphere-release-custody-report-v1','root_key_id':expected_root,'physical_disks':numbers,'keys':records,
        'portable_restore_verified':True,'original_dpapi_not_required_for_restore':True,'physically_offline':False,'offsite':False}
    write(backup_folder/'custody-report.json',canonical(report))
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('root','delegate','delegation','trust','expected-root','backup-folder','secret-folder'):parser.add_argument('--'+name,required=True)
    args=parser.parse_args();result=backup(args.root,args.delegate,args.delegation,args.trust,args.expected_root,args.backup_folder,args.secret_folder)
    print(canonical(result).decode())


if __name__=='__main__':main()
