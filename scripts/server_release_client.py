"""Fetch a signed server-only GitHub release into NEW private staging.

No execution, service restart, UI installation or live database migration.
The public trust file must be independently provisioned, never learned here.
"""
import argparse
from contextlib import closing
import hashlib
import os
from pathlib import Path
import re
import shutil
import sqlite3
import ssl
import tempfile
import time
from urllib.parse import urlsplit
from urllib.request import Request,build_opener,ProxyHandler,HTTPSHandler,HTTPRedirectHandler
from release_v1 import parse,canonical,trust_document,manifest
from server_release import stage


class GitHubRedirects(HTTPRedirectHandler):
    max_redirections=4
    max_repeats=2
    def __init__(self,base):self.prefix='/'.join(urlsplit(base).path.split('/')[:3])+'/releases/'
    def redirect_request(self,request,fp,code,message,headers,newurl):
        url=urlsplit(newurl)
        if request.get_method()!='GET' or url.scheme!='https' or url.port not in (None,443) or url.username or url.password or url.fragment or not (
            url.hostname in ('release-assets.githubusercontent.com','objects.githubusercontent.com') or url.hostname=='github.com' and url.path.startswith(self.prefix)):
            raise ValueError('server_release_redirect_rejected')
        return super().redirect_request(request,fp,code,message,headers,newurl)


def fetch(trust,state,destination,*,opener=None,saved_release=None):
    trust_document(trust)
    base=trust['base_url'];url=urlsplit(base)
    if url.hostname!='github.com' or url.port not in (None,443) or not re.fullmatch(r'/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/latest/download/',url.path):raise ValueError('configured_github_release_source_required')
    destination=Path(destination);state=Path(state)
    if not destination.is_absolute() or destination.exists() or destination.is_symlink() or not destination.parent.is_dir():raise ValueError('new_server_staging_directory_required')
    if not state.is_absolute() or state.is_symlink() or state.resolve().is_relative_to(destination) or not state.parent.is_dir():raise ValueError('dedicated_server_release_state_required')
    if saved_release is not None:
        saved_release=Path(saved_release)
        if (not saved_release.is_absolute() or saved_release.exists() or saved_release.is_symlink()
                or not saved_release.parent.is_dir() or saved_release.resolve().is_relative_to(destination.resolve())
                or destination.resolve().is_relative_to(saved_release.resolve()) or state.resolve().is_relative_to(saved_release.resolve())):
            raise ValueError('new_separate_saved_release_directory_required')
    opener=opener or build_opener(ProxyHandler({}),HTTPSHandler(context=ssl.create_default_context()),GitHubRedirects(base))
    def transfer(name,limit,target=None,expected=None):
        request=Request(base+name,headers={'Accept-Encoding':'identity','User-Agent':'Sphere-Server-Updater/1.0'})
        started=time.monotonic();chunks=[];size=0
        with opener.open(request,timeout=15) as response:
            if response.status!=200 or response.headers.get('Content-Encoding') not in (None,'identity'):raise ValueError('server_release_response')
            declared=response.headers.get('Content-Length')
            if declared is not None and (not declared.isdecimal() or int(declared)>limit or expected is not None and int(declared)!=expected):raise ValueError('server_release_response_size')
            while True:
                if time.monotonic()-started>120:raise TimeoutError('server_release_deadline')
                data=response.read1(min(65536,limit-size+1))
                if not data:break
                size+=len(data)
                if size>limit:raise ValueError('server_release_response_limit')
                if target is None:chunks.append(data)
                else:target.write(data)
            if expected is not None and size!=expected:raise ValueError('server_release_truncated')
        return b''.join(chunks)
    with closing(sqlite3.connect(state,timeout=2)) as db:
        db.execute('PRAGMA synchronous=FULL')
        tables={row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if tables and tables!={'server_release_trust','server_release_head'}:raise ValueError('dedicated_server_release_state_required')
        db.execute('CREATE TABLE IF NOT EXISTS server_release_trust(id INTEGER PRIMARY KEY,digest TEXT NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS server_release_head(id INTEGER PRIMARY KEY,sequence INTEGER NOT NULL,digest TEXT NOT NULL)')
        with db:
            db.execute('BEGIN IMMEDIATE')
            pin=hashlib.sha256(canonical(trust)).hexdigest();previous=db.execute('SELECT digest FROM server_release_trust WHERE id=1').fetchone()
            if previous and previous!=(pin,):raise ValueError('server_release_trust_changed')
            old=db.execute('SELECT sequence,digest FROM server_release_head WHERE id=1').fetchone()
            if (previous is None)!=(old is None):raise ValueError('server_release_state_incomplete')
            raw=transfer('release-linux-server-source.json',32768);packet=parse(raw)
            body=manifest(packet,trust['root_public_key'],trust['channel'],'linux-server-source',max(trust['minimum_sequence'],old[0] if old else 1))
            digest=hashlib.sha256(raw).hexdigest()
            if old and body['sequence']==old[0] and digest!=old[1]:raise ValueError('server_release_same_version_fork')
            with tempfile.TemporaryDirectory(prefix='server-release-',dir=destination.parent) as temporary:
                archive=Path(temporary)/body['filename']
                with archive.open('xb') as output:
                    transfer(body['filename'],body['size'],output,body['size']);output.flush();os.fsync(output.fileno())
                # Reject a channel switch during the transfer. Static signatures still
                # permit replay of an unexpired release above the local floor.
                if transfer('release-linux-server-source.json',32768)!=raw:raise ValueError('server_release_changed_during_download')
                result=stage(packet,archive,trust,destination,old[0] if old else trust['minimum_sequence'])
                if saved_release is not None:
                    # Keep the original signed bytes required by install and each
                    # supervisor revalidation. Never use extracted source as proof.
                    saved_release.mkdir(mode=0o700)
                    with archive.open('rb') as source,(saved_release/body['filename']).open('xb') as output:
                        shutil.copyfileobj(source,output);output.flush();os.fsync(output.fileno())
                    with (saved_release/'release-linux-server-source.json').open('xb') as output:
                        output.write(raw);output.flush();os.fsync(output.fileno())
                    from release_v1 import artifact
                    artifact(body,saved_release/body['filename'])
                    receipt={'domain':'sphere-saved-server-release-v1','sequence':body['sequence'],
                        'archive':str(saved_release/body['filename']),'manifest':str(saved_release/'release-linux-server-source.json'),
                        'manifest_sha256':digest,'installed':False}
                    with (saved_release/'saved-release.json').open('xb') as output:
                        output.write(canonical(receipt));output.flush();os.fsync(output.fileno())
                    if os.name=='posix':
                        fd=os.open(saved_release,os.O_RDONLY|os.O_DIRECTORY)
                        try:os.fsync(fd)
                        finally:os.close(fd)
                    result={**result,'saved_release':str(saved_release)}
            db.execute('INSERT OR IGNORE INTO server_release_trust VALUES(1,?)',(pin,))
            db.execute('INSERT OR REPLACE INTO server_release_head VALUES(1,?,?)',(body['sequence'],digest))
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('trust','state','destination'):parser.add_argument('--'+name,required=True)
    parser.add_argument('--saved-release',help='New separate private directory retaining the signed archive for install/supervisor')
    args=parser.parse_args();result=fetch(parse(Path(args.trust).read_bytes()),args.state,args.destination,saved_release=args.saved_release)
    print(canonical(result).decode('ascii'))


if __name__=='__main__':main()
