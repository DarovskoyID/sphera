"""Cross-language public-key journal fixtures and fail-closed reader tests."""
import base64
import copy
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'django-server/sfera_server'))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sfera_mesh.application_keys import record,perform,replay,check_progress,ApplicationKeyCatalog
from sfera_mesh.storage import canonical


def fixture(fallback=False):
    spec=importlib.util.spec_from_file_location('scope_fixture',Path(__file__).with_name('test-mesh-distributed-cipher-scope.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    test=module.DistributedScope();test.setUp()
    try:
        state=copy.deepcopy(test.directory.current['state']);network='lab';genesis=test.directory.pin
        keys=[]
        for person in test.people:
            key=Ed25519PrivateKey.generate();keys.append(key)
            certificate=state['cipher_devices'][person['owner']+':'+person['did']]['certificate']
            certificate['body']['ed25519']=base64.b64encode(key.public_key().public_bytes_raw()).decode().rstrip('=')
            certificate['signature']=person['device'].sign(canonical(certificate['body'])).hex()
        def command(index,request,kind,docs=None):
            actor=test.people[index];peer=test.people[1-index]
            body={'domain':'sfera-mesh-application-key-v1','network':network,'genesis':genesis,
                  'owner':actor['owner'],'device':actor['did'],'devices_version':1,'request':request,'kind':kind,
                  'dialog':test.dialog if kind=='claim' else '',
                  'target_owner':peer['owner'] if kind=='claim' else '',
                  'target_device':peer['did'] if kind=='claim' else '',
                  'keys_utf8':canonical(docs).hex() if docs is not None else ''}
            return {'body':body,'signature':base64.b64encode(keys[index].sign(canonical(body))).decode().rstrip('=')}
        actor=test.people[1];user='@'+actor['owner']+':'+genesis+'.sphere'
        doc={'key':base64.b64encode(Ed25519PrivateKey.generate().public_key().public_bytes_raw()).decode().rstrip('=')}
        doc['signatures']={user:{'ed25519:'+actor['did']:base64.b64encode(keys[1].sign(canonical(doc))).decode().rstrip('=')}}
        upload=command(1,'upload-1','upload',{'signed_curve25519:one':doc})
        commands=[upload,command(0,'claim-1','claim'),command(0,'claim-2','claim'),command(1,'upload-2','upload',{'signed_curve25519:one':doc}),command(0,'claim-3','claim')]
        if fallback:
            def fallback_doc():
                value={'key':base64.b64encode(Ed25519PrivateKey.generate().public_key().public_bytes_raw()).decode().rstrip('='),'fallback':True}
                value['signatures']={user:{'ed25519:'+actor['did']:base64.b64encode(keys[1].sign(canonical(value))).decode().rstrip('=')}}
                return value
            first=command(1,'fallback-1','fallback',{'signed_curve25519:aaa':fallback_doc()})
            second=command(1,'fallback-2','fallback',{'signed_curve25519:bbb':fallback_doc()})
            commands=[first,upload,command(0,'claim-1','claim'),command(0,'claim-2','claim'),command(0,'claim-3','claim'),second,command(0,'claim-4','claim')]
        initial=copy.deepcopy(state);pool={};state['application_keys']=[]
        for value in commands:
            record(value,state,network,genesis,current=True)
            identity,document=perform(value,state,pool,genesis)
            state['application_keys'].append({'record':value,'digest':sha256(canonical(value)).hexdigest(),'key_id':identity,'key_utf8':document})
        return {'network':network,'genesis':genesis,'initial_state':initial,'state':state,'commands':commands,
                'alias':command(1,'alias','upload',{'signed_curve25519:alias':doc})}
    finally:test.doCleanups()


class Keys(unittest.TestCase):
    def setUp(self):self.f=fixture()
    def test_fallback_priority_reuse_rotation_and_retirement(self):
        f=fixture(True);pool=replay(f['state'],f['network'],f['genesis'])
        self.assertEqual([r['key_id'] for r in f['state']['application_keys']],['','','signed_curve25519:one','signed_curve25519:aaa','signed_curve25519:aaa','','signed_curve25519:bbb'])
        with self.assertRaisesRegex(ValueError,'immutable'):perform(f['commands'][0],f['state'],pool,f['genesis'])

    def test_exactly_once_and_reupload_cannot_resurrect_key(self):
        f=self.f;pool=replay(f['state'],f['network'],f['genesis'])
        receipts=f['state']['application_keys']
        self.assertEqual([item['key_id'] for item in receipts],['','signed_curve25519:one','','',''])
        self.assertTrue(next(iter(next(iter(pool.values())).values()))['consumed'])
    def test_alias_forged_receipt_and_prefix_rollback(self):
        f=self.f;pool=replay(f['state'],f['network'],f['genesis'])
        with self.assertRaisesRegex(ValueError,'alias'):perform(f['alias'],f['state'],pool,f['genesis'])
        corrupt=copy.deepcopy(f['state']);corrupt['application_keys'][2]['key_id']='signed_curve25519:one'
        with self.assertRaisesRegex(ValueError,'receipt_result'):replay(corrupt,f['network'],f['genesis'])
        with self.assertRaisesRegex(ValueError,'rollback_or_fork'):check_progress(f['state'],f['initial_state'])
    def test_forged_signature_and_revoked_device(self):
        f=self.f;value=copy.deepcopy(f['commands'][0]);value['signature']='A'*86
        with self.assertRaises(Exception):record(value,f['state'],f['network'],f['genesis'],current=True)
        value=f['commands'][0];state=copy.deepcopy(f['state'])
        state['devices'][value['body']['owner']][0]['event']['body']['operation']='revoke'
        with self.assertRaisesRegex(ValueError,'not_admitted'):record(value,state,f['network'],f['genesis'],current=True)

    def test_catalog_does_not_turn_pending_claim_into_a_key(self):
        f=self.f;sent=[]
        directory=SimpleNamespace(network=f['network'],pin=f['genesis'],lock=threading.RLock(),
                                  current={'state':copy.deepcopy(f['initial_state'])},anchor=lambda:None)
        catalog=ApplicationKeyCatalog(directory,sent.append);upload=f['commands'][0]
        pending=catalog.publish(upload)
        self.assertEqual(pending['state'],'pending');self.assertNotIn('receipt',pending)
        self.assertNotIn('application_keys',directory.current['state'])
        directory.current['state']['application_keys']=copy.deepcopy(f['state']['application_keys'][:1])
        self.assertEqual(catalog.publish(upload)['state'],'confirmed');self.assertEqual(len(sent),1)
        claim=f['commands'][1];pending=catalog.publish(claim)
        self.assertEqual(pending['state'],'pending');self.assertNotIn('receipt',pending)
        self.assertEqual(len(directory.current['state']['application_keys']),1)
        directory.current['state']=copy.deepcopy(f['state'])
        confirmed=catalog.publish(claim)
        self.assertEqual(confirmed['receipt']['key_id'],'signed_curve25519:one')
        self.assertEqual(catalog.publish(claim),confirmed);self.assertEqual(len(sent),2)


if __name__=='__main__':
    if '--write-fixture' in sys.argv:
        Path('mesh-consensus/testdata/application-keys-v1.json').write_bytes(canonical(fixture())+b'\n')
        Path('mesh-consensus/testdata/application-fallback-v1.json').write_bytes(canonical(fixture(True))+b'\n')
        sys.argv.remove('--write-fixture')
    unittest.main()
