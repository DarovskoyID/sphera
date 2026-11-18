import copy
import json
from tempfile import TemporaryDirectory
import threading
import unittest
from . import test_admission
from .admission import application,approval
from .admission_registry import AdmissionRegistry


class AdmissionRegistryTests(unittest.TestCase):
    def setUp(self):
        self.fixture=test_admission.AdmissionTests(); self.fixture.setUp()
        self.request=self.fixture.request; self.record=self.fixture.issue()
        self.node=self.request['body']['node_id']

    def registry(self,path=':memory:',**overrides):
        return AdmissionRegistry(path,'lab','a'*64,overrides.get('policy','b'*64),self.fixture.committee)

    def next_record(self,previous,*,operator='c'*64,version=2):
        request=application(self.fixture.candidate,'lab','a'*64,'b'*64,operator,'e'*64,now=1003)
        record=approval(request,'lab','a'*64,'b'*64,self.fixture.committee,self.fixture.keys[:3],now=1004,version=version,previous=previous)
        return request,record

    def test_reopen_preserves_history_and_expired_retry_does_not_extend_life(self):
        with TemporaryDirectory() as temp:
            path=temp+'/admission.sqlite'; registry=self.registry(path)
            digest=registry.accept(self.request,self.record,now=1002)['digest']; registry.close()
            registry=self.registry(path)
            try:
                self.assertFalse(registry.accept(self.request,self.record,now=2000)['accepted'])
                self.assertFalse(registry.head(self.node,now=2000)['document_live'])
                self.assertEqual(registry.head(self.node,now=2000)['digest'],digest)
                exported=registry.history(self.node); exported[0]['approval']['body']['version']=99
                self.assertEqual(registry.head(self.node,now=1005)['approval']['body']['version'],1)
            finally: registry.close()
            with self.assertRaisesRegex(ValueError,'context_changed'): self.registry(path,policy='f'*64)

    def test_chain_rejects_validly_signed_fork_and_operator_reassignment(self):
        registry=self.registry(); self.addCleanup(registry.close)
        digest=registry.accept(self.request,self.record,now=1002)['digest']
        request,record=self.next_record(digest)
        second=registry.accept(request,record,now=1005)['digest']
        with self.assertRaisesRegex(ValueError,'identity_or_time'):
            registry.accept(*self.next_record(second,operator='d'*64,version=3),now=1006)
        fork=copy.deepcopy(self.record); fork['votes'].reverse()
        with self.assertRaisesRegex(ValueError,'version_conflict'): registry.accept(self.request,fork,now=1006)
        self.assertEqual(len(registry.history(self.node)),2)

    def test_invalid_quorum_leaves_no_partial_record(self):
        registry=self.registry(); self.addCleanup(registry.close)
        bad=copy.deepcopy(self.record); bad['votes'].pop()
        with self.assertRaises(ValueError): registry.accept(self.request,bad,now=1002)
        self.assertIsNone(registry.head(self.node,now=1002))

    def test_tampered_persisted_signature_fails_reopen(self):
        with TemporaryDirectory() as temp:
            path=temp+'/admission.sqlite'; registry=self.registry(path)
            registry.accept(self.request,self.record,now=1002)
            bad=copy.deepcopy(self.record); bad['votes'][0]['signature']='0'*128
            with registry.db: registry.db.execute('UPDATE admission_history SET approval=?',(json.dumps(bad).encode(),))
            registry.close()
            with self.assertRaises(ValueError): self.registry(path)

    def test_concurrent_conflicting_versions_cannot_both_commit(self):
        with TemporaryDirectory() as temp:
            path=temp+'/admission.sqlite'; registries=[self.registry(path),self.registry(path)]
            other=approval(self.request,'lab','a'*64,'b'*64,self.fixture.committee,self.fixture.keys[1:],now=1001)
            barrier=threading.Barrier(2); results=[]
            def accept(registry,record):
                barrier.wait()
                try: registry.accept(self.request,record,now=1002); results.append('accepted')
                except ValueError: results.append('conflict')
            threads=[threading.Thread(target=accept,args=(registry,record)) for registry,record in zip(registries,(self.record,other))]
            try:
                for thread in threads: thread.start()
                for thread in threads: thread.join(5)
                self.assertTrue(all(not thread.is_alive() for thread in threads))
                self.assertEqual(sorted(results),['accepted','conflict'])
                self.assertEqual(len(registries[0].history(self.node)),1)
            finally:
                for registry in registries: registry.close()
