from hashlib import sha256
import copy
import threading
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch
from . import test_admission
from .admission_consensus import AdmissionPublisher,admission_packet,validate_admission_state
from .admission_registry import AdmissionRegistry
from .admission_revocation import revocation


class AdmissionConsensusTests(unittest.TestCase):
    def setUp(self):
        fixture=test_admission.AdmissionTests();fixture.setUp();self.fixture=fixture
        self.request,self.approved=fixture.request,fixture.issue()
        self.state={'network':'lab','block_time':1002,'genesis_pin':'a'*64}
        self.directory=SimpleNamespace(network='lab',pin='a'*64,
            placement_assessors={sha256(bytes.fromhex(public)).hexdigest():public for public in fixture.committee.values()},
            lock=threading.RLock(),anchor=Mock(return_value={}),refresh=Mock(return_value=True),current={'state':self.state})
        self.temp=TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.path=Path(self.temp.name)/'publisher.sqlite'
        self.publisher=AdmissionPublisher(self.path,self.directory,'http://127.0.0.1:9999')
        self.addCleanup(lambda:self.publisher.close())
        self.registry=AdmissionRegistry(':memory:','lab','a'*64,'b'*64,fixture.committee)
        self.addCleanup(self.registry.close)

    def packet(self):return admission_packet('lab','approve',application=self.request,approval=self.approved)

    def install(self):
        nodes=[row[0] for row in self.registry.db.execute('SELECT DISTINCT node FROM admission_history')]
        self.state.update(admission_policy='b'*64,admissions={node:self.registry.history(node) for node in nodes})

    def test_outbox_restart_and_verified_confirmation_only(self):
        packet=self.packet()
        with patch('sfera_mesh.admission_consensus.rpc',side_effect=OSError('lost reply')):
            self.assertEqual(self.publisher.step(packet)['state'],'waiting')
        self.assertEqual(self.publisher.db.execute('SELECT COUNT(*) FROM admission_outbox').fetchone()[0],1)
        self.publisher.close();self.publisher=AdmissionPublisher(self.path,self.directory,'http://127.0.0.1:9999')
        self.registry.accept(self.request,self.approved,now=1002);self.install()
        with patch('sfera_mesh.admission_consensus.rpc') as broadcast:
            status=self.publisher.step(packet)
            self.assertEqual(status['state'],'confirmed');self.assertFalse(status['active_committee_changed']);broadcast.assert_not_called()
        self.state['block_time']=2000
        self.assertEqual(self.publisher.step(packet)['state'],'confirmed')

    def test_revocation_is_replicated_terminal_history(self):
        self.registry.accept(self.request,self.approved,now=1002);self.install()
        head=self.registry.head(self.request['body']['node_id'],now=1002)
        revoked=revocation(head,'lab','a'*64,'b'*64,self.fixture.committee,self.fixture.keys[:3],'f'*64,now=1003)
        self.state['block_time']=1003
        packet=admission_packet('lab','revoke',revocation=revoked)
        with patch('sfera_mesh.admission_consensus.rpc',return_value={'code':0}):self.assertEqual(self.publisher.step(packet)['state'],'submitted')
        self.registry.revoke(revoked,now=1003);self.install()
        self.assertEqual(self.publisher.step(packet)['state'],'confirmed')
        validate_admission_state(self.state,'lab','a'*64,self.fixture.committee)

    def test_bad_quorum_and_foreign_genesis_never_broadcast(self):
        for mutation in ('votes','genesis'):
            packet=copy.deepcopy(self.packet())
            if mutation=='votes':packet['approval']['votes'].pop()
            else:packet['application']['body']['genesis']='f'*64
            with patch('sfera_mesh.admission_consensus.rpc') as broadcast:
                with self.assertRaises(ValueError):self.publisher.step(packet)
                broadcast.assert_not_called()

    def test_snapshot_tamper_and_context_change_are_rejected(self):
        self.registry.accept(self.request,self.approved,now=1002);self.install()
        self.state['admissions'][self.request['body']['node_id']][0]['digest']='0'*64
        with self.assertRaises(ValueError):validate_admission_state(self.state,'lab','a'*64,self.fixture.committee)
        self.publisher.close()
        with patch.object(self.directory,'pin','f'*64):
            with self.assertRaisesRegex(ValueError,'context_changed'):AdmissionPublisher(self.path,self.directory,'http://127.0.0.1:9999')
