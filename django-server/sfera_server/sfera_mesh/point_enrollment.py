"""Automatic ordinary-point admission. Never grants validator/assessor authority."""
from datetime import datetime,timedelta,timezone
from hashlib import sha256
import ipaddress
import json
import secrets
import sqlite3
import threading
import time
import uuid
from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.x509.oid import NameOID
from .identity import node_id
from .storage import canonical


def enrollment_request(key,network,genesis_pin,port,*,now=None):
    csr=x509.CertificateSigningRequestBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,node_id(key.public_key().public_bytes_raw()))])).sign(key,None)
    body={'domain':'sphere-point-enroll-v1','network':network,'genesis_sha256':genesis_pin,'public_key':key.public_key().public_bytes_raw().hex(),
        'port':port,'nonce':secrets.token_hex(24),'timestamp':int(time.time()) if now is None else now,'csr':csr.public_bytes(serialization.Encoding.PEM).decode('ascii')}
    return {'body':body,'signature':key.sign(canonical(body)).hex()}


class PointEnrollment:
    def __init__(self,path,directory,issuer_key,ca_certificate,ca_key,*,endpoint_scope='public'):
        public=issuer_key.public_key().public_bytes_raw();issuer=sha256(public).hexdigest()
        if directory.license_issuers.get(issuer)!=public.hex() or endpoint_scope not in ('public','private'):raise ValueError('approved_point_enrollment_issuer_required')
        if ca_certificate.public_key().public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)!=ca_key.public_key().public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo):raise ValueError('network_ca_key_mismatch')
        if not ca_certificate.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:raise ValueError('network_ca_certificate_required')
        self.directory,self.issuer_key,self.issuer,self.ca,self.ca_key,self.scope=directory,issuer_key,issuer,ca_certificate,ca_key,endpoint_scope
        self.lock=threading.RLock();self.db=sqlite3.connect(path,check_same_thread=False);self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''CREATE TABLE IF NOT EXISTS point_enrollment_pin(id INTEGER PRIMARY KEY,context BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS point_enrollment_nodes(node TEXT PRIMARY KEY,instance TEXT UNIQUE NOT NULL,ip TEXT NOT NULL,created INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS point_enrollment_nonces(nonce TEXT PRIMARY KEY,node TEXT NOT NULL,expires INTEGER NOT NULL);''')
        context=canonical({'genesis':directory.pin,'issuer':issuer,'ca':ca_certificate.fingerprint(hashes.SHA256()).hex(),'scope':endpoint_scope})
        try:
            with self.db:
                old=self.db.execute('SELECT context FROM point_enrollment_pin WHERE id=1').fetchone()
                if old and old[0]!=context:raise ValueError('point_enrollment_context_changed')
                self.db.execute('INSERT OR IGNORE INTO point_enrollment_pin VALUES(1,?)',(context,))
        except BaseException:self.db.close();raise

    def close(self):self.db.close()

    def enroll(self,value,observed_ip):
        if not isinstance(value,dict) or set(value)!={'body','signature'} or len(canonical(value))>8192:raise ValueError('bounded_point_enrollment_required')
        body=value['body'];now=int(time.time())
        if (not isinstance(body,dict) or set(body)!={'domain','network','genesis_sha256','public_key','port','nonce','timestamp','csr'}
                or body['domain']!='sphere-point-enroll-v1' or body['network']!=self.directory.network or body['genesis_sha256']!=self.directory.pin
                or type(body['timestamp']) is not int or abs(now-body['timestamp'])>30 or type(body['port']) is not int or not 1024<=body['port']<=65535
                or not isinstance(body['nonce'],str) or len(body['nonce'])!=48 or bytes.fromhex(body['nonce']).hex()!=body['nonce']):raise ValueError('point_enrollment_context')
        public=bytes.fromhex(body['public_key']);identity=node_id(public);key=Ed25519PublicKey.from_public_bytes(public)
        try:key.verify(bytes.fromhex(value['signature']),canonical(body))
        except Exception:raise ValueError('point_enrollment_signature') from None
        csr=x509.load_pem_x509_csr(body['csr'].encode('ascii'))
        if not csr.is_signature_valid or csr.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw)!=public:raise ValueError('point_enrollment_csr_key')
        address=ipaddress.ip_address(observed_ip)
        if address.version!=4 or self.scope=='public' and not address.is_global:raise ValueError('reachable_point_ipv4_required')
        # The remote socket address is authoritative; no caller-supplied host,
        # forwarding header or arbitrary URL is used for certificate issuance.
        with self.lock,self.db:
            self.db.execute('BEGIN IMMEDIATE');self.db.execute('DELETE FROM point_enrollment_nonces WHERE expires<?',(now,))
            if self.db.execute('SELECT 1 FROM point_enrollment_nonces WHERE nonce=?',(body['nonce'],)).fetchone():raise ValueError('replayed_point_enrollment')
            if self.db.execute('SELECT COUNT(*) FROM point_enrollment_nonces WHERE node=?',(identity,)).fetchone()[0]>=4:raise ValueError('point_enrollment_retry_later')
            old=self.db.execute('SELECT instance FROM point_enrollment_nodes WHERE node=?',(identity,)).fetchone()
            if not old:
                if self.db.execute('SELECT COUNT(*) FROM point_enrollment_nodes').fetchone()[0]>=128:raise ValueError('point_network_capacity_reached')
                if self.db.execute('SELECT COUNT(*) FROM point_enrollment_nodes WHERE ip=? AND created>?',(str(address),now-3600)).fetchone()[0]>=5:raise ValueError('point_registration_rate_limit')
                instance=str(uuid.uuid4());self.db.execute('INSERT INTO point_enrollment_nodes VALUES(?,?,?,?)',(identity,instance,str(address),now))
            else:instance=old[0]
            self.db.execute('INSERT INTO point_enrollment_nonces VALUES(?,?,?)',(body['nonce'],identity,now+60))
        claims={'schema':'sfera-mesh-license-v1','issuer':self.issuer,'instance_id':instance,'node_id':identity,'network':self.directory.network,
            'issued_at':now-1,'expires_at':now+290,'modules':[]}
        license={'claims':claims,'signature':self.issuer_key.sign(canonical(claims)).hex()}
        instant=datetime.now(timezone.utc);deadline=min(instant+timedelta(hours=1),self.ca.not_valid_after_utc)
        if deadline<=instant+timedelta(minutes=5):raise ValueError('network_ca_renewal_required')
        certificate=x509.CertificateBuilder().subject_name(csr.subject).issuer_name(self.ca.subject).public_key(key).serial_number(x509.random_serial_number()).not_valid_before(instant-timedelta(minutes=1)).not_valid_after(deadline).add_extension(x509.SubjectAlternativeName([x509.IPAddress(address)]),critical=False).add_extension(x509.BasicConstraints(ca=False,path_length=None),critical=True).sign(self.ca_key,None if isinstance(self.ca_key.public_key(),Ed25519PublicKey) else hashes.SHA256())
        result={'domain':'sphere-point-enrollment-v1','network':self.directory.network,'genesis_sha256':self.directory.pin,'request_nonce':body['nonce'],
            'node_id':identity,'endpoint':f'https://{address}:{body["port"]}','license':license,'certificate':certificate.public_bytes(serialization.Encoding.PEM).decode('ascii'),
            'role':'point','expires_at':claims['expires_at']}
        return {'body':result,'signature':self.issuer_key.sign(canonical(result)).hex(),'issuer':self.issuer}
