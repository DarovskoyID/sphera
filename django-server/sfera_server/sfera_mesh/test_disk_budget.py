from hashlib import sha256
from pathlib import Path
import tempfile
import sqlite3
import unittest
from unittest.mock import patch
from .disk_budget import DiskBudget
from .transport import BlobStore
from .capacity import CapacitySampler


class DiskBudgetTests(unittest.TestCase):
    def test_restored_copy_cannot_silently_account_the_original_database_path(self):
        with tempfile.TemporaryDirectory() as temp:
            original=Path(temp)/'original.sqlite3'
            store=BlobStore(original,max_bytes=100,disk_budget=DiskBudget([original],8*1024*1024,65536))
            store.close()
            copied=Path(temp)/'restored.sqlite3'
            copied.write_bytes(original.read_bytes())
            with self.assertRaisesRegex(ValueError,'database_path_changed'):BlobStore(copied)

    def test_real_sqlite_index_wal_growth_is_seen_even_with_cached_disk_probe(self):
        with tempfile.TemporaryDirectory() as temp:
            blob,index=Path(temp)/'blob.sqlite3',Path(temp)/'index.sqlite3'
            store=BlobStore(blob,max_bytes=64*1024*1024,disk_budget=DiskBudget([blob,index],8*1024*1024,65536))
            db=sqlite3.connect(index)
            try:
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('CREATE TABLE entries(value BLOB)');db.commit()
                sampler=CapacitySampler(temp,budget=store)
                before=sampler.sample()['free_bytes']
                db.execute('INSERT INTO entries VALUES(?)',(b'index pages'*10000,));db.commit()
                self.assertTrue(Path(str(index)+'-wal').exists())
                after=sampler.sample()['free_bytes']
                self.assertLess(after,before)
                self.assertEqual(after,store.usage()['available_bytes'])
                measured=store.audit_usage()['disk']['managed_bytes']
                self.assertGreaterEqual(measured,index.stat().st_size+Path(str(index)+'-wal').stat().st_size)
            finally:db.close();store.close()
    def test_indexes_wal_and_future_headroom_reduce_offered_capacity(self):
        with tempfile.TemporaryDirectory() as temp:
            blob,index=Path(temp)/'blob.sqlite3',Path(temp)/'index.sqlite3'
            policy=DiskBudget([blob,index],8*1024*1024,65536)
            store=BlobStore(blob,max_bytes=64*1024*1024,disk_budget=policy)
            try:
                first=store.usage()['available_bytes']
                index.write_bytes(b'i'*65536)
                Path(str(index)+'-wal').write_bytes(b'w'*131072)
                after=store.usage()['available_bytes']
                self.assertEqual(first-after,196608)
                store.reserve_growth('a'*64,'b'*64,'c'*64,262144)
                self.assertEqual(store.usage()['available_bytes'],after-262144)
                report=store.audit_usage()['disk']
                self.assertGreaterEqual(report['managed_bytes'],196608)
                self.assertEqual(report['metadata_reserve_bytes'],65536)
                sample=CapacitySampler(temp,budget=store).sample()
                self.assertLessEqual(sample['free_bytes'],store.usage()['available_bytes'])
            finally:store.close()
            store=BlobStore(blob)
            try:
                self.assertEqual(store.disk_budget.config(),policy.config())
                changed=DiskBudget([blob,index],16*1024*1024,65536)
                with self.assertRaisesRegex(ValueError,'policy_changed'):BlobStore(blob,disk_budget=changed)
            finally:store.close()

    def test_physical_write_failure_rolls_back_growth_debit(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'blob.sqlite3'
            policy=DiskBudget([path],8*1024*1024,65536)
            store=BlobStore(path,max_bytes=100,disk_budget=policy)
            try:
                store.reserve_growth('a'*64,'b'*64,'c'*64,10)
                before=store.growth_budget('a'*64,'b'*64)
                with patch.object(store.disk_budget,'require',side_effect=ValueError('disk full')):
                    with self.assertRaises(ValueError):
                        store.execute('put',{'digest':sha256(b'abcd').hexdigest(),'ciphertext':b'abcd'.hex(),'growth':{'cluster':'a'*64,'budget':'b'*64}})
                self.assertEqual(before,store.growth_budget('a'*64,'b'*64))
                self.assertEqual(store.usage()['used_bytes'],0)
                self.assertEqual(store.db.execute('SELECT COUNT(*) FROM blob_growth_spends').fetchone()[0],0)
            finally:store.close()

    def test_volume_free_space_and_duplicate_managed_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'blob.sqlite3'
            with self.assertRaises(ValueError):DiskBudget([path,path],10000,100)
            policy=DiskBudget([path],10000,100)
            with patch('sfera_mesh.disk_budget.shutil.disk_usage',return_value=type('Usage',(),{'free':1000})()):
                self.assertEqual(policy.sample(200)['available_bytes'],700)
                with self.assertRaises(ValueError):policy.require(701,200)
