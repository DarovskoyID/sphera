import copy
from hashlib import sha256
import json
from tempfile import TemporaryDirectory
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from . import test_replacement
from .failure_coordinator import FailureCoordinator
from .failures import FailureObserver, validate_observations
from .storage import canonical


class FailureTests(unittest.TestCase):
    def setUp(self):
        fixture=test_replacement.ReplacementTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.fixture=fixture
        self.directory=fixture.directory
        self.target=fixture.fixture.ids[2]
        self.keys=[Ed25519PrivateKey.generate() for _ in range(4)]
        self.assessors={sha256(key.public_key().public_bytes_raw()).hexdigest():key.public_key().public_bytes_raw().hex() for key in self.keys}
        self.directory.placement_assessors=self.assessors
        ids=[identity for identity in fixture.fixture.ids if identity!=self.target]
        self.bindings=dict(zip(self.assessors,ids))
        self.health=[]; self.observers={}
        now=int(time.time())
        survivors=sorted(identity for identity in fixture.fixture.ids[:3] if identity!=self.target)
        for key,assessor in zip(self.keys,self.assessors):
            health=SimpleNamespace(verifier=SimpleNamespace(network='lab',recipient=self.bindings[assessor]),
                advisory=Mock(return_value={'can_request_consents':True,'unreachable_from_observer':[self.target],'healthy_survivors':survivors}),
                status=Mock(return_value={'failure_since':now-20,'last_check':now,'failures':3}))
            self.health.append(health)
            self.observers[assessor]=FailureObserver(key,health,self.directory,self.bindings)
        old=self.directory.current['state']['resources'][self.target]
        old['record']['body'].update(version=1,capacity_slots=2)
        old['digest']=sha256(canonical(old['record'])).hexdigest()

    def observations(self):
        return [observer.observe({'cluster':self.fixture.cluster}) for observer in list(self.observers.values())[:3]]

    def body(self,proofs):
        evidence=validate_observations(proofs,self.directory,self.bindings)
        old=self.directory.current['state']['resources'][self.target]
        now=int(time.time())
        return {'domain':'sfera-mesh-resource-v1','network':'lab','node_id':self.target,'candidate_hash':evidence['candidate_hash'],'version':2,'previous':old['digest'],'failure_domain':old['record']['body']['failure_domain'],'capacity_slots':0,'issued_at':now,'expires_at':min(now+12,evidence['expires_at'])}

    def test_quorum_requires_distinct_pinned_fresh_matching_observers(self):
        proofs=self.observations()
        self.assertEqual(validate_observations(proofs,self.directory,self.bindings)['node_id'],self.target)
        for kind in ('one','duplicate','stale','changed','forged'):
            bad=copy.deepcopy(proofs)
            if kind=='one': bad=bad[:1]
            elif kind=='duplicate': bad[1]=bad[0]
            elif kind=='stale':
                with self.assertRaises(ValueError): validate_observations(bad,self.directory,self.bindings,now=int(time.time())+20)
                continue
            elif kind=='changed': self.directory.current['state']['candidates'][self.target]['digest']='e'*64
            else: bad[0]['signature']='0'*128
            with self.assertRaises(ValueError): validate_observations(bad,self.directory,self.bindings)

    def test_observation_window_and_recovery_veto(self):
        proofs=self.observations(); body=self.body(proofs)
        observer=next(iter(self.observers.values()))
        consent=observer.consent({'body':body,'observations':proofs})['consent']
        self.keys[0].public_key().verify(bytes.fromhex(consent['signature']),canonical(body))
        self.health[0].advisory.return_value['can_request_consents']=False
        with self.assertRaises(ValueError): observer.consent({'body':body,'observations':proofs})
        self.health[0].advisory.return_value['can_request_consents']=True
        self.health[0].status.return_value['failure_since']=int(time.time())-10
        with self.assertRaisesRegex(ValueError,'own_current'): observer.consent({'body':body,'observations':proofs})
        self.health[1].status.return_value['failure_since']=int(time.time())-1
        with self.assertRaises(ValueError): list(self.observers.values())[1].observe({'cluster':self.fixture.cluster})

    def test_shared_observer_identity_is_not_independence(self):
        bindings=dict(self.bindings)
        keys=list(self.observers)
        bindings[keys[1]]=bindings[keys[0]]
        with self.assertRaises(ValueError): validate_observations(self.observations(),self.directory,bindings)

    def test_disjoint_signed_windows_do_not_form_a_failure_quorum(self):
        proofs=self.observations()
        now=int(time.time())
        for i,record in enumerate(proofs):
            end=now-14 if i==0 else now
            record['body'].update(observed_at=end,failure_since=end-10)
            record['signature']=self.keys[i].sign(canonical(record['body'])).hex()
        with self.assertRaisesRegex(ValueError,'windows_do_not_overlap'):
            validate_observations(proofs,self.directory,self.bindings)

    def test_minority_partition_cannot_submit_a_revocation(self):
        inventory={assessor:{'observer':identity,'endpoint':f'http://127.0.0.1:{2000+i}'} for i,(assessor,identity) in enumerate(self.bindings.items())}
        key=self.fixture.fixture.keys[0]
        verifier=SimpleNamespace(network='lab',recipient=self.fixture.fixture.ids[0],roster={identity:k.public_key().public_bytes_raw() for identity,k in zip(self.fixture.fixture.ids,self.fixture.fixture.keys)})
        available=set(list(self.observers)[:2])
        def request(assessor,operation,payload):
            if assessor not in available: raise OSError('observer partitioned')
            return self.observers[assessor].observe(payload)
        controller=FailureCoordinator(':memory:',self.directory,'http://127.0.0.1:9999',key,verifier,inventory)
        try:
            with patch.object(controller,'_request',side_effect=request),patch('sfera_mesh.failure_coordinator.rpc') as submit:
                self.assertEqual(controller.step(self.fixture.cluster)['state'],'waiting')
                submit.assert_not_called()
                self.assertIsNone(controller.db.execute('SELECT record FROM failure_jobs').fetchone()[0])
        finally: controller.close()

    def test_coordinator_reuses_outbox_after_lost_acknowledgement(self):
        inventory={assessor:{'observer':identity,'endpoint':f'http://127.0.0.1:{2000+i}'} for i,(assessor,identity) in enumerate(self.bindings.items())}
        key=self.fixture.fixture.keys[0]
        verifier=SimpleNamespace(network='lab',recipient=self.fixture.fixture.ids[0],roster={identity:k.public_key().public_bytes_raw() for identity,k in zip(self.fixture.fixture.ids,self.fixture.fixture.keys)})
        def request(assessor,operation,payload):
            observer=self.observers[assessor]
            return observer.observe(payload) if operation=='failure-observation' else observer.consent(payload)
        with TemporaryDirectory() as temp:
            path=temp+'/failure.sqlite'
            controller=FailureCoordinator(path,self.directory,'http://127.0.0.1:9999',key,verifier,inventory)
            with patch.object(controller,'_request',side_effect=request),patch('sfera_mesh.failure_coordinator.rpc',side_effect=OSError('lost acknowledgement')):
                self.assertEqual(controller.step(self.fixture.cluster)['state'],'waiting')
            pending=json.loads(controller.db.execute('SELECT record FROM failure_jobs').fetchone()[0])
            controller.close()
            controller=FailureCoordinator(path,self.directory,'http://127.0.0.1:9999',key,verifier,inventory)
            try:
                with controller.db: controller.db.execute('UPDATE failure_jobs SET retry_at=0')
                with patch.object(controller,'_request') as request_mock,patch('sfera_mesh.failure_coordinator.rpc',return_value={'code':0}):
                    self.assertEqual(controller.step(self.fixture.cluster)['state'],'submitted')
                    request_mock.assert_not_called()
                self.directory.current['state']['resources'][self.target]={'record':pending,'digest':sha256(canonical(pending)).hexdigest()}
                with controller.db: controller.db.execute('UPDATE failure_jobs SET retry_at=0')
                self.assertEqual(controller.step(self.fixture.cluster)['state'],'confirmed')
            finally: controller.close()
