"""Real TLS sockets, temporary CA/identities and databases; no trust-store changes."""
from datetime import datetime,timedelta,timezone
import http.client
from pathlib import Path
import ssl
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa,ed25519
from cryptography.x509.oid import NameOID
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'django-server'/'sfera_server'))
from sfera_mesh.identity import EnvelopeVerifier,node_id,envelope
from sfera_mesh.storage import canonical
from sfera_mesh.transport import BlobStore,exchange
from sfera_mesh.public_transport import TLSMeshServer,ConfiguredHttpsTransport,PublicHandler


class PublicTransportTests(unittest.TestCase):
    def test_https_timeout_is_bounded_and_preserves_verification(self):
        import time
        from unittest.mock import patch
        from urllib.error import URLError
        for invalid in (0,11,True,1.5,float('inf')):
            with self.assertRaises(ValueError):ConfiguredHttpsTransport({self.ids[0]:self.endpoint},context=self.context,timeout_seconds=invalid)
        original=self.store.execute
        def delayed(operation,payload):
            if operation=='get':time.sleep(1.3)
            return original(operation,payload)
        short=ConfiguredHttpsTransport({self.ids[0]:self.endpoint},context=self.context,timeout_seconds=1)
        longer=ConfiguredHttpsTransport({self.ids[0]:self.endpoint},context=self.context,timeout_seconds=2)
        import hashlib
        raw=b'bounded real TLS test';digest=hashlib.sha256(raw).hexdigest();self.store.execute('put',{'digest':digest,'ciphertext':raw.hex()})
        with patch.object(self.store,'execute',side_effect=delayed):
            with self.assertRaises((TimeoutError,URLError)):short.exchange(self.keys[1],self.checks[1],self.ids[0],'get',{'digest':digest})
            result=longer.exchange(self.keys[1],self.checks[1],self.ids[0],'get',{'digest':digest})
        self.assertEqual(result['ciphertext'],raw.hex())

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name)
        key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        subject=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'temporary localhost fixture')]);now=datetime.now(timezone.utc)
        cert=(x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(hours=1))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]),critical=False)
            .add_extension(x509.BasicConstraints(ca=True,path_length=0),critical=True).sign(key,hashes.SHA256()))
        cert_path=self.base/'temporary-ca.pem';private=self.base/'temporary-tls.pem'
        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM));private.write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
        self.context=ssl.create_default_context(cafile=str(cert_path))
        self.keys=[ed25519.Ed25519PrivateKey.generate() for _ in range(2)]
        self.ids=[node_id(key.public_key().public_bytes_raw()) for key in self.keys]
        roster={identity:key.public_key().public_bytes_raw() for identity,key in zip(self.ids,self.keys)}
        self.checks=[EnvelopeVerifier('tls-fixture',identity,roster,str(self.base/f'replay-{i}.sqlite')) for i,identity in enumerate(self.ids)]
        self.store=BlobStore(str(self.base/'blobs.sqlite'),max_bytes=1024*1024)
        self.server=TLSMeshServer(('127.0.0.1',0),self.keys[0],self.checks[0],self.store,certificate=str(cert_path),private_key=str(private))
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.endpoint=f'https://localhost:{self.server.server_port}'
        self.client=ConfiguredHttpsTransport({self.ids[0]:self.endpoint},context=self.context)
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join(timeout=5)
        self.server.drain(timeout=5)
        for check in self.checks:check.close()
        self.store.close();self.temp.cleanup()
    def request(self,path,raw=None,headers=None):
        connection=http.client.HTTPSConnection('localhost',self.server.server_port,context=self.context,timeout=5)
        try:
            connection.request('GET' if raw is None else 'POST',path,raw,headers or {'Content-Type':'application/json'})
            response=connection.getresponse();return response.status,response.read()
        finally:connection.close()
    def test_signed_exchange_over_real_tls(self):
        result=self.client.exchange(self.keys[1],self.checks[1],self.ids[0],'probe',{'challenge':'a'*64})
        self.assertEqual(result,{'challenge':'a'*64,'alive':True})
        self.assertEqual(self.request('/healthz')[0],200);self.assertEqual(self.request('/readyz')[0],503)
        self.assertEqual(self.request('/')[0],404)
        self.checks[1].secure_transport=self.client
        self.assertEqual(exchange(self.endpoint,self.keys[1],self.checks[1],self.ids[0],'probe',{'challenge':'c'*64}),{'challenge':'c'*64,'alive':True})

    def test_ready_monitor_binds_endpoint_to_the_expected_point_key(self):
        from server_monitor import check
        self.server.readiness=lambda:True
        self.assertTrue(check(self.endpoint,context=self.context,key=self.keys[0],network='tls-fixture')['ready'])
        self.assertFalse(check(self.endpoint,context=self.context,key=self.keys[1],network='tls-fixture')['ready'])
        self.assertFalse(check(self.endpoint,context=self.context,key=self.keys[0],network='other-network')['ready'])
    def test_unsigned_replay_and_duplicate_fields_rejected(self):
        self.assertEqual(self.request('/mesh/v1/probe',b'{}')[0],400)
        packet=canonical(envelope(self.keys[1],'tls-fixture',self.ids[0],'probe',{'challenge':'b'*64}))
        self.assertEqual(self.request('/mesh/v1/probe',packet)[0],200)
        self.assertEqual(self.request('/mesh/v1/probe',packet)[0],400)
        self.assertEqual(self.request('/mesh/v1/probe',b'{"record":{},"record":{}}')[0],400)
        self.assertEqual(self.request('/mesh-lab/v1/probe',packet)[0],404)
        self.assertEqual(self.request('/mesh/v1/probe?other=1',packet)[0],400)
    def test_no_tls_bypass_and_no_unconfigured_peer(self):
        with self.assertRaises(Exception):ConfiguredHttpsTransport({self.ids[0]:self.endpoint},context=ssl._create_unverified_context())
        with self.assertRaises(ValueError):ConfiguredHttpsTransport({self.ids[0]:'http://localhost:80'})
        with self.assertRaises(ValueError):self.client.route('https://other.example',self.ids[0],'probe')
        with self.assertRaises(ValueError):self.client.exchange(self.keys[1],self.checks[1],'c'*64,'probe',{})
        with self.assertRaises(ValueError):exchange(self.endpoint,self.keys[1],self.checks[1],self.ids[0],'probe',{})
        untrusted=ConfiguredHttpsTransport({self.ids[0]:self.endpoint})
        with self.assertRaises(Exception):untrusted.exchange(self.keys[1],self.checks[1],self.ids[0],'probe',{'challenge':'a'*64})
    def test_redirect_is_not_followed(self):
        class Redirect(PublicHandler):
            def do_POST(self):self.send_response(302);self.send_header('Location','https://attacker.invalid/');self.end_headers()
        self.server.RequestHandlerClass=Redirect
        with self.assertRaises(HTTPError) as error:self.client.exchange(self.keys[1],self.checks[1],self.ids[0],'probe',{'challenge':'a'*64})
        self.assertEqual(error.exception.code,302)
        error.exception.close()


if __name__=='__main__':unittest.main()
