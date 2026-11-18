import copy
from tempfile import TemporaryDirectory
import unittest
from . import test_admission
from .admission import application,approval
from .admission_registry import AdmissionRegistry
from .admission_revocation import revocation


class AdmissionRevocationTests(unittest.TestCase):
    def test_terminal_revocation_has_room_after_ordinary_version_limit(self):
        registry=self.registry(); self.addCleanup(registry.close)
        head=self.prepare(registry)
        for version in range(2,33):
            record=approval(self.fixture.request,'lab','a'*64,'b'*64,self.fixture.committee,self.fixture.keys[:3],now=1000+version,version=version,previous=head['digest'])
            registry.accept(self.fixture.request,record,now=1001+version)
            head=registry.head(self.node,now=1001+version)
        extra=approval(self.fixture.request,'lab','a'*64,'b'*64,self.fixture.committee,self.fixture.keys[:3],now=1100,version=33,previous=head['digest'])
        with self.assertRaisesRegex(ValueError,'limit'): registry.accept(self.fixture.request,extra,now=1101)
        registry.revoke(self.revoke_record(head,now=1100),now=1101)
        self.assertTrue(registry.head(self.node,now=1102)['revoked'])
        self.assertEqual(len(registry.history(self.node)),33)
        registry._verify_history()

    def setUp(self):
        self.fixture=test_admission.AdmissionTests(); self.fixture.setUp()
        self.node=self.fixture.request['body']['node_id']

    def registry(self,path=':memory:'):
        return AdmissionRegistry(path,'lab','a'*64,'b'*64,self.fixture.committee)

    def prepare(self,registry):
        registry.accept(self.fixture.request,self.fixture.issue(),now=1002)
        return registry.head(self.node,now=1002)

    def revoke_record(self,head,keys=None,**kwargs):
        return revocation(head,'lab','a'*64,'b'*64,self.fixture.committee,self.fixture.keys[:3] if keys is None else keys,'e'*64,**kwargs)

    def test_revocation_after_approval_expiry_persists_and_cannot_be_replayed_away(self):
        with TemporaryDirectory() as temp:
            path=temp+'/registry.sqlite'; registry=self.registry(path)
            head=self.prepare(registry); record=self.revoke_record(head,now=1400)
            self.assertTrue(registry.revoke(record,now=1401)['accepted'])
            registry.close(); registry=self.registry(path)
            try:
                self.assertTrue(registry.head(self.node,now=2000)['revoked'])
                self.assertFalse(registry.head(self.node,now=2000)['document_live'])
                self.assertFalse(registry.accept(self.fixture.request,self.fixture.issue(),now=2000)['accepted'])
                self.assertFalse(registry.revoke(record,now=2000)['accepted'])
                self.assertEqual(len(registry.history(self.node)),2)
            finally: registry.close()

    def test_ordinary_renewal_does_not_reverse_revocation(self):
        registry=self.registry(); self.addCleanup(registry.close)
        head=self.prepare(registry); record=self.revoke_record(head,now=1003)
        digest=registry.revoke(record,now=1004)['digest']
        request=application(self.fixture.candidate,'lab','a'*64,'b'*64,'c'*64,'d'*64,now=1005)
        renewal=approval(request,'lab','a'*64,'b'*64,self.fixture.committee,self.fixture.keys[:3],now=1006,version=3,previous=digest)
        with self.assertRaisesRegex(ValueError,'node_revoked'): registry.accept(request,renewal,now=1007)
        self.assertTrue(registry.head(self.node,now=1007)['revoked'])

    def test_wrong_anchor_and_invalid_votes_leave_history_unchanged(self):
        registry=self.registry(); self.addCleanup(registry.close)
        head=self.prepare(registry)
        with self.assertRaises(ValueError): self.revoke_record(head,keys=self.fixture.keys[:2],now=1003)
        record=self.revoke_record(head,now=1003)
        for field in ('revokes','previous','policy','node_id'):
            bad=copy.deepcopy(record); bad['body'][field]='f'*64
            with self.assertRaises(ValueError): registry.revoke(bad,now=1004)
        bad=copy.deepcopy(record); bad['votes'][1]=bad['votes'][0]
        with self.assertRaises(ValueError): registry.revoke(bad,now=1004)
        self.assertEqual(len(registry.history(self.node)),1)
        self.assertFalse(registry.head(self.node,now=1004)['revoked'])

    def test_expired_new_revocation_is_not_accepted(self):
        registry=self.registry(); self.addCleanup(registry.close)
        record=self.revoke_record(self.prepare(registry),now=1003,ttl=2)
        with self.assertRaises(ValueError): registry.revoke(record,now=1005)
        self.assertEqual(len(registry.history(self.node)),1)
