from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from .controller_runtime import ControllerLoop,ControllerRuntime,validate_policy,database_names


class ControllerRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.peers={str(i)*64:{'public_key':str(i)*64,'endpoint':f'https://peer-{i}.example:8443'} for i in range(1,5)}
        assessors={str(i+4)*64:{'observer':str(i)*64,'endpoint':self.peers[str(i)*64]['endpoint']} for i in range(1,5)}
        self.policy={'initial_count':1,'manifests':[{'cluster':'a'*64,'sizes':{'b'*64:128}}],
            'capacity':{'assessors':assessors,'failure_domains':{str(i)*64:'zone-'+str(i) for i in range(1,5)},'slots':2},
            'failure':{'assessors':assessors,'clusters':['a'*64]}}

    def test_explicit_bounded_policy_and_stable_database_names(self):
        self.assertIs(validate_policy(self.policy,self.peers),self.policy)
        names=database_names(self.policy);self.assertEqual(len(names),4);self.assertEqual(len(names),len(set(names)))
        other={**self.policy,'manifests':[{'cluster':'a'*64,'sizes':{'b'*64:129}}]}
        self.assertNotEqual(database_names(other),names)

    def test_unpinned_assessor_duplicate_observer_and_implicit_requests_refused(self):
        import copy
        for value in ({},{'initial_count':True},{'initial_count':5},{'manifests':[]},{'enabled':True}):
            with self.assertRaises(ValueError):validate_policy(value,self.peers)
        for field,new in (('endpoint','http://127.0.0.1:1234'),('observer','a'*64)):
            value=copy.deepcopy(self.policy);first=next(iter(value['capacity']['assessors'].values()));first[field]=new
            with self.assertRaises(ValueError):validate_policy(value,self.peers)
        value=copy.deepcopy(self.policy);items=list(value['failure']['assessors'].values());items[1].update(items[0])
        with self.assertRaises(ValueError):validate_policy(value,self.peers)

    def test_slow_capacity_does_not_block_failure_loop(self):
        entered=threading.Event();release=threading.Event();failure=threading.Event()
        def slow():entered.set();release.wait(2);return {'state':'waiting'}
        capacity=ControllerLoop('capacity',[('node',slow)],interval=.01)
        failures=ControllerLoop('failure',[('cluster',lambda:(failure.set() or {'state':'waiting'}))],interval=.01)
        capacity.start();failures.start()
        try:self.assertTrue(entered.wait(1));self.assertTrue(failure.wait(1))
        finally:release.set();capacity.stop();failures.stop()
        self.assertFalse(capacity.status()['running']);self.assertFalse(failures.status()['running'])

    def test_round_robin_and_safe_internal_error_status(self):
        done=threading.Event();seen=[]
        def one():seen.append('one');return {'state':'waiting'}
        def two():seen.append('two');done.set();raise RuntimeError('PRIVATE PAYLOAD MUST NOT LEAK')
        loop=ControllerLoop('manifest',[('one',one),('two',two)],interval=.01);loop.start()
        self.assertTrue(done.wait(1));loop.stop();result=loop.status()
        self.assertEqual(seen,['one','two']);self.assertEqual(result['error'],'controller_loop_failed');self.assertNotIn('PRIVATE',str(result))

    def test_factory_wires_all_roles_and_closes_after_worker_stop(self):
        class Journal:
            def __init__(self,*args,**kwargs):self.closed=False
            def step(self,*args):return {'state':'waiting'}
            def close(self):self.closed=True
        with tempfile.TemporaryDirectory() as folder:
            patches=[patch('sfera_mesh.controller_runtime.'+name,Journal) for name in ('InitialController','ManifestPublisher','CapacityRenewal','FailureCoordinator')]
            for item in patches:item.start();self.addCleanup(item.stop)
            runtime=ControllerRuntime(Path(folder),SimpleNamespace(endpoint_policy='https-v1'),'http://127.0.0.1:26657',None,None,self.peers,self.policy)
            runtime.start()
            try:
                self.assertEqual(set(runtime.status()['roles']),{'initial','manifest','capacity','failure'})
                self.assertTrue(runtime.status()['running']);self.assertEqual(len(runtime.controllers),4)
            finally:runtime.close()
            self.assertFalse(runtime.status()['running']);self.assertTrue(all(controller.closed for controller in runtime.controllers))

    def test_old_genesis_cannot_implicitly_enable_https_controllers(self):
        with self.assertRaisesRegex(ValueError,'genesis_https'):
            ControllerRuntime(Path('.'),SimpleNamespace(endpoint_policy=''),'http://127.0.0.1:26657',None,None,self.peers,self.policy)


if __name__=='__main__':unittest.main()
