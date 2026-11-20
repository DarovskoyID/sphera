"""Public-name authority and deterministic cross-point account projection."""
import copy
from hashlib import sha256
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'django-server/sfera_server'))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sfera_mesh.application_profiles import verify_record, validate_profiles, check_progress, public_profiles, application_user_id
from sfera_mesh.storage import canonical


class ApplicationProfiles(unittest.TestCase):
    def setUp(self):
        self.key = Ed25519PrivateKey.generate()
        self.public = self.key.public_key().public_bytes_raw().hex()
        self.owner = sha256(b'sfera-mesh-user-v1\0' + bytes.fromhex(self.public)).hexdigest()
        self.genesis = 'a' * 64
        self.state = {'accounts': {self.owner: {'record': {'body': {'public_key': self.public}}}}}

    def record(self, *, version=1, previous='0'*64, handle='alice', epoch=0, key=None):
        b = {'domain':'sfera-mesh-application-profile-v1','network':'lab','genesis':self.genesis,
             'owner':self.owner,'control_epoch':epoch,'version':version,'previous':previous,
             'handle':handle,'nickname_utf8':'Алиса'.encode().hex()}
        r = {'body':b,'signature':(key or self.key).sign(canonical(b)).hex()}
        return {'record':r,'digest':sha256(canonical(r)).hexdigest()}

    def test_projection_and_durable_prefix(self):
        first = self.record();self.state['application_profiles'] = {self.owner:[first]}
        validate_profiles(self.state,'lab',self.genesis)
        expected = public_profiles(self.state,'lab',self.genesis)
        self.assertEqual(expected[0]['nickname'],'Алиса')
        self.assertEqual(expected[0]['id'],application_user_id('lab',self.owner))
        self.assertEqual(expected,public_profiles(copy.deepcopy(self.state),'lab',self.genesis))
        self.assertNotEqual(expected[0]['id'],application_user_id('other',self.owner))
        old = copy.deepcopy(self.state)
        self.state['application_profiles'][self.owner].append(self.record(version=2,previous=first['digest'],handle='alice_new'))
        validate_profiles(self.state,'lab',self.genesis);check_progress(old,self.state)
        with self.assertRaises(ValueError):check_progress(self.state,old)
        self.state['application_profiles'][self.owner][0]['digest']='0'*64
        with self.assertRaises(ValueError):validate_profiles(self.state,'lab',self.genesis)

    def test_signature_network_and_key_rotation(self):
        record = self.record()['record']
        for network, genesis in [('other',self.genesis),('lab','b'*64)]:
            with self.assertRaises(ValueError):verify_record(record,self.state,network,genesis)
        attacker = Ed25519PrivateKey.generate()
        with self.assertRaises(ValueError):verify_record(self.record(key=attacker)['record'],self.state,'lab',self.genesis)
        first=self.record();self.state['application_profiles']={self.owner:[first]}
        self.state['account_controls']={self.owner:[{'record':{'body':{'new_public':attacker.public_key().public_bytes_raw().hex()}}}]}
        second=self.record(version=2,previous=first['digest'],epoch=1,key=attacker)
        self.state['application_profiles'][self.owner].append(second)
        validate_profiles(self.state,'lab',self.genesis)
        with self.assertRaises(ValueError):verify_record(self.record(epoch=1)['record'],self.state,'lab',self.genesis)

    def test_collision_and_strict_schema(self):
        first=self.record();self.state['application_profiles']={self.owner:[first]}
        other='b'*64;self.state['accounts'][other]=copy.deepcopy(self.state['accounts'][self.owner])
        record=self.record()['record'];record['body']['owner']=other;record['signature']=self.key.sign(canonical(record['body'])).hex()
        self.state['application_profiles'][other]=[{'record':record,'digest':sha256(canonical(record)).hexdigest()}]
        with self.assertRaises(ValueError):validate_profiles(self.state,'lab',self.genesis)
        for handle in ('Alice','аlice','a b','a'):
            with self.assertRaises(ValueError):verify_record(self.record(handle=handle)['record'],self.state,'lab',self.genesis)
        record=self.record()['record'];record['body']['email']='never publish this'
        with self.assertRaises(ValueError):verify_record(record,self.state,'lab',self.genesis)


if __name__=='__main__':unittest.main()
