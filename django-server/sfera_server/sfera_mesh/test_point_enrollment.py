from datetime import datetime,timedelta,timezone
from hashlib import sha256
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ed25519,ec
from cryptography.x509.oid import NameOID
from .point_enrollment import PointEnrollment,enrollment_request
from .point_join import credential
from .storage import canonical


class PointEnrollmentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.path=Path(self.temp.name)/'issuer.sqlite'
        self.issuer=ed25519.Ed25519PrivateKey.generate();public=self.issuer.public_key().public_bytes_raw()
        self.directory=SimpleNamespace(network='test-network',pin='a'*64,license_issuers={sha256(public).hexdigest():public.hex()})
        self.ca_key=ec.generate_private_key(ec.SECP256R1());name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'test-network-ca')]);now=datetime.now(timezone.utc)
        self.ca=x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(self.ca_key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(days=1)).add_extension(x509.BasicConstraints(ca=True,path_length=None),critical=True).sign(self.ca_key,hashes.SHA256())
        self.service=PointEnrollment(self.path,self.directory,self.issuer,self.ca,self.ca_key,endpoint_scope='private');self.addCleanup(self.service.close)
        self.key=ed25519.Ed25519PrivateKey.generate()
    def request(self):return enrollment_request(self.key,self.directory.network,self.directory.pin,8443)

    def test_ordinary_admission_only_private_key_never_transmitted(self):
        request=self.request();result=self.service.enroll(request,'127.0.0.1');body=result['body']
        self.assertEqual(body['role'],'point');self.assertEqual(body['license']['claims']['modules'],[]);self.assertEqual(body['endpoint'],'https://127.0.0.1:8443')
        self.assertNotIn(self.key.private_bytes_raw().hex(),json.dumps(request)+json.dumps(result));self.assertNotIn('validator',json.dumps(result))
        self.issuer.public_key().verify(bytes.fromhex(result['signature']),canonical(body))

    def test_csr_key_proof_replay_and_public_scope(self):
        request=self.request();self.service.enroll(request,'127.0.0.1')
        with self.assertRaisesRegex(ValueError,'replayed'):self.service.enroll(request,'127.0.0.1')
        request=self.request();request['body']['port']=8444
        with self.assertRaisesRegex(ValueError,'signature'):self.service.enroll(request,'127.0.0.1')
        self.service.scope='public'
        with self.assertRaisesRegex(ValueError,'reachable'):self.service.enroll(self.request(),'127.0.0.1')

    def test_renewal_keeps_instance_and_trusted_client_verifies_reply(self):
        result=self.service.enroll(self.request(),'127.0.0.1');renewed=self.service.enroll(self.request(),'127.0.0.1')
        self.assertEqual(result['body']['license']['claims']['instance_id'],renewed['body']['license']['claims']['instance_id'])
        def respond(endpoint,path,request,**kwargs):return self.service.enroll(request,'127.0.0.1')
        with patch('sfera_mesh.point_join.post',side_effect=respond):body=credential(self.key,self.directory,'https://issuer.example',8443,self.ca)
        self.assertEqual(body['role'],'point')

    def test_issuer_context_change_and_self_assigned_authority_refused(self):
        fake=SimpleNamespace(**{**self.directory.__dict__,'pin':'b'*64})
        with self.assertRaisesRegex(ValueError,'context_changed'):PointEnrollment(self.path,fake,self.issuer,self.ca,self.ca_key,endpoint_scope='private')
        request=self.request();request['body']['role']='validator';request['signature']=self.key.sign(canonical(request['body'])).hex()
        with self.assertRaises(ValueError):self.service.enroll(request,'127.0.0.1')


if __name__=='__main__':unittest.main()
