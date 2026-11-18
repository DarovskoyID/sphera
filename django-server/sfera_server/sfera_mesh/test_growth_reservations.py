from hashlib import sha256
from pathlib import Path
import sqlite3
import tempfile
import unittest
from .transport import BlobStore


class GrowthReservationTests(unittest.TestCase):
    cluster='a'*64
    budget='b'*64
    placement='c'*64

    def put(self,store,data,growth=True):
        payload={'digest':sha256(data).hexdigest(),'ciphertext':data.hex()}
        if growth:payload['growth']={'cluster':self.cluster,'budget':self.budget}
        return store.execute('put',payload)

    def test_unknown_future_ciphertext_reserved_then_consumed_and_retry_not_refilled(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'store.sqlite3'
            store=BlobStore(path,max_bytes=12)
            try:
                store.reserve_growth(self.cluster,self.budget,self.placement,8)
                self.assertEqual(store.usage()['available_bytes'],4)
                self.put(store,b'abcd')
                self.assertEqual(store.growth_budget(self.cluster,self.budget)['remaining_bytes'],4)
                self.put(store,b'abcd')
                self.assertEqual(store.growth_budget(self.cluster,self.budget)['remaining_bytes'],4)
                self.assertEqual(store.reserve_growth(self.cluster,self.budget,self.placement,8)['remaining_bytes'],4)
            finally:store.close()
            store=BlobStore(path)
            try:
                self.assertEqual(store.growth_budget(self.cluster,self.budget)['remaining_bytes'],4)
                self.put(store,b'efgh')
                self.assertEqual(store.growth_budget(self.cluster,self.budget)['remaining_bytes'],0)
                with self.assertRaisesRegex(ValueError,'exhausted'):self.put(store,b'i')
                self.assertTrue(store.audit_usage()['consistent'])
                self.assertTrue(store.audit_usage()['within_limit'])
            finally:store.close()

    def test_plain_and_direct_sql_writers_cannot_steal_reserved_growth(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'store.sqlite3';store=BlobStore(path,max_bytes=8)
            try:
                store.reserve_growth(self.cluster,self.budget,self.placement,8)
                with self.assertRaises(ValueError):self.put(store,b'plain',False)
                other=sqlite3.connect(path)
                try:
                    with self.assertRaises(sqlite3.IntegrityError):
                        with other:other.execute('INSERT INTO blobs VALUES(?,?)',(sha256(b'raw').hexdigest(),b'raw'))
                finally:other.close()
                with self.assertRaises(ValueError):store.reserve_blocks({sha256(b'later').hexdigest():5})
                self.assertEqual(store.usage()['available_bytes'],0)
                self.put(store,b'abcd')
            finally:store.close()

    def test_closed_budget_retry_never_reopens_and_cannot_spend_other_owner(self):
        store=BlobStore(':memory:',max_bytes=8);self.addCleanup(store.close)
        store.reserve_growth(self.cluster,self.budget,self.placement,4)
        with self.assertRaises(ValueError):store.reserve_growth(self.cluster,self.budget,self.placement,5)
        with self.assertRaises(ValueError):store.reserve_growth(self.cluster,self.budget,'d'*64,4)
        store.release_growth(self.cluster,'d'*64)
        self.assertEqual(store.usage()['available_bytes'],4)
        store.release_growth(self.cluster,self.budget)
        self.assertEqual(store.usage()['available_bytes'],8)
        self.assertTrue(store.reserve_growth(self.cluster,self.budget,self.placement,4)['closed'])
        with self.assertRaisesRegex(ValueError,'closed'):self.put(store,b'abcd')

    def test_independent_connections_cannot_oversell_growth(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'store.sqlite3'
            first=BlobStore(path,max_bytes=8);second=BlobStore(path)
            try:
                first.reserve_growth(self.cluster,self.budget,self.placement,5)
                with self.assertRaises(ValueError):second.reserve_growth('d'*64,'e'*64,'f'*64,4)
                self.assertEqual(second.usage()['available_bytes'],3)
                second.reserve_growth('d'*64,'e'*64,'f'*64,3)
                self.assertEqual(first.usage()['available_bytes'],0)
            finally:first.close();second.close()
