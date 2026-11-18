from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from . import test_replacement
from .growth import GrowthCoordinator,GrowthParticipant,validate_growth_grants,validate_growth_record
from .storage import canonical
from .transport import BlobStore


class GrowthTests(unittest.TestCase):
    def setUp(self):
        self.fixture=test_replacement.ReplacementTests();self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.state,self.directory,self.cluster=self.fixture.state,self.fixture.directory,self.fixture.cluster
        keys=dict(zip(self.fixture.fixture.ids,self.fixture.fixture.keys))
        self.members=self.state['placements'][self.cluster]['record']['body']['members']
        self.state['placement_history']={self.cluster:[json.loads(canonical(self.state['placements'][self.cluster]))]}
        self.state['license_issuers']=self.directory.license_issuers
        self.origin=self.fixture.fixture.ids[0]
        self.stores={node:BlobStore(':memory:',max_bytes=16) for node in self.members}
        for store in self.stores.values():self.addCleanup(store.close)
        self.participants={node:GrowthParticipant(keys[node],self.directory,self.stores[node]) for node in self.members}
        self.journal=SimpleNamespace(key=keys[self.origin],verifier=SimpleNamespace(network='lab'),refresh_discovery=lambda:None,_request=self.request)
        self.token='d'*64

    def request(self,target,operation,payload):
        participant=self.participants[target]
        return participant.reserve(payload,self.origin) if operation=='growth-reserve' else participant.release(payload,self.origin)

    def install(self,coordinator):
        raw=coordinator.db.execute('SELECT record FROM growth_outbox').fetchone()[0]
        record=json.loads(raw)
        identity=record['body']['budget_id']
        self.state['growth_grants']={identity:{'record':record,'digest':sha256(canonical(record)).hexdigest(),'accepted_at':self.state['block_time']}}
        validate_growth_grants(self.state,'lab')
        return record

    def test_lost_reply_restart_and_no_writes_until_bft_confirmation(self):
        with TemporaryDirectory() as temp:
            path=Path(temp)/'growth.sqlite3'
            coordinator=GrowthCoordinator(path,self.directory,'http://127.0.0.1:9999',self.journal)
            def hidden(target,operation,payload):
                self.request(target,operation,payload)
                return None
            with patch.object(self.journal,'_request',side_effect=hidden):
                self.assertEqual(coordinator.reserve(self.cluster,self.token,8)['state'],'preparing')
            body=json.loads(coordinator.db.execute('SELECT body FROM growth_outbox').fetchone()[0])
            first=self.members[0]
            self.assertEqual(self.stores[first].growth_budget(self.cluster,body['budget_id'])['remaining_bytes'],8)
            coordinator.close()
            coordinator=GrowthCoordinator(path,self.directory,'http://127.0.0.1:9999',self.journal)
            try:
                with patch('sfera_mesh.growth.rpc',side_effect=OSError('reply lost')):
                    self.assertEqual(coordinator.reserve(self.cluster,self.token,8)['state'],'waiting')
                payload={'digest':sha256(b'abcd').hexdigest(),'ciphertext':b'abcd'.hex(),'growth':{'cluster':self.cluster,'budget':body['budget_id']}}
                with self.assertRaisesRegex(ValueError,'consensus_growth_grant'):
                    self.participants[first].put(payload,self.origin)
                record=self.install(coordinator)
                self.assertEqual(coordinator.reserve(self.cluster,self.token,8)['state'],'confirmed')
                for member in self.members:
                    for _ in range(2):self.participants[member].put(payload,self.origin)
                    self.assertEqual(self.stores[member].growth_budget(self.cluster,body['budget_id'])['remaining_bytes'],4)
                with self.assertRaisesRegex(ValueError,'finality'):
                    self.participants[first].release({'cluster':self.cluster,'budget':body['budget_id']},self.origin)
                bad={'body':record['body'],'consents':record['consents'][:2]}
                with self.assertRaises(ValueError):validate_growth_record(bad,'lab',self.state['placements'][self.cluster],self.state['block_time'])
            finally:coordinator.close()

    def test_uncommitted_preparations_release_only_after_chain_deadline(self):
        coordinator=GrowthCoordinator(':memory:',self.directory,'http://127.0.0.1:9999',self.journal)
        self.addCleanup(coordinator.close)
        with patch('sfera_mesh.growth.rpc',return_value={'code':0}):
            result=coordinator.reserve(self.cluster,self.token,8)
        body=json.loads(coordinator.db.execute('SELECT body FROM growth_outbox').fetchone()[0])
        payload={'cluster':self.cluster,'budget':result['budget_id']}
        participant=self.participants[self.members[0]]
        self.state['block_time']=body['prepare_expires_at']-1
        with patch('time.time',return_value=body['prepare_expires_at']+1000):
            with self.assertRaisesRegex(ValueError,'finality'):participant.release(payload,self.origin)
        self.state['block_time']=body['prepare_expires_at']
        self.assertEqual(coordinator.reserve(self.cluster,self.token,8)['state'],'expired')
        for store in self.stores.values():
            self.assertTrue(store.growth_budget(self.cluster,result['budget_id'])['closed'])
            self.assertEqual(store.usage()['available_bytes'],16)
