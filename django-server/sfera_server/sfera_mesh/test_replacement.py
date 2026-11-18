import copy
from hashlib import sha256
import json
import sqlite3
from tempfile import TemporaryDirectory
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from .candidates import registered_candidates
from .consensus_directory import ConsensusDirectory
from .placements import cluster_id, consent_licensed_placement
from .replacement import ReplacementController, PlacementSigner, replacement_proposal
from .resources import assessed_checks
from .storage import canonical
from . import test_candidates


class ReplacementTests(unittest.TestCase):
    def setUp(self):
        fixture = test_candidates.CandidateTests()
        fixture.setUp()
        self.fixture = fixture
        now = int(time.time())
        self.state = fixture.state
        self.state['block_time'] = now
        # Reissue fixture profiles at real wall time for signing and selection.
        from .candidates import candidate_record
        for key,identity in zip(fixture.keys,fixture.ids):
            claims = self.state['candidates'][identity]['record']['body']['license']['claims']
            claims.update(issued_at=now-1,expires_at=now+240)
            for module in claims['modules']: module['expires_at']=now+1000
            document = {'claims':claims,'signature':fixture.issuer.sign(canonical(claims)).hex()}
            record = candidate_record(key,'lab',document)
            self.state['candidates'][identity] = {'record':record,'digest':sha256(canonical(record)).hexdigest(),'accepted_at':now}
        members = sorted(fixture.ids[:3])
        self.cluster = cluster_id('lab',members)
        documents = [self.state['candidates'][identity]['record']['body']['license'] for identity in members]
        body = {'domain':'sfera-mesh-placement-v2','network':'lab','cluster':self.cluster,'epoch':1,'previous':'0'*64,'members':members,'licenses_hash':sha256(canonical(documents)).hexdigest()}
        lookup = dict(zip(fixture.ids,fixture.keys))
        record = {'body':body,'licenses':documents,'consents':[consent_licensed_placement(body,documents,lookup[identity],fixture.trusted) for identity in members]}
        self.state['placements'][self.cluster] = {'record':record,'digest':sha256(canonical(record)).hexdigest()}
        self.state['resources'] = {identity:{'record':{'body':{'candidate_hash':self.state['candidates'][identity]['digest'],'expires_at':now+60,'failure_domain':f'zone-{i}','capacity_slots':0 if i==2 else 2}}} for i,identity in enumerate(fixture.ids)}
        directory = object.__new__(ConsensusDirectory)
        directory.network, directory.pin = 'lab','pinned-genesis'
        directory.lock = threading.RLock()
        directory.placement_assessors = {'pinned':'keys'}
        directory.license_issuers = {identity:public.hex() for identity,public in fixture.trusted.items()}
        directory.current = {'state':self.state}
        directory.anchor = Mock(return_value={})
        directory.refresh = Mock(return_value=True)
        directory.placement = lambda cluster:{'record':copy.deepcopy(self.state['placements'][cluster]['record']),'record_hash':self.state['placements'][cluster]['digest']}
        directory.placement_candidates = lambda cluster=None:registered_candidates(self.state,'lab',fixture.trusted,assessed_checks(self.state,now=int(time.time()),cluster=cluster),now=int(time.time()))
        self.directory = directory
        self.signers = {identity:PlacementSigner(lookup[identity],directory) for identity in fixture.ids}
        db = sqlite3.connect(':memory:')
        db.execute('CREATE TABLE replica_jobs(cluster TEXT,state TEXT)')
        self.journal = SimpleNamespace(key=fixture.keys[0],verifier=SimpleNamespace(network='lab'),endpoints={identity:f'http://127.0.0.1:{1000+i}' for i,identity in enumerate(fixture.ids)},apply_confirmed_placement=Mock(),run_batch=Mock(),lock=threading.RLock(),db=db)
        self.journal.prepare_replacement=Mock(return_value={'ready':True})
        self.journal.enqueue_confirmed_manifest=Mock()
        self.journal.transfer_status=Mock(return_value={'complete':True})
        self.addCleanup(db.close)

    def test_healthy_borrowed_member_returns_only_to_a_free_prepared_target(self):
        from .readiness import readiness_proof
        borrowed = self.fixture.ids[2]
        current = self.state['placements'][self.cluster]
        current['record']['body']['epoch'] = 2
        current['accepted_at'] = 20
        home = {'record': {'body': {'epoch': 1, 'members': [borrowed, 'home-a', 'home-b']}},
                'accepted_at': 10, 'digest': 'home-entry'}
        self.state['placements']['home'] = home
        self.state['placement_history'] = {'home': [home], self.cluster: [current]}
        self.state['manifests'] = {self.cluster: {'digest': 'e'*64}}
        self.state['resources'][borrowed]['record']['body']['capacity_slots'] = 2
        proposal = replacement_proposal(self.directory, self.cluster)
        self.assertNotIn(borrowed, proposal['body']['members'])
        self.assertEqual(proposal['body']['domain'], 'sfera-mesh-placement-v3')
        target = next(iter(set(proposal['body']['members']) - set(self.fixture.ids[:3])))
        key = dict(zip(self.fixture.ids, self.fixture.keys))[target]
        proof = readiness_proof(proposal['body'], key)
        ready = {**proposal, 'body': {**proposal['body'], 'readiness_hash': sha256(canonical(proof)).hexdigest()}, 'readiness': proof}
        for identity in ready['body']['members']:
            self.signers[identity].consent(ready)
        def exchange_return(endpoint, sender, verifier, recipient, operation, payload):
            if operation == 'placement-ready':
                self.assertEqual(recipient, target)
                return readiness_proof(payload['body'], key)
            return self.signers[recipient].consent(payload)
        with ReplacementTestContext(self) as controller, patch('sfera_mesh.replacement.exchange', side_effect=exchange_return), patch('sfera_mesh.replacement.rpc', return_value={'code': 0}):
            self.assertEqual(controller.step(self.cluster)['state'], 'submitted')
            self.journal.apply_confirmed_placement.assert_not_called()
            self.journal.run_batch.assert_not_called()
            pending = json.loads(controller.db.execute('SELECT record FROM replacement_jobs').fetchone()[0])
            # The loan still occupies two memberships until consensus confirms.
            self.assertEqual(len(next(p for p in self.directory.placement_candidates(cluster=self.cluster) if p.node_id == borrowed).memberships), 2)
            self.state['placements'][self.cluster] = {'record': pending, 'digest': sha256(canonical(pending)).hexdigest()}
            with controller.db: controller.db.execute('UPDATE replacement_jobs SET retry_at=0')
            self.assertEqual(controller.step(self.cluster)['state'], 'complete')
            self.journal.apply_confirmed_placement.assert_called_once()
            self.journal.run_batch.assert_called_once()
        self.state['placements'][self.cluster] = current
        # Missing freshness, ambiguous origin, or no free node prevents return.
        original = copy.deepcopy(self.state)
        for mode in ('missing', 'ambiguous', 'busy', 'unfit'):
            self.state.clear(); self.state.update(copy.deepcopy(original))
            if mode == 'missing': del self.state['resources'][borrowed]
            elif mode == 'ambiguous': self.state['placement_history']['home'][0]['accepted_at'] = 20
            elif mode == 'unfit':
                self.state['resources'][self.fixture.ids[0]]['record']['body']['capacity_slots'] = 0
                self.state['resources'][borrowed]['record']['body']['capacity_slots'] = 0
            else:
                busy = {'record': {'body': {'epoch': 1, 'members': self.fixture.ids[3:]+['home-a']}}, 'accepted_at': 15, 'digest': 'busy-entry'}
                self.state['placements']['busy'] = busy
                self.state['placement_history']['busy'] = [busy]
            with self.assertRaises(ValueError): replacement_proposal(self.directory, self.cluster)

    def exchange(self,_endpoint,_key,_verifier,recipient,_operation,payload):
        return self.signers[recipient].consent(payload)

    def test_missing_quorum_and_two_unfit_members_never_request_consents(self):
        for count in (0,2):
            for i,identity in enumerate(self.fixture.ids[:3]):
                self.state['resources'][identity]['record']['body']['capacity_slots'] = 0 if i<count else 2
            with self.assertRaisesRegex(ValueError,'one_quorum'): replacement_proposal(self.directory,self.cluster)
        with ReplacementTestContext(self) as controller, patch('sfera_mesh.replacement.exchange') as exchange:
            self.assertEqual(controller.step(self.cluster)['state'],'waiting')
            exchange.assert_not_called()
            self.journal.run_batch.assert_not_called()

    def test_exact_outbox_survives_restart_and_recovers_only_after_confirmation(self):
        with TemporaryDirectory() as temp:
            path = temp+'/controller.sqlite'
            controller = ReplacementController(path,self.directory,'http://127.0.0.1:9999',self.journal)
            with patch('sfera_mesh.replacement.exchange',side_effect=self.exchange) as exchange, patch('sfera_mesh.replacement.rpc',side_effect=OSError('lost acknowledgement')):
                self.assertEqual(controller.step(self.cluster)['state'],'waiting')
                self.assertEqual(exchange.call_count,3)
            pending = json.loads(controller.db.execute('SELECT record FROM replacement_jobs').fetchone()[0])
            controller.close()
            controller = ReplacementController(path,self.directory,'http://127.0.0.1:9999',self.journal)
            try:
                with controller.db: controller.db.execute('UPDATE replacement_jobs SET retry_at=0')
                with patch('sfera_mesh.replacement.exchange') as exchange, patch('sfera_mesh.replacement.rpc',return_value={'code':0}):
                    self.assertEqual(controller.step(self.cluster)['state'],'submitted')
                    exchange.assert_not_called()
                self.journal.run_batch.assert_not_called()
                self.state['placements'][self.cluster] = {'record':pending,'digest':sha256(canonical(pending)).hexdigest()}
                with controller.db: controller.db.execute('UPDATE replacement_jobs SET retry_at=0')
                self.assertEqual(controller.step(self.cluster)['state'],'complete')
                self.journal.run_batch.assert_called_once_with(self.cluster)
            finally: controller.close()

    def test_member_rejects_changed_proposal_and_missing_assessment(self):
        proposal = replacement_proposal(self.directory,self.cluster)
        changed = copy.deepcopy(proposal)
        changed['body']['previous'] = 'a'*64
        signer = self.signers[proposal['body']['members'][0]]
        with self.assertRaises(ValueError): signer.consent(changed)
        self.state['resources'].clear()
        with self.assertRaises(ValueError): signer.consent(proposal)

    def test_unverified_warmup_never_requests_consents_or_broadcasts(self):
        self.journal.prepare_replacement.return_value={'ready':False,'reason':'preparation_source_unavailable'}
        with ReplacementTestContext(self) as controller,patch('sfera_mesh.replacement.exchange') as consents,patch('sfera_mesh.replacement.rpc') as broadcast:
            self.assertEqual(controller.step(self.cluster)['state'],'preparing')
            consents.assert_not_called()
            broadcast.assert_not_called()


class ReplacementTestContext:
    def __init__(self,test): self.test=test
    def __enter__(self):
        self.controller = ReplacementController(':memory:',self.test.directory,'http://127.0.0.1:9999',self.test.journal)
        return self.controller
    def __exit__(self,*_): self.controller.close()
