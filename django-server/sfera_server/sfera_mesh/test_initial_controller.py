import copy
from hashlib import sha256
import json
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import time
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from . import test_initial_planning
from .initial_controller import InitialController,initial_proposals
from .storage import canonical
from .identity import node_id
from .candidates import candidate_record
from .replacement import PlacementSigner


class InitialControllerTests(unittest.TestCase):
    def setUp(self):
        owner=test_initial_planning.InitialPlanningTests()
        self.fixture,self.record=owner.batch_fixture()
        self.addCleanup(owner.doCleanups)
        self.directory=self.fixture.directory
        base=self.fixture.fixture
        self.key=base.keys[0]
        self.verifier=SimpleNamespace(network='lab',recipient=base.ids[0],roster=dict(zip(base.ids,[key.public_key().public_bytes_raw() for key in base.keys])))
        self.endpoints=self.fixture.journal.endpoints

    def controller(self,path=':memory:',count=1,endpoints=None):
        return InitialController(path,self.directory,'http://127.0.0.1:9999',self.key,self.verifier,self.endpoints if endpoints is None else endpoints,count=count)

    def response(self,endpoint,key,verifier,recipient,operation,payload):
        return self.fixture.signers[recipient].initial_consent(payload)

    def test_exact_outbox_survives_restart_and_request_stops_after_confirmation(self):
        with TemporaryDirectory() as temp:
            path=temp+'/initial.sqlite'; controller=self.controller(path)
            with patch('sfera_mesh.initial_controller.exchange',side_effect=self.response) as consents,patch('sfera_mesh.initial_controller.rpc',side_effect=OSError('lost reply')):
                self.assertEqual(controller.step()['state'],'waiting')
                self.assertEqual(consents.call_count,3)
            pending=json.loads(controller.db.execute('SELECT record FROM initial_job').fetchone()[0])
            controller.close(); controller=self.controller(path)
            try:
                with controller.db: controller.db.execute('UPDATE initial_job SET retry_at=0')
                with patch('sfera_mesh.initial_controller.exchange') as consents,patch('sfera_mesh.initial_controller.rpc',return_value={'code':0}):
                    self.assertEqual(controller.step()['state'],'submitted'); consents.assert_not_called()
                digest=sha256(canonical(pending)).hexdigest()
                self.fixture.state['initial_batches']={digest:{}}
                with controller.db: controller.db.execute('UPDATE initial_job SET retry_at=0')
                self.assertEqual(controller.step()['state'],'confirmed')
                with patch('sfera_mesh.initial_controller.exchange') as consents:
                    self.assertEqual(controller.step()['state'],'confirmed'); consents.assert_not_called()
            finally: controller.close()
            with self.assertRaisesRegex(ValueError,'context_changed'): self.controller(path,count=2)

    def test_pool_change_during_consent_collection_prevents_partial_send(self):
        controller=self.controller(); self.addCleanup(controller.close)
        called=[]
        def request(*args):
            response=self.response(*args); called.append(True)
            self.fixture.state['resources'][self.fixture.fixture.ids[-1]]['digest']='e'*64
            return response
        with patch('sfera_mesh.initial_controller.exchange',side_effect=request),patch('sfera_mesh.initial_controller.rpc') as broadcast:
            self.assertEqual(controller.step()['state'],'waiting')
            self.assertEqual(len(called),1); broadcast.assert_not_called()
        self.assertIsNone(controller.db.execute('SELECT record FROM initial_job').fetchone()[0])

    def test_pool_change_after_last_consent_is_not_persisted_or_sent(self):
        controller=self.controller(); self.addCleanup(controller.close)
        calls=[]
        def request(*args):
            response=self.response(*args); calls.append(True)
            if len(calls)==3:
                self.fixture.state['resources'][self.fixture.fixture.ids[-1]]['digest']='c'*64
            return response
        with patch('sfera_mesh.initial_controller.exchange',side_effect=request),patch('sfera_mesh.initial_controller.rpc') as broadcast:
            self.assertEqual(controller.step()['error'],'initial_plan_changed_before_send')
            self.assertEqual(len(calls),3); broadcast.assert_not_called()
        self.assertIsNone(controller.db.execute('SELECT record FROM initial_job').fetchone()[0])
        with controller.db: controller.db.execute('UPDATE initial_job SET retry_at=0')
        with patch('sfera_mesh.initial_controller.exchange',side_effect=self.response),patch('sfera_mesh.initial_controller.rpc',return_value={'code':0}):
            self.assertEqual(controller.step()['state'],'submitted')

    def test_shared_request_lock_blocks_second_controller_until_release(self):
        with TemporaryDirectory() as temp:
            path=temp+'/initial.sqlite'
            first=self.controller(path); second=self.controller(path)
            try:
                self.assertTrue(first.process_lock.acquire())
                with patch('sfera_mesh.initial_controller.exchange') as consents,patch('sfera_mesh.initial_controller.rpc') as broadcast:
                    self.assertEqual(second.step()['state'],'busy')
                    consents.assert_not_called(); broadcast.assert_not_called()
                self.assertEqual(second.status()['state'],'idle')
                first.process_lock.release()
                with patch('sfera_mesh.initial_controller.exchange',side_effect=self.response),patch('sfera_mesh.initial_controller.rpc',return_value={'code':0}):
                    self.assertEqual(second.step()['state'],'submitted')
            finally:
                first.process_lock.release(); first.close(); second.close()

    def test_missing_endpoint_never_starts_consents(self):
        plan,_=initial_proposals(self.directory,1)
        endpoints=dict(self.endpoints); del endpoints[plan['groups'][0][0]]
        controller=self.controller(endpoints=endpoints); self.addCleanup(controller.close)
        with patch('sfera_mesh.initial_controller.exchange') as consents,patch('sfera_mesh.initial_controller.rpc') as broadcast:
            self.assertEqual(controller.step()['state'],'waiting')
            consents.assert_not_called(); broadcast.assert_not_called()

    def test_signer_rejects_changed_pool_and_forged_own_proposal(self):
        plan,proposals=initial_proposals(self.directory,1)
        member=plan['groups'][0][0]; signer=self.fixture.signers[member]
        payload={'count':1,'pool_hash':plan['pool_hash'],'proposal':proposals[0]}
        signer.initial_consent(payload)
        with self.assertRaises(ValueError): signer.initial_consent({**payload,'pool_hash':'f'*64})
        bad=copy.deepcopy(payload); bad['proposal']['body']['previous']='f'*64
        with self.assertRaises(ValueError): signer.initial_consent(bad)

    def test_changed_pool_keeps_unknown_outbox_until_finality_or_expiry(self):
        controller=self.controller(); self.addCleanup(controller.close)
        with patch('sfera_mesh.initial_controller.exchange',side_effect=self.response),patch('sfera_mesh.initial_controller.rpc',side_effect=OSError('unknown broadcast result')):
            self.assertEqual(controller.step()['state'],'waiting')
        pending=json.loads(controller.db.execute('SELECT record FROM initial_job').fetchone()[0])
        self.fixture.state['resources'][self.fixture.fixture.ids[-1]]['digest']='d'*64
        with controller.db: controller.db.execute('UPDATE initial_job SET retry_at=0')
        with patch('sfera_mesh.initial_controller.exchange') as consents,patch('sfera_mesh.initial_controller.rpc') as broadcast:
            status=controller.step()
            self.assertEqual(status['error'],'initial_outbox_waiting_finalized_expiry')
            consents.assert_not_called(); broadcast.assert_not_called()
        self.assertEqual(json.loads(controller.db.execute('SELECT record FROM initial_job').fetchone()[0]),pending)
        self.fixture.state['initial_batches']={sha256(canonical(pending)).hexdigest():{}}
        with controller.db: controller.db.execute('UPDATE initial_job SET retry_at=0')
        self.assertEqual(controller.step()['state'],'confirmed')

    def test_replan_requires_finalized_expiry_and_survives_restart(self):
        with TemporaryDirectory() as temp:
            path=temp+'/initial.sqlite'; controller=self.controller(path)
            with patch('sfera_mesh.initial_controller.exchange',side_effect=self.response),patch('sfera_mesh.initial_controller.rpc',side_effect=OSError('lost reply')):
                self.assertEqual(controller.step()['state'],'waiting')
            old=json.loads(controller.db.execute('SELECT record FROM initial_job').fetchone()[0])
            deadline=min(doc['claims']['expires_at'] for record in old['placements'] for doc in record['licenses'])
            controller.close(); controller=self.controller(path)
            try:
                # Fresh signed profiles and assessments are explicit fixture inputs.
                # Wall time past the old deadline alone must not unlock a new batch.
                base=self.fixture.fixture
                for key,identity in zip(base.keys,base.ids):
                    claims=copy.deepcopy(self.fixture.state['candidates'][identity]['record']['body']['license']['claims'])
                    claims.update(issued_at=deadline-1,expires_at=deadline+240)
                    document={'claims':claims,'signature':base.issuer.sign(canonical(claims)).hex()}
                    offer=candidate_record(key,'lab',document)
                    digest=sha256(canonical(offer)).hexdigest()
                    self.fixture.state['candidates'][identity]={'record':offer,'digest':digest,'accepted_at':deadline-1}
                    resource=self.fixture.state['resources'][identity]
                    resource['record']['body'].update(candidate_hash=digest,expires_at=deadline+60)
                    resource['digest']=digest
                self.fixture.state['block_time']=deadline-1
                with controller.db: controller.db.execute('UPDATE initial_job SET retry_at=0')
                with patch('time.time',return_value=deadline+1),patch('sfera_mesh.initial_controller.exchange') as consents,patch('sfera_mesh.initial_controller.rpc') as broadcast:
                    self.assertEqual(controller.step()['error'],'initial_outbox_waiting_finalized_expiry')
                    consents.assert_not_called(); broadcast.assert_not_called()
                self.assertEqual(json.loads(controller.db.execute('SELECT record FROM initial_job').fetchone()[0]),old)
                self.fixture.state['block_time']=deadline
                with controller.db: controller.db.execute('UPDATE initial_job SET retry_at=0')
                with patch('time.time',return_value=deadline+1),patch('sfera_mesh.initial_controller.exchange',side_effect=self.response) as consents,patch('sfera_mesh.initial_controller.rpc',return_value={'code':0}) as broadcast:
                    self.assertEqual(controller.step()['state'],'submitted')
                    self.assertEqual(consents.call_count,3); broadcast.assert_called_once()
                new=json.loads(controller.db.execute('SELECT record FROM initial_job').fetchone()[0])
                self.assertNotEqual(new,old)
                self.assertNotEqual(new['body']['pool_hash'],old['body']['pool_hash'])
            finally: controller.close()

    def test_receipt_wins_over_expiry_even_when_no_new_plan_exists(self):
        controller=self.controller(); self.addCleanup(controller.close)
        with patch('sfera_mesh.initial_controller.exchange',side_effect=self.response),patch('sfera_mesh.initial_controller.rpc',side_effect=OSError('lost reply')):
            controller.step()
        old=json.loads(controller.db.execute('SELECT record FROM initial_job').fetchone()[0])
        self.fixture.state['block_time']=max(doc['claims']['expires_at'] for record in old['placements'] for doc in record['licenses'])
        self.fixture.state['initial_batches']={sha256(canonical(old)).hexdigest():{}}
        self.fixture.state['resources'].clear()
        with controller.db: controller.db.execute('UPDATE initial_job SET retry_at=0')
        with patch('sfera_mesh.initial_controller.exchange') as consents,patch('sfera_mesh.initial_controller.rpc') as broadcast:
            self.assertEqual(controller.step()['state'],'confirmed')
            consents.assert_not_called(); broadcast.assert_not_called()

    def test_two_triples_require_all_six_independent_consents(self):
        base=self.fixture.fixture
        key=Ed25519PrivateKey.generate(); identity=node_id(key.public_key().public_bytes_raw())
        claims=copy.deepcopy(self.fixture.state['candidates'][base.ids[-1]]['record']['body']['license']['claims'])
        import uuid
        claims.update(node_id=identity,instance_id=str(uuid.uuid4()))
        document={'claims':claims,'signature':base.issuer.sign(canonical(claims)).hex()}
        offer=candidate_record(key,'lab',document)
        self.fixture.state['candidates'][identity]={'record':offer,'digest':sha256(canonical(offer)).hexdigest(),'accepted_at':int(time.time())}
        self.fixture.state['resources'][identity]={'record':{'body':{'candidate_hash':sha256(canonical(offer)).hexdigest(),'expires_at':int(time.time())+60,'failure_domain':'zone-extra','capacity_slots':2}},'digest':identity}
        self.verifier.roster[identity]=key.public_key().public_bytes_raw()
        self.endpoints[identity]='http://127.0.0.1:9998'
        self.fixture.signers[identity]=PlacementSigner(key,self.directory)
        controller=self.controller(count=2); self.addCleanup(controller.close)
        with patch('sfera_mesh.initial_controller.exchange',side_effect=self.response) as consents,patch('sfera_mesh.initial_controller.rpc',return_value={'code':0}):
            status=controller.step()
            self.assertEqual(status['state'],'submitted',status)
            self.assertEqual(consents.call_count,6)
        pending=json.loads(controller.db.execute('SELECT record FROM initial_job').fetchone()[0])
        self.assertEqual(len(pending['placements']),2)
        self.assertEqual(len({node for record in pending['placements'] for node in record['body']['members']}),6)
