"""Self-managed ordinary-point credentials; private node key never leaves host."""
import base64
from hashlib import sha256
import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading
import time
from urllib.request import Request,build_opener,ProxyHandler,HTTPSHandler
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .candidates import candidate_record
from .consensus_directory import rpc
from .discovery import endpoint_record
from .identity import node_id
from .licenses import verify_attestation
from .point_enrollment import enrollment_request
from .public_transport import endpoint_url
from .storage import canonical
from .transport import NoRedirect


def post(endpoint,path,value,*,context=None):
    url=endpoint_url(endpoint)+path;opener=build_opener(ProxyHandler({}),HTTPSHandler(context=context or ssl.create_default_context()),NoRedirect())
    request=Request(url,data=canonical(value),headers={'Content-Type':'application/json','Accept-Encoding':'identity'},method='POST')
    with opener.open(request,timeout=8) as response:
        raw=response.read(2*1048576+1)
        if response.status!=200 or len(raw)>2*1048576 or response.headers.get('Content-Encoding') not in (None,'identity'):raise ValueError('bounded_network_response_required')
    return json.loads(raw)


def credential(key,directory,endpoint,port,ca,*,context=None):
    request=enrollment_request(key,directory.network,directory.pin,port);reply=post(endpoint,'/mesh/network/v1/enroll',request,context=context)
    if not isinstance(reply,dict) or set(reply)!={'body','issuer','signature'}:raise ValueError('enrollment_reply_schema')
    public=directory.license_issuers.get(reply['issuer'])
    if public is None:raise ValueError('enrollment_issuer_not_in_genesis')
    try:Ed25519PublicKey.from_public_bytes(bytes.fromhex(public)).verify(bytes.fromhex(reply['signature']),canonical(reply['body']))
    except Exception:raise ValueError('enrollment_reply_signature') from None
    body=reply['body'];identity=node_id(key.public_key().public_bytes_raw())
    if (not isinstance(body,dict) or set(body)!={'domain','network','genesis_sha256','request_nonce','node_id','endpoint','license','certificate','role','expires_at'}
            or body['domain']!='sphere-point-enrollment-v1' or body['network']!=directory.network or body['genesis_sha256']!=directory.pin
            or body['request_nonce']!=request['body']['nonce'] or body['node_id']!=identity or body['role']!='point'):raise ValueError('enrollment_reply_context')
    endpoint_url(body['endpoint'])
    from urllib.parse import urlsplit
    if urlsplit(body['endpoint']).port!=port:raise ValueError('enrollment_listener_changed')
    issuers={i:bytes.fromhex(p) for i,p in directory.license_issuers.items()}
    profile=verify_attestation(body['license'],issuers,identity,directory.network)
    if body['expires_at']!=profile.expires_at:raise ValueError('enrollment_expiry_mismatch')
    certificate=x509.load_pem_x509_certificate(body['certificate'].encode('ascii'));certificate.verify_directly_issued_by(ca)
    if certificate.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw)!=key.public_key().public_bytes_raw():raise ValueError('enrollment_certificate_key')
    import ipaddress
    if ipaddress.ip_address(urlsplit(body['endpoint']).hostname) not in certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.IPAddress):raise ValueError('enrollment_certificate_endpoint')
    return body


def write_private(path,raw):
    path=Path(path)
    if path.is_symlink() or any(p.is_symlink() for p in path.parents):raise ValueError('point_credential_link')
    fd,temporary=tempfile.mkstemp(prefix='credential-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as output:output.write(raw);output.flush();os.fsync(output.fileno())
        os.chmod(temporary,0o600);os.replace(temporary,path)
    finally:
        if os.path.exists(temporary):os.unlink(temporary)


def publish(key,directory,source,body,*,stop_event=None):
    identity=node_id(key.public_key().public_bytes_raw());directory.refresh(source,stop_event=stop_event)
    def send(record):
        result=rpc(source,'broadcast_tx_sync',{'tx':base64.b64encode(canonical(record)).decode()},stop_event=stop_event)
        if result.get('code',0):raise ValueError('point_registration_transaction_rejected')
        return sha256(canonical(record)).hexdigest()
    with directory.lock:
        old=directory.current['state'].get('candidates',{}).get(identity)
        record=candidate_record(key,directory.network,body['license'],version=old['record']['body']['version']+1 if old else 1,previous=old['digest'] if old else '0'*64)
    digest=send(record);deadline=time.monotonic()+35
    while time.monotonic()<deadline:
        if stop_event is not None and stop_event.wait(.4):raise ValueError('point_registration_stopped')
        if stop_event is None:time.sleep(.4)
        directory.refresh(source,stop_event=stop_event)
        with directory.lock:
            current=directory.current['state'].get('candidates',{}).get(identity)
            if current and current['digest']==digest:break
    else:raise ValueError('point_registration_not_confirmed')
    with directory.lock:
        prior=directory.current['state'].get('endpoints',{}).get(identity)
        if prior and prior['record']['body']['endpoint']==body['endpoint'] and prior['record']['body']['expires_at']>time.time()+120:return
        record=endpoint_record(key,directory.network,body['endpoint'],version=prior['record']['body']['version']+1 if prior else 1,previous=prior['digest'] if prior else '0'*64,endpoint_policy='https-v1')
    send(record)


class PointRegistration:
    def __init__(self,key,directory,sources,policy,port,certificate,private_key,*,server=None):
        self.key,self.directory,self.sources,self.policy,self.port=key,directory,sources,policy,port
        self.certificate,self.private_key,self.server=certificate,private_key,server
        self.ca=x509.load_pem_x509_certificate(Path(policy['ca_certificate']).read_bytes());self.context=ssl.create_default_context(cafile=policy['ca_certificate'])
        self.stopped=threading.Event();self.lock=threading.Lock();self.thread=None;self.result={'ready':False,'error':None,'expires_at':0}
    def once(self):
        body=credential(self.key,self.directory,self.policy['enrollment'],self.port,self.ca,context=self.context)
        publish(self.key,self.directory,self.sources[0],body,stop_event=self.stopped)
        write_private(self.private_key,self.key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
        write_private(self.certificate,body['certificate'].encode('ascii'))
        if self.server is not None:
            context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.minimum_version=ssl.TLSVersion.TLSv1_2;context.load_cert_chain(self.certificate,self.private_key);self.server.context=context
        with self.lock:self.result={'ready':True,'error':None,'expires_at':body['expires_at']}
        return body
    def start(self):
        if self.thread is not None:raise ValueError('point_registration_already_started')
        self.thread=threading.Thread(target=self._run,name='mesh-point-registration',daemon=True);self.thread.start();return self
    def _run(self):
        while not self.stopped.is_set():
            try:self.once();delay=120
            except (ValueError,OSError,subprocess.SubprocessError) as error:
                if hasattr(error,'close'):error.close()
                with self.lock:self.result['error']='waiting_for_network_registration'
                delay=5
            except Exception:
                with self.lock:self.result['error']='point_registration_internal_error'
                self.stopped.set();return
            self.stopped.wait(delay)
    def status(self):
        with self.lock:
            running=bool(self.thread and self.thread.is_alive())
            return {**self.result,'ready':self.result['ready'] and self.result['expires_at']>time.time() and running,'running':running}
    def stop(self):
        self.stopped.set()
        if self.thread is not None:self.thread.join(timeout=45)
        if self.thread is not None and self.thread.is_alive():raise RuntimeError('point_registration_did_not_stop')
