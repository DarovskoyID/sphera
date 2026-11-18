from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import threading
import unittest
from unittest.mock import patch
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .capacity import CapacitySampler, CapacityPolicy, measure_capacity, measured_resource_consent
from .storage import canonical


class CapacityTests(unittest.TestCase):
    def test_bounded_disk_sample_preserves_existing_storage(self):
        with TemporaryDirectory() as temp:
            existing = Path(temp)/'keep.bin'
            existing.write_bytes(b'existing ciphertext')
            sampler = CapacitySampler(temp)
            sample = sampler.sample()
            self.assertGreaterEqual(sample['free_bytes'],0)
            self.assertGreater(sample['disk_bytes_per_second'],0)
            self.assertEqual(sampler.sample(),sample)
            self.assertEqual(existing.read_bytes(),b'existing ciphertext')
            self.assertEqual(list(Path(temp).iterdir()),[existing])

    def test_thresholds_are_explicit_and_samples_must_be_fresh(self):
        for args in ((0,1,1),(1,True,1),(1,1,1,-1)):
            with self.assertRaises(ValueError): CapacityPolicy(*args)
        result = {'sample':{'free_bytes':100,'disk_bytes_per_second':100,'sampled_at':1000}}
        with patch('sfera_mesh.capacity.exchange',return_value=result), patch('sfera_mesh.capacity.time.time',return_value=1000):
            measured = measure_capacity('http://127.0.0.1:1',None,None,'a'*64,CapacityPolicy(1000,1,1))
            self.assertEqual(measured['capacity_slots'],0)
            measured = measure_capacity('http://127.0.0.1:1',None,None,'a'*64,CapacityPolicy(1000,1,1),memberships=1)
            self.assertEqual(measured['capacity_slots'],1)
        with patch('sfera_mesh.capacity.exchange',return_value=result), patch('sfera_mesh.capacity.time.time',return_value=1100):
            with self.assertRaises(ValueError): measure_capacity('http://127.0.0.1:1',None,None,'a'*64,CapacityPolicy(1,1,1))

    def test_each_assessor_rechecks_proposal_after_measuring(self):
        key = Ed25519PrivateKey.generate()
        public = key.public_key().public_bytes_raw()
        state = {'candidates':{'a'*64:{'digest':'b'*64,'record':{'body':{'available':True,'license':{'claims':{'expires_at':1300}}}}}},'placements':{}}
        directory = SimpleNamespace(network='lab',lock=threading.RLock(),anchor=lambda:None,current={'state':state},placement_assessors={sha256(public).hexdigest():public.hex()})
        body = {'domain':'sfera-mesh-resource-v1','network':'lab','node_id':'a'*64,'candidate_hash':'b'*64,'version':1,'previous':'0'*64,'failure_domain':'zone','capacity_slots':2,'issued_at':1000,'expires_at':1050}
        args = (directory,key,None,None,{'a'*64:'http://127.0.0.1:1'},{'a'*64:'zone'},CapacityPolicy(1,1,1))
        with patch('sfera_mesh.capacity.time.time',return_value=1000), patch('sfera_mesh.capacity.measure_capacity',return_value={'capacity_slots':2}):
            consent = measured_resource_consent(body,*args)
            key.public_key().verify(bytes.fromhex(consent['signature']),canonical(body))
            with self.assertRaisesRegex(ValueError,'healthy_measurement'):
                measured_resource_consent({**body,'capacity_slots':0},*args)
        def changed(*_args,**_kwargs):
            state['candidates']['a'*64]['digest'] = 'c'*64
            return {'capacity_slots':2}
        with patch('sfera_mesh.capacity.time.time',return_value=1000), patch('sfera_mesh.capacity.measure_capacity',side_effect=changed):
            with self.assertRaisesRegex(ValueError,'changed_or_expired'): measured_resource_consent(body,*args)
