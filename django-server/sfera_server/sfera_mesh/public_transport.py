"""Explicitly configured TLS transport. Does not admit operators or start a UI.

Existing signed envelopes, replay databases and operation ACLs remain mandatory.
Lab HTTP stays loopback-only. No peer-supplied URL or redirects are followed.
"""
import io
import json
import socket
import ssl
import threading
import time
from http.server import ThreadingHTTPServer
from urllib.parse import urlsplit
from urllib.request import build_opener,ProxyHandler,HTTPSHandler
from .identity import MAX_BYTES,node_id
from .transport import Handler,NoRedirect,exchange


def endpoint_url(value):
    if not isinstance(value,str) or len(value)>2048 or any(ord(char)<33 for char in value):raise ValueError('configured_https_endpoint_required')
    parsed=urlsplit(value)
    if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ('','/') or parsed.query or parsed.fragment or '\\' in value or '%' in value:
        raise ValueError('configured_https_endpoint_required')
    if parsed.port is not None and not 1<=parsed.port<=65535:raise ValueError('configured_https_endpoint_required')
    return value.rstrip('/')


class ConfiguredHttpsTransport:
    def __init__(self,peers,*,context=None):
        self.peers={identity:endpoint_url(address) for identity,address in peers.items()}
        if any(not isinstance(identity,str) or len(identity)!=64 or any(c not in '0123456789abcdef' for c in identity) for identity in self.peers):raise ValueError('configured_peer_identity_required')
        context=context or ssl.create_default_context()
        if context.verify_mode!=ssl.CERT_REQUIRED or not context.check_hostname:raise ValueError('verified_tls_required')
        self.opener=build_opener(ProxyHandler({}),HTTPSHandler(context=context),NoRedirect())
    def validate(self,endpoint,recipient):
        if recipient not in self.peers or endpoint_url(endpoint)!=self.peers[recipient]:raise ValueError('unconfigured_mesh_endpoint')
    def route(self,endpoint,recipient,operation):
        self.validate(endpoint,recipient)
        return self.peers[recipient]+'/mesh/v1/'+operation,self.opener
    def exchange(self,key,verifier,recipient,operation,payload,*,committee=None):
        if recipient not in self.peers:raise ValueError('unconfigured_mesh_peer')
        return exchange(self.peers[recipient],key,verifier,recipient,operation,payload,committee=committee,_secure_transport=self)


class DiscoveredHttpsTransport(ConfiguredHttpsTransport):
    """Stable configured identities, fresh BFT-authorized addresses, verified TLS."""
    def __init__(self,peers,directory,roster,*,context=None):
        super().__init__(peers,context=context);self.directory=directory;self.roster=dict(roster)
        if directory.endpoint_policy!='https-v1':raise ValueError('genesis_https_discovery_policy_required')
    def route(self,endpoint,recipient,operation):
        self.validate(endpoint,recipient)
        from .discovery import discovered_peers
        snapshot=discovered_peers(self.directory,https_only=True);peer=snapshot['peers'].get(recipient)
        if peer is None or bytes.fromhex(peer['public_key'])!=self.roster.get(recipient):raise ValueError('fresh_pinned_discovery_peer_required')
        return endpoint_url(peer['endpoint'])+'/mesh/v1/'+operation,self.opener


class PublicHandler(Handler):
    def end_headers(self):
        self.send_header('X-Content-Type-Options','nosniff')
        super().end_headers()
    def do_GET(self):
        if self.path not in ('/healthz','/readyz'):self.send_error(404);return
        ready=False
        if self.path=='/readyz' and self.server.readiness is not None:
            try:ready=self.server.readiness() is True
            except Exception:pass
        raw=json.dumps({'live':True} if self.path=='/healthz' else {'ready':ready},separators=(',',':')).encode()
        self.send_response(200 if self.path=='/healthz' or ready else 503)
        self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    def do_POST(self):
        network_rpc=self.path=='/mesh/network/v1/rpc';point_enroll=self.path=='/mesh/network/v1/enroll'
        try:
            if any(char in self.path for char in ('?','%','\\','#')):raise ValueError('invalid_route')
            if point_enroll:
                if getattr(self.server,'point_enrollment',None) is None:self.send_error(404);return
            elif network_rpc:
                if getattr(self.server,'consensus_gateway',None) is None:self.send_error(404);return
            elif self.path.startswith('/mesh/v1/'):
                self.path='/mesh-lab/v1/'+self.path[len('/mesh/v1/'):]
            elif self.path.startswith('/mesh/auth/'):
                self.path='/mesh-lab/auth/'+self.path[len('/mesh/auth/'):]
            else:self.send_error(404);return
            lengths=self.headers.get_all('Content-Length',[])
            if len(lengths)!=1 or not lengths[0].isdecimal() or not 0<int(lengths[0])<=MAX_BYTES or self.headers.get('Transfer-Encoding'):
                raise ValueError('invalid_request_size')
            if self.headers.get_content_type()!='application/json':raise ValueError('json_required')
            raw=self.rfile.read(int(lengths[0]))
            if len(raw)!=int(lengths[0]):raise ValueError('truncated_request')
            def unique(pairs):
                value={}
                for key,item in pairs:
                    if key in value:raise ValueError('duplicate_json_field')
                    value[key]=item
                return value
            decoded=json.loads(raw,object_pairs_hook=unique,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('invalid_json_number')))
            def depth(value,level=0):
                if level>64:raise ValueError('request_depth')
                if isinstance(value,dict):
                    for child in value.values():depth(child,level+1)
                elif isinstance(value,list):
                    for child in value:depth(child,level+1)
            depth(decoded)
            if network_rpc or point_enroll:
                result=self.server.consensus_gateway.execute(decoded) if network_rpc else self.server.point_enrollment.enroll(decoded,self.client_address[0])
                payload=json.dumps(result,separators=(',',':')).encode()
                if len(payload)>2*1048576:raise ValueError('gateway_response_limit')
                self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(payload)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(payload);return
            original=self.rfile;self.rfile=io.BytesIO(raw)
        except (ValueError,TypeError,UnicodeError,RecursionError,socket.timeout):self.send_error(400);return
        try:super().do_POST()
        finally:self.rfile.close();self.rfile=original


class TLSMeshServer(ThreadingHTTPServer):
    daemon_threads=True
    request_queue_size=64
    def __init__(self,address,key,verifier,store,*,certificate,private_key,directory=None,auth=None,capacity_sampler=None,placement_signer=None,
                 failure_observer=None,capacity_assessor=None,manifest_queue=None,consensus_gateway=None,point_enrollment=None,readiness=None,max_connections=32):
        if not isinstance(address,tuple) or len(address)!=2 or not isinstance(address[0],str) or type(address[1]) is not int or not 0<=address[1]<=65535:raise ValueError('explicit_listener_required')
        if type(max_connections) is not int or not 1<=max_connections<=256:raise ValueError('connection_limit_required')
        if verifier.recipient!=node_id(key.public_key().public_bytes_raw()):raise ValueError('tls_server_identity_mismatch')
        if auth is not None and (auth.entry_node!=verifier.recipient or auth.network!=verifier.network or auth.directory is not directory):raise ValueError('auth_server_identity_mismatch')
        self.key,self.verifier,self.store=key,verifier,store;self.directory,self.auth=directory,auth
        self.capacity_sampler,self.placement_signer=capacity_sampler,placement_signer
        self.failure_observer,self.capacity_assessor=failure_observer,capacity_assessor;self.readiness=readiness
        self.manifest_queue=manifest_queue
        self.consensus_gateway=consensus_gateway
        self.point_enrollment=point_enrollment
        if manifest_queue is not None and (manifest_queue.verifier is not verifier or manifest_queue.directory is not directory):raise ValueError('manifest_queue_server_binding')
        self.context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);self.context.minimum_version=ssl.TLSVersion.TLSv1_2
        self.context.load_cert_chain(certificate,private_key)
        self.slots=threading.BoundedSemaphore(max_connections)
        self.max_connections=max_connections
        super().__init__(address,PublicHandler)
    def process_request(self,request,address):
        if not self.slots.acquire(blocking=False):request.close();return
        try:super().process_request(request,address)
        except BaseException:self.slots.release();request.close();raise
    def process_request_thread(self,request,address):
        try:
            request.settimeout(3)
            with self.context.wrap_socket(request,server_side=True) as secure:
                super().process_request_thread(secure,address)
        except (OSError,ssl.SSLError):request.close()
        finally:self.slots.release()
    def drain(self,timeout=30):
        """Call after shutdown: wait for active TLS workers before closing databases."""
        deadline=time.monotonic()+timeout;held=0
        try:
            for _ in range(self.max_connections):
                if not self.slots.acquire(timeout=max(0,deadline-time.monotonic())):raise TimeoutError('mesh_tls_workers_not_drained')
                held+=1
        finally:
            for _ in range(held):self.slots.release()
