"""Loopback-only browser entry adapter using verified mesh snapshots.

No node/account private key or password is loaded by this service. Authentication
is forwarded by the HTTPS edge to the existing point; only signed account
registration is submitted here after local validation.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlsplit,parse_qs


def main():
    p=argparse.ArgumentParser();p.add_argument('--config',required=True);a=p.parse_args();config=json.loads(Path(a.config).read_bytes());version=Path(config['version']);sys.path[:0]=[str(version/'scripts'),str(version/'django-server/sfera_server')]
    from sfera_mesh.consensus_directory import ConsensusDirectory,rpc
    from sfera_mesh.consensus_gateway import GatewaySource
    from sfera_mesh.consensus_updater import ConsensusUpdater
    from sfera_mesh.directory import validate_record
    from sfera_mesh.storage import canonical
    from sfera_mesh.network_peers import approved_network_peers
    os.environ['SSL_CERT_FILE']=config['ca'];state=Path(config['state']);directory=ConsensusDirectory(str(state/'directory.sqlite'),config['verifier'],config['genesis']);source=GatewaySource(config['gateway']);updater=ConsensusUpdater(directory,[source]).start();lock=threading.Lock();registrations=[];slots=threading.BoundedSemaphore(12)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def send(self,status,value):
            raw=canonical(value);self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(raw)
        def do_GET(self):
            try:
                path=urlsplit(self.path)
                if path.path=='/web-api/info':
                    with directory.lock:
                        anchor=directory.anchor();approved=approved_network_peers(directory)
                    peers=[p for p in config['peers'] if p['nodeId'] in approved]
                    self.send(200,{'network':directory.network,'nodeId':config['nodeId'],'publicKey':config['publicKey'],'label':config['label'],'ready':updater.status()['ready'] and config['nodeId'] in approved,'height':anchor['height'],'peers':peers})
                elif path.path=='/web-api/account':
                    query=parse_qs(path.query)
                    if set(query)!={'user'} or len(query['user'])!=1 or not re.fullmatch('[0-9a-f]{64}',query['user'][0]):raise ValueError('invalid_user')
                    result=directory.get(query['user'][0]);self.send(404 if result.get('error') else 200,result)
                else:self.send(404,{'error':'not_found'})
            except (ValueError,OSError):self.send(503,{'error':'point_not_ready'})
        def do_POST(self):
            if self.path!='/web-api/register':self.send(404,{'error':'not_found'});return
            if not slots.acquire(blocking=False):self.send(429,{'error':'busy'});return
            try:
                self.connection.settimeout(10);lengths=self.headers.get_all('Content-Length',[])
                if len(lengths)!=1 or not lengths[0].isdecimal() or not 0<int(lengths[0])<=16384 or self.headers.get('Transfer-Encoding') or self.headers.get_content_type()!='application/json':raise ValueError('bounded_record_required')
                if self.headers.get('Origin') not in (None,config['origin']):raise ValueError('same_origin_required')
                raw=self.rfile.read(int(lengths[0]))
                if len(raw)!=int(lengths[0]):raise ValueError('truncated_record')
                record=json.loads(raw);body,digest=validate_record(record,directory.network)
                if body['version']!=1:raise ValueError('initial_account_only')
                with directory.lock:directory.anchor()
                existing=directory.get(body['user_id'])
                if not existing.get('error'):
                    if existing['record_hash']!=digest:raise ValueError('account_already_registered')
                    self.send(200,{'confirmed':True,'user_id':body['user_id']});return
                with lock:
                    now=time.monotonic();registrations[:]=[t for t in registrations if now-t<60]
                    if len(registrations)>=12:self.send(429,{'error':'try_later'});return
                    registrations.append(now)
                response=rpc(source,'broadcast_tx_sync',{'tx':base64.b64encode(canonical(record)).decode()})
                if response.get('code',0):raise ValueError('account_rejected')
                deadline=time.monotonic()+20
                while time.monotonic()<deadline:
                    try:
                        result=directory.get(body['user_id'])
                        if result.get('record_hash')==digest:self.send(200,{'confirmed':True,'user_id':body['user_id']});return
                    except ValueError:pass
                    time.sleep(.4)
                self.send(202,{'confirmed':False,'user_id':body['user_id']})
            except (ValueError,TypeError,KeyError,UnicodeError):self.send(400,{'error':'invalid_account'})
            except OSError:self.send(503,{'error':'point_not_ready'})
            finally:slots.release()
    class Server(ThreadingHTTPServer):
        daemon_threads=True
        limit=threading.BoundedSemaphore(16)
        def get_request(self):
            connection,address=super().get_request();connection.settimeout(10);return connection,address
        def process_request(self,request,address):
            if not self.limit.acquire(blocking=False):self.shutdown_request(request);return
            try:super().process_request(request,address)
            except BaseException:self.limit.release();raise
        def process_request_thread(self,request,address):
            try:super().process_request_thread(request,address)
            finally:self.limit.release()
    server=Server(('127.0.0.1',9080),Handler);stop=threading.Event()
    for sig in (signal.SIGINT,signal.SIGTERM):signal.signal(sig,lambda *_:stop.set())
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();print('SPHERE_WEB_BRIDGE_LISTENING 127.0.0.1:9080',flush=True)
    try:stop.wait()
    finally:server.shutdown();server.server_close();updater.stop();directory.close()


if __name__=='__main__':main()
