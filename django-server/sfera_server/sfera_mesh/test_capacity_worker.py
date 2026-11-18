import threading
import unittest
from types import SimpleNamespace
from .capacity_worker import CapacityWorker


class CapacityWorkerTests(unittest.TestCase):
    def test_slow_probe_does_not_block_status_and_stop_waits_for_inflight_work(self):
        entered,release=threading.Event(),threading.Event()
        visited=[]
        def step(node):
            visited.append(node); entered.set()
            if not release.wait(2): raise TimeoutError('test release missing')
            return {'state':'waiting','error':'probe_timeout'}
        worker=CapacityWorker(SimpleNamespace(domains={'a':'x','b':'y'},step=step)).start()
        try:
            self.assertTrue(entered.wait(1))
            # Status never takes the coordinator lock held during its probe.
            for _ in range(100): self.assertTrue(worker.status()['running'])
            self.assertFalse(worker.stop(timeout=0))
            release.set()
            self.assertTrue(worker.stop(timeout=2))
            self.assertEqual(visited,['a'])
        finally:
            release.set(); worker.stop(timeout=2)

    def test_bounded_64_target_pass_is_fair_and_interval_stop_is_interruptible(self):
        finished=threading.Event(); visited=[]
        nodes={f'{i:064x}':'zone' for i in range(64)}
        def step(node):
            visited.append(node)
            if len(visited)==64: finished.set()
            return {'state':'fresh','error':None}
        worker=CapacityWorker(SimpleNamespace(domains=nodes,step=step),interval=10).start()
        try:
            self.assertTrue(finished.wait(2))
            self.assertTrue(worker.stop(timeout=2))
            self.assertEqual(visited,sorted(nodes))
            self.assertEqual(len(worker.status()['nodes']),64)
            status=worker.status(); status['nodes'][visited[0]]['state']='changed'
            self.assertEqual(worker.status()['nodes'][visited[0]]['state'],'fresh')
        finally: worker.stop(timeout=2)

    def test_unexpected_failure_is_visible_and_does_not_spin(self):
        failed=threading.Event(); calls=[]
        def step(node):
            calls.append(node); failed.set(); raise RuntimeError('private detail')
        worker=CapacityWorker(SimpleNamespace(domains={'a':'x'},step=step)).start()
        try:
            self.assertTrue(failed.wait(1))
            self.assertTrue(worker.stop(timeout=2))
            self.assertEqual(worker.status()['error'],'capacity_worker_failed')
            self.assertEqual(calls,['a'])
        finally: worker.stop(timeout=2)

    def test_duplicate_start_and_unbounded_inventory_rejected(self):
        with self.assertRaises(ValueError): CapacityWorker(SimpleNamespace(domains={}))
        worker=CapacityWorker(SimpleNamespace(domains={'a':'x'},step=lambda node:{'state':'fresh'})).start()
        try:
            with self.assertRaises(ValueError): worker.start()
        finally: self.assertTrue(worker.stop(timeout=2))
