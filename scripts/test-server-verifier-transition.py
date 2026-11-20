"""Ephemeral signing keys; real stopped-state locks on Linux only."""
import copy
import hashlib
import os
from pathlib import Path
import runpy
import sys
import time
import unittest
from unittest.mock import patch
from release_v1 import sign,canonical,public_text,key_id
from server_verifier_transition import contract,migrate
from server_update import read_json
from server_state import point_lock

ReleaseFixture=runpy.run_path(str(Path(__file__).with_name('test-server-release.py')))['ServerReleaseTests']
UpdateFixture=runpy.run_path(str(Path(__file__).with_name('test-server-update.py')))['UpdateTests']


class ContractTests(unittest.TestCase):
    setUpClass=classmethod(ReleaseFixture.setUpClass.__func__)
    def packet(self,**changes):
        now=int(time.time());public=public_text(self.signer.public_key())
        cert=sign({'domain':'sphere-release-delegation-v1','product':'sphere','channel':'stable','key_id':key_id(public),
                   'public_key':public,'roles':['release'],'not_before':now-5,'expires_at':now+3600},self.root)
        body={'domain':'sphere-point-verifier-transition-v1','product':'sphere','channel':'stable','issued_at':now,
              'expires_at':now+1800,'network':'lab','genesis':'a'*64,'from_verifier':'b'*64,'to_verifier':'c'*64,'release_sequence':9,**changes}
        return {'certificate':cert,'document':sign(body,self.signer)}
    def test_signature_expiry_exact_schema_and_noop(self):
        trust={'root_public_key':public_text(self.root.public_key()),'channel':'stable','minimum_sequence':1}
        self.assertEqual(contract(self.packet(),trust)['release_sequence'],9)
        for changes in ({'expires_at':int(time.time())-1},{'to_verifier':'b'*64},{'allow_reset':True},{'release_sequence':True},{'genesis':'?'*64}):
            with self.assertRaises(ValueError):contract(self.packet(**changes),trust)
        bad=self.packet();bad['document']['signature']='A'*512
        with self.assertRaises(ValueError):contract(bad,trust)


@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0,'Root-owned Linux stopped-point handoff')
class HandoffTests(unittest.TestCase):
    setUpClass=classmethod(ReleaseFixture.setUpClass.__func__)
    setUp=UpdateFixture.setUp
    bundle=ReleaseFixture.bundle
    release=UpdateFixture.release
    controller=UpdateFixture.controller
    packet=ContractTests.packet

    def prepare_handoff(self):
        value=read_json(self.config);old=Path(value['verifier_binary']).read_bytes()
        value['verifier_sha256']=hashlib.sha256(old).hexdigest();self.config.write_bytes(canonical(value))
        deployment=self.release(9)
        with self.controller() as supervisor:supervisor.start(deployment)
        # The disposable CHILD doesn't use the real runtime's lifetime lock.
        # An installed point already has this file; make the fixture equivalent.
        with point_lock(self.base/'point-state'):pass
        new=b'new independent verifier fixture';digest=hashlib.sha256(new).hexdigest()
        target=self.base/'verifiers'/digest/'mesh-verifier';target.parent.mkdir(parents=True);target.write_bytes(new);target.chmod(0o750)
        receipts=self.base/'verifier-receipts';receipts.mkdir(mode=0o700)
        packet=self.packet(network=value['network'],genesis=value['genesis_sha256'],from_verifier=value['verifier_sha256'],to_verifier=digest)
        return target,receipts,packet,value,old

    def test_preserves_data_floor_and_restarts_with_new_binding(self):
        target,receipts,packet,value,old=self.prepare_handoff()
        before={p.name:p.read_bytes() for p in (self.base/'point-state').iterdir()}
        result=migrate(self.config,self.operations,self.trust,packet,target,receipts)
        self.assertEqual(result['release_floor'],9);self.assertFalse(result['point_data_changed'])
        self.assertEqual(Path(value['verifier_binary']).read_bytes(),old)
        self.assertEqual({p.name:p.read_bytes() for p in (self.base/'point-state').iterdir()},before)
        self.assertEqual(migrate(self.config,self.operations,self.trust,packet,target,receipts),result)
        with self.controller() as supervisor:
            self.assertEqual(supervisor.start(read_json(self.operations/'update.json')['active']['deployment'])['floor'],9)
            with self.assertRaisesRegex(ValueError,'in_use'):migrate(self.config,self.operations,self.trust,packet,target,receipts)

    def test_interrupted_pair_write_resumes_exact_contract(self):
        import server_verifier_transition as module
        target,receipts,packet,_,_=self.prepare_handoff();original=module.replace_private
        def fail_journal(path,raw,owner):
            if Path(path)==self.operations/'update.json':raise OSError('injected interruption')
            return original(path,raw,owner)
        with patch.object(module,'replace_private',side_effect=fail_journal):
            with self.assertRaises(OSError):migrate(self.config,self.operations,self.trust,packet,target,receipts)
        result=migrate(self.config,self.operations,self.trust,packet,target,receipts)
        self.assertEqual(result['release_floor'],9)
        with self.controller() as supervisor:supervisor.start(read_json(self.operations/'update.json')['active']['deployment'])

    def test_wrong_artifact_cannot_change_config_or_journal(self):
        target,receipts,packet,_,_=self.prepare_handoff()
        before=(self.config.read_bytes(),(self.operations/'update.json').read_bytes())
        target.write_bytes(b'corrupted artifact')
        with self.assertRaisesRegex(ValueError,'signed_verifier'):migrate(self.config,self.operations,self.trust,packet,target,receipts)
        self.assertEqual((self.config.read_bytes(),(self.operations/'update.json').read_bytes()),before)


if __name__=='__main__':unittest.main()
