import copy
from hashlib import sha256
from tempfile import TemporaryDirectory
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import unittest
from . import test_admission_registry
from .admission import application, approval
from .admission_rotation import rotation
from .admission_revocation import revocation
from .storage import canonical


class RotationTests(unittest.TestCase):
    setUp=test_admission_registry.AdmissionRegistryTests.setUp
    registry=test_admission_registry.AdmissionRegistryTests.registry
    def packet(self,registry):
        registry.accept(self.request,self.record,now=1002)
        head=registry.head(self.node,now=1003)
        key=Ed25519PrivateKey.generate()
        request=application(key,'lab','a'*64,'b'*64,self.request['body']['operator'],'e'*64,now=1003)
        approved=approval(request,'lab','a'*64,'b'*64,self.fixture.committee,self.fixture.keys[:3],now=1004)
        proof=rotation(head,request,approved,'lab','a'*64,'b'*64,self.fixture.committee,self.fixture.candidate,key,now=1004)
        revoked=revocation(head,'lab','a'*64,'b'*64,self.fixture.committee,self.fixture.keys[:3],sha256(canonical(proof)).hexdigest(),now=1004)
        return proof,request,approved,revoked

    def test_atomic_handover_reopen_replay_and_target_revoke(self):
        with TemporaryDirectory() as temp:
            path=temp+'/registry'; registry=self.registry(path); packet=self.packet(registry)
            self.assertTrue(registry.rotate(*packet,now=1005)['accepted']); registry.close()
            registry=self.registry(path)
            self.assertFalse(registry.rotate(*packet,now=2000)['accepted'])
            self.assertTrue(registry.head(self.node,now=1006)['revoked'])
            self.assertFalse(registry.accept(self.request,self.record,now=2000)['accepted'])
            target=packet[1]['body']['node_id']; head=registry.head(target,now=1006)
            self.assertTrue(head['document_live'])
            revoked=revocation(head,'lab','a'*64,'b'*64,self.fixture.committee,self.fixture.keys[:3],'f'*64,now=1006)
            registry.revoke(revoked,now=1007)
            self.assertTrue(registry.head(target,now=1008)['revoked'])
            registry._verify_rotations()
            registry.close()

    def test_bad_target_rolls_back_source_revocation(self):
        registry=self.registry(); self.addCleanup(registry.close); packet=list(self.packet(registry))
        packet[2]=copy.deepcopy(packet[2]); packet[2]['votes'].pop()
        with self.assertRaises(ValueError): registry.rotate(*packet,now=1005)
        self.assertFalse(registry.head(self.node,now=1005)['revoked'])
        self.assertIsNone(registry.head(packet[1]['body']['node_id'],now=1005))

    def test_missing_possession_or_wrong_revoke_cannot_rotate(self):
        for field in ('old_signature','new_signature'):
            registry=self.registry(); packet=list(self.packet(registry))
            packet[0]=copy.deepcopy(packet[0]); packet[0][field]='0'*128
            with self.assertRaises(ValueError): registry.rotate(*packet,now=1005)
            self.assertFalse(registry.head(self.node,now=1005)['revoked']); registry.close()

    def test_stale_head_after_revocation(self):
        registry=self.registry(); self.addCleanup(registry.close); packet=self.packet(registry)
        registry.revoke(packet[3],now=1005)
        with self.assertRaises(ValueError): registry.rotate(*packet,now=1006)
        self.assertIsNone(registry.head(packet[1]['body']['node_id'],now=1006))

    def test_persisted_link_tamper_detected(self):
        with TemporaryDirectory() as temp:
            path=temp+'/registry'; registry=self.registry(path); packet=self.packet(registry)
            registry.rotate(*packet,now=1005)
            with registry.db: registry.db.execute('UPDATE admission_rotations SET accepted_at=1006')
            registry.close()
            with self.assertRaises(ValueError): self.registry(path)

    def test_failure_after_source_write_rolls_back_entire_packet(self):
        from unittest.mock import patch
        registry=self.registry(); self.addCleanup(registry.close); packet=self.packet(registry)
        original=registry._accept
        def fail_target(request,record,now):
            if request['body']['node_id']!=self.node: raise ValueError('target_write_failed')
            return original(request,record,now)
        with patch.object(registry,'_accept',side_effect=fail_target):
            with self.assertRaisesRegex(ValueError,'target_write_failed'): registry.rotate(*packet,now=1005)
        self.assertFalse(registry.head(self.node,now=1005)['revoked'])
        self.assertEqual(registry.db.execute('SELECT COUNT(*) FROM admission_rotations').fetchone()[0],0)
        self.assertTrue(registry.rotate(*packet,now=1005)['accepted'])

    def test_concurrent_rotation_and_independent_revocation_have_one_winner(self):
        import threading
        with TemporaryDirectory() as temp:
            path=temp+'/registry'; first=self.registry(path); packet=self.packet(first); second=self.registry(path)
            head=first.head(self.node,now=1004)
            independent=revocation(head,'lab','a'*64,'b'*64,self.fixture.committee,self.fixture.keys[:3],'e'*64,now=1004)
            barrier=threading.Barrier(2); outcomes=[]
            def run(action):
                barrier.wait()
                try: action(); outcomes.append(True)
                except ValueError: outcomes.append(False)
            threads=[threading.Thread(target=run,args=(lambda:first.rotate(*packet,now=1005),)),threading.Thread(target=run,args=(lambda:second.revoke(independent,now=1005),))]
            for thread in threads: thread.start()
            for thread in threads: thread.join(timeout=10)
            self.assertEqual(sorted(outcomes),[False,True])
            self.assertTrue(first.head(self.node,now=1006)['revoked'])
            first.close(); second.close()
            reopened=self.registry(path); reopened.close()
