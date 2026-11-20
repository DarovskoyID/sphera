"""Actual browser signatures, resumable registration, no premature session."""
import copy
from hashlib import sha256
import json
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'django-server/sfera_server'))
from sfera_mesh.application_registration import ApplicationRegistration
from sfera_mesh.storage import canonical


class Registration(unittest.TestCase):
    def setUp(self):
        self.fixture=json.loads(Path('output/mesh-application-20261119/registration-public-fixture.json').read_text(encoding='utf-8'))
        self.bundle=self.fixture['bundle'];self.sent=[]
        self.state={'accounts':{},'devices':{},'application_profiles':{},'height':1}
        self.directory=SimpleNamespace(network=self.fixture['network'],pin=self.fixture['genesis'],
          lock=threading.RLock(),current={'state':self.state},anchor=lambda:None)
        self.service=ApplicationRegistration(self.directory,self.sent.append)

    def commit(self,kind):
        value=self.bundle[kind];digest=sha256(canonical(value)).hexdigest();owner=self.bundle['account']['body']['user_id']
        if kind=='account':self.state['accounts'][owner]={'record':value,'digest':digest}
        elif kind=='profile':self.state['application_profiles'][owner]=[{'record':value,'digest':digest}]
        else:self.state['devices'][owner]=[{'event':value,'digest':digest}]

    def test_stages_exact_retry_and_only_confirmed_identity(self):
        for kind in ('account','profile','device'):
            before=canonical(self.state);result=self.service.publish(self.bundle)
            self.assertEqual(result['state'],'pending');self.assertEqual(result['stage'],kind)
            self.assertNotIn('application_user',result);self.assertEqual(canonical(self.state),before)
            self.assertEqual(self.service.publish(self.bundle),result)
            self.assertEqual(self.sent[-1],self.sent[-2]);self.commit(kind)
        confirmed=self.service.publish(self.bundle)
        self.assertEqual(confirmed['state'],'confirmed')
        self.assertEqual(confirmed['application_user'],self.fixture['application_user'])
        self.assertEqual(len(self.sent),6)

    def test_entire_bundle_is_verified_before_any_publication(self):
        invalid=copy.deepcopy(self.bundle);invalid['device']['device_signature']='0'*128
        with self.assertRaises(ValueError):self.service.publish(invalid)
        self.assertEqual(self.sent,[]);self.assertEqual(self.state['accounts'],{})
        invalid=copy.deepcopy(self.bundle);invalid['profile']['signature']='0'*128
        with self.assertRaises(ValueError):self.service.publish(invalid)
        self.assertEqual(self.sent,[])

    def test_reserved_handle_and_conflicting_committed_record(self):
        owner=self.bundle['account']['body']['user_id']
        self.state['application_profiles']['f'*64]=[{'record':self.bundle['profile']}]
        with self.assertRaisesRegex(ValueError,'handle_reserved'):self.service.publish(self.bundle)
        self.state['application_profiles'].clear();self.commit('account')
        self.state['accounts'][owner]['digest']='f'*64
        with self.assertRaisesRegex(ValueError,'account_conflict'):self.service.publish(self.bundle)
        self.assertEqual(self.sent,[])


if __name__=='__main__':unittest.main()
