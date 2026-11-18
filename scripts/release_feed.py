"""Loopback origin for a production HTTPS release feed (TLS reverse proxy required).

Only a short-lived head key is online. Never accepts an artifact/manifest or root
key through HTTP. Feed changes are local operator actions, checked before use.
"""
import argparse
from contextlib import closing
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import sqlite3
import threading
import time
from urllib.parse import urlsplit
from release_v1 import canonical, parse, fields, manifest, certificate, sign, public_text, artifact, PLATFORMS, HEX, trust_document
from release_keys import load_key


class ReleaseFeed:
    def __init__(self, trust, directory, state, head_key, head_certificate):
        self.trust, self.folder = trust_document(trust), Path(directory).resolve(strict=True)
        self.key, self.cert, self.lock = head_key, head_certificate, threading.RLock()
        checked = certificate(head_certificate, trust['root_public_key'], trust['channel'], 'head')
        if public_text(head_key.public_key()) != checked['public_key']: raise ValueError('head_key_mismatch')
        state = Path(state)
        if not state.is_absolute() or state.is_symlink() or state.resolve().is_relative_to(self.folder) or not state.parent.is_dir(): raise ValueError('dedicated_feed_state_required')
        self.state = state
        with closing(sqlite3.connect(state)) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if tables and tables != {'feed_trust', 'feed_heads'}: raise ValueError('dedicated_feed_state_required')
            db.executescript('CREATE TABLE IF NOT EXISTS feed_trust(id INTEGER PRIMARY KEY, digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS feed_heads(platform TEXT PRIMARY KEY, sequence INTEGER NOT NULL, digest TEXT NOT NULL);')
            pin = hashlib.sha256(canonical(trust)).hexdigest()
            old = db.execute('SELECT digest FROM feed_trust WHERE id=1').fetchone()
            if old and old != (pin,): raise ValueError('feed_trust_changed')
            with db: db.execute('INSERT OR IGNORE INTO feed_trust VALUES(1,?)',(pin,))

    def current(self, platform):
        if platform not in PLATFORMS: raise ValueError('unknown_release_platform')
        with self.lock:
            folder = self.folder / platform
            path = folder / 'release.json'
            if folder.is_symlink() or path.is_symlink() or not path.is_file() or path.stat().st_size > 32768: raise ValueError('release_unavailable')
            packet = parse(path.read_bytes()); raw = canonical(packet)
            body = manifest(packet,self.trust['root_public_key'],self.trust['channel'],platform,self.trust['minimum_sequence'])
            if body['kind'] != 'apple-store': artifact(body,folder/body['filename'])
            digest = hashlib.sha256(raw).hexdigest()
            with closing(sqlite3.connect(self.state)) as db:
                db.execute('PRAGMA synchronous=FULL')
                with db:
                    db.execute('BEGIN IMMEDIATE')
                    prior = db.execute('SELECT sequence,digest FROM feed_heads WHERE platform=?',(platform,)).fetchone()
                    if prior and (body['sequence'] < prior[0] or body['sequence'] == prior[0] and digest != prior[1]): raise ValueError('feed_rollback_or_fork')
                    db.execute('INSERT OR REPLACE INTO feed_heads VALUES(?,?,?)',(platform,body['sequence'],digest))
            return body, raw, digest

    def head(self, platform, nonce):
        if not isinstance(nonce,str) or not HEX.fullmatch(nonce): raise ValueError('release_nonce')
        with self.lock:
            delegated=certificate(self.cert,self.trust['root_public_key'],self.trust['channel'],'head')
            body, _, digest = self.current(platform); now = int(time.time())
            if delegated['expires_at'] < now+30: raise ValueError('head_delegation_needs_renewal')
            packet = {'domain':'sphere-release-head-v1','product':'sphere','channel':self.trust['channel'],'platform':platform,
                'nonce':nonce,'sequence':body['sequence'],'manifest_sha256':digest,'issued_at':now,'expires_at':now+30}
            return {'certificate':self.cert,'document':sign(packet,self.key)}


def handler(feed):
    prefix = urlsplit(feed.trust['base_url']).path.rstrip('/')+'/'
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args): pass
        def setup(self):
            super().setup(); self.connection.settimeout(5)
        def response(self, status, raw=b'', content='application/json'):
            self.send_response(status); self.send_header('Content-Type',content); self.send_header('Content-Length',str(len(raw)))
            self.send_header('Cache-Control','no-store'); self.send_header('X-Content-Type-Options','nosniff'); self.end_headers(); self.wfile.write(raw)
        def route(self):
            if not self.path.startswith(prefix) or '?' in self.path or '%' in self.path or '\\' in self.path: raise ValueError('release_route')
            parts = self.path[len(prefix):].split('/')
            if len(parts)!=2 or parts[0] not in PLATFORMS: raise ValueError('release_route')
            return parts
        def do_POST(self):
            try:
                platform, name = self.route()
                length = self.headers.get('Content-Length','')
                if name != 'head' or not length.isdecimal() or not 1<=int(length)<=256 or self.headers.get('Transfer-Encoding'): raise ValueError('release_request')
                request = parse(self.rfile.read(int(length)),256); fields(request,'nonce')
                result = feed.head(platform,request['nonce'])
            except (ValueError,KeyError,TypeError): return self.response(400,b'{}')
            except Exception: return self.response(503,b'{}')
            self.response(200,canonical(result))
        def do_GET(self):
            try:
                platform, name = self.route(); body, raw, _ = feed.current(platform)
                if name == 'release.json': return self.response(200,raw)
                if body['kind']=='apple-store' or name != body['filename']: raise ValueError('release_route')
                path = artifact(body,feed.folder/platform/name)
                # Recheck the exact bytes before serving; the client also hashes
                # the complete response, so a concurrent local rewrite fails.
                with path.open('rb') as source:
                    self.send_response(200); self.send_header('Content-Type','application/octet-stream')
                    self.send_header('Cache-Control','no-store'); self.send_header('X-Content-Type-Options','nosniff')
                    self.send_header('Content-Length',str(body['size'])); self.end_headers()
                    for chunk in iter(lambda: source.read(65536),b''): self.wfile.write(chunk)
            except (ValueError,KeyError,TypeError): self.response(404,b'{}')
            except (BrokenPipeError,ConnectionError): pass
            except Exception: self.response(503,b'{}')
    return Handler


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('trust','directory','state','head-private','head-certificate'): parser.add_argument('--'+name,required=True)
    parser.add_argument('--port',type=int,default=8874)
    args=parser.parse_args(); trust=parse(Path(args.trust).read_bytes())
    feed=ReleaseFeed(trust,args.directory,args.state,load_key(args.head_private),parse(Path(args.head_certificate).read_bytes()))
    server=ThreadingHTTPServer(('127.0.0.1',args.port),handler(feed)); server.daemon_threads=True
    try: server.serve_forever()
    finally: server.server_close()


if __name__=='__main__': main()
