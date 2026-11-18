from hashlib import sha256
import json
from tempfile import TemporaryDirectory
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from . import test_failures
from .capacity import CapacityAssessor, CapacityPolicy
from .capacity_renewal import CapacityRenewal
from .storage import canonical


class RenewalTests(unittest.TestCase):
    def setUp(self):
        fixture=test_failures.FailureTests(); fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.fixture=fixture
        self.directory,self.target=fixture.directory,fixture.target
        self.state=self.directory.current['state']
        self.state['resources'][self.target]['record']['body']['expires_at']=int(time.time())+5
        base=fixture.fixture.fixture
        self.key=base.keys[0]
        self.verifier=SimpleNamespace(network='lab',recipient=base.ids[0],roster=dict(zip(base.ids,[key.public_key().public_bytes_raw() for key in base.keys])))
        self.inventory={assessor:{'observer':identity,'endpoint':f'http://127.0.0.1:{2000+i}'} for i,(assessor,identity) in enumerate(fixture.bindings.items())}
        self.domains={self.target:self.state['resources'][self.target]['record']['body']['failure_domain']}
        self.signers={assessor:CapacityAssessor(self.directory,key,None,None,{self.target:'http://127.0.0.1:9000'},self.domains,CapacityPolicy(1,1,1)) for assessor,key in zip(fixture.assessors,fixture.keys)}

    def controller(self,path=':memory:'):
        return CapacityRenewal(path,self.directory,'http://127.0.0.1:9999',self.key,self.verifier,self.inventory,self.domains)

    def response(self,endpoint,key,verifier,recipient,operation,payload):
        assessor=next(identity for identity,item in self.inventory.items() if item['observer']==recipient)
        with patch('sfera_mesh.capacity.measure_capacity',return_value={'capacity_slots':2}):
            return self.signers[assessor].consent(payload)

    def test_two_assessors_or_failed_measurements_cannot_renew_or_revoke(self):
        controller=self.controller(); self.addCleanup(controller.close)
        available={item['observer'] for item in list(self.inventory.values())[:2]}
        def request(*args):
            if args[3] not in available: raise OSError('partition')
            return self.response(*args)
        original=canonical(self.state['resources'])
        with patch('sfera_mesh.capacity_renewal.exchange',side_effect=request),patch('sfera_mesh.capacity_renewal.rpc') as broadcast:
            self.assertEqual(controller.step(self.target)['state'],'waiting')
            broadcast.assert_not_called()
        self.assertEqual(canonical(self.state['resources']),original)
        with self.assertRaises(ValueError): next(iter(self.signers.values())).consent({'body':{'capacity_slots':0}})

    def test_outbox_restart_exact_retry_confirmation_and_fresh_skip(self):
        with TemporaryDirectory() as temp:
            path=temp+'/capacity.sqlite'
            controller=self.controller(path)
            with patch('sfera_mesh.capacity_renewal.exchange',side_effect=self.response),patch('sfera_mesh.capacity_renewal.rpc',side_effect=OSError('lost response')):
                self.assertEqual(controller.step(self.target)['state'],'waiting')
            pending=json.loads(controller.db.execute('SELECT record FROM capacity_jobs').fetchone()[0])
            self.assertEqual(pending['body']['capacity_slots'],2)
            controller.close(); controller=self.controller(path)
            try:
                with controller.db: controller.db.execute('UPDATE capacity_jobs SET retry_at=0')
                with patch('sfera_mesh.capacity_renewal.exchange') as requests,patch('sfera_mesh.capacity_renewal.rpc',return_value={'code':0}):
                    self.assertEqual(controller.step(self.target)['state'],'submitted')
                    requests.assert_not_called()
                self.state['resources'][self.target]={'record':pending,'digest':sha256(canonical(pending)).hexdigest()}
                with controller.db: controller.db.execute('UPDATE capacity_jobs SET retry_at=0')
                self.assertEqual(controller.step(self.target)['state'],'confirmed')
                with patch('sfera_mesh.capacity_renewal.exchange') as requests:
                    self.assertEqual(controller.step(self.target)['state'],'fresh')
                    requests.assert_not_called()
            finally: controller.close()

    def test_one_bad_signature_does_not_prevent_three_healthy_assessors(self):
        controller=self.controller(); self.addCleanup(controller.close)
        bad=self.inventory[sorted(self.inventory)[0]]['observer']
        def request(*args):
            result=self.response(*args)
            if args[3]==bad: result['consent']['signature']='0'*128
            return result
        with patch('sfera_mesh.capacity_renewal.exchange',side_effect=request),patch('sfera_mesh.capacity_renewal.rpc',return_value={'code':0}):
            self.assertEqual(controller.step(self.target)['state'],'submitted')

    def test_probe_failures_never_publish_zero_capacity(self):
        controller=self.controller(); self.addCleanup(controller.close)
        original=canonical(self.state['resources'])
        def request(endpoint,key,verifier,recipient,operation,payload):
            assessor=next(identity for identity,item in self.inventory.items() if item['observer']==recipient)
            return self.signers[assessor].consent(payload)
        with patch('sfera_mesh.capacity_renewal.exchange',side_effect=request),patch('sfera_mesh.capacity.measure_capacity',side_effect=OSError('probe failed')),patch('sfera_mesh.capacity_renewal.rpc') as broadcast:
            self.assertEqual(controller.step(self.target)['state'],'waiting')
            broadcast.assert_not_called()
        self.assertEqual(canonical(self.state['resources']),original)
        self.assertIsNone(controller.db.execute('SELECT record FROM capacity_jobs').fetchone()[0])

    def test_reopen_rejects_changed_pinned_inventory(self):
        with TemporaryDirectory() as temp:
            path=temp+'/capacity.sqlite'
            self.controller(path).close()
            self.domains[self.target]='changed-zone'
            with self.assertRaisesRegex(ValueError,'context_changed'):
                self.controller(path)

    def test_fresh_cache_skips_repeated_rpc_refresh_without_extending_expiry(self):
        controller=self.controller(); self.addCleanup(controller.close)
        head=self.state['resources'][self.target]
        head['record']['body']['expires_at']=int(time.time())+60
        original=canonical(head)
        self.directory.refresh.reset_mock()
        with patch('sfera_mesh.capacity_renewal.exchange') as requests:
            self.assertEqual(controller.step(self.target)['state'],'fresh')
            changes=controller.db.total_changes
            for _ in range(63): self.assertEqual(controller.step(self.target)['state'],'fresh')
            self.assertEqual(controller.db.total_changes,changes)
            requests.assert_not_called()
        self.directory.refresh.assert_not_called()
        self.assertEqual(canonical(head),original)

    def test_stale_cache_must_refresh_before_skipping(self):
        from .consensus_directory import ConsensusUnavailable
        controller=self.controller(); self.addCleanup(controller.close)
        self.state['resources'][self.target]['record']['body']['expires_at']=int(time.time())+60
        self.directory.anchor.side_effect=[ConsensusUnavailable('stale'),{}]
        self.directory.refresh.reset_mock()
        self.assertEqual(controller.step(self.target)['state'],'fresh')
        self.directory.refresh.assert_called_once()
