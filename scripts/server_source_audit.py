"""Redacted credential audit of the exact validated release archive."""
import argparse
import ast
import re
import tarfile
from pathlib import PurePosixPath
from release_v1 import canonical
from server_release import archive_members

SENSITIVE={'password','passwd','secret','secret_key','api_key','access_token','private_key','client_secret'}


def audit(path):
    inventory=archive_members(path);findings=[]
    with tarfile.open(path,'r:gz') as archive:
        for name in inventory:
            raw=archive.extractfile(name).read();text=raw.decode('utf-8-sig',errors='replace')
            for label,pattern in (
                ('private_key_pem',r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{64,}'),
                ('github_token',r'\bgh[pousr]_[A-Za-z0-9]{30,}\b'),
                ('aws_access_key',r'\bAKIA[0-9A-Z]{16}\b')):
                if re.search(pattern,text):findings.append({'path':name,'kind':label})
            filename=PurePosixPath(name).name
            if not name.endswith('.py') or filename.startswith('test_') or filename=='tests.py':continue
            try:tree=ast.parse(text)
            except SyntaxError:findings.append({'path':name,'kind':'python_parse_error'});continue
            def check(key,value,line):
                if key.lower() not in SENSITIVE or not isinstance(value,ast.Constant) or not isinstance(value.value,str):return
                secret=value.value
                if len(secret)<8 or secret.startswith(('django-insecure-','test-','dev-','REPLACE_','YOUR_')):return
                findings.append({'path':name,'line':line,'kind':'credential_literal','field':key})
            for node in ast.walk(tree):
                if isinstance(node,ast.Assign):
                    for target in node.targets:
                        if isinstance(target,ast.Name):check(target.id,node.value,node.lineno)
                elif isinstance(node,ast.Dict):
                    for key,value in zip(node.keys,node.values):
                        if isinstance(key,ast.Constant) and isinstance(key.value,str):check(key.value,value,node.lineno)
    return {'domain':'sphere-source-credential-audit-v1','files':len(inventory),'findings':findings,'passed':not findings,'limits':'pattern/literal audit, not a proof that arbitrary source contains no secrets'}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--archive',required=True);args=parser.parse_args()
    result=audit(args.archive);print(canonical(result).decode());return 0 if result['passed'] else 1


if __name__=='__main__':raise SystemExit(main())
