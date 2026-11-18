from hashlib import sha256
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import threading
import time
from types import SimpleNamespace
import unittest
from urllib.error import HTTPError
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .identity import EnvelopeVerifier, node_id
from .transport import BlobStore, LabServer, exchange


def put(store,data):
    return store.execute('put',{'digest':sha256(data).hexdigest(),'ciphertext':data.hex()})


class BlobQuotaTests(unittest.TestCase):
    def test_owner_bound_failure_rolls_back_new_reservation(self):
        store=BlobStore(':memory:',max_bytes=10); self.addCleanup(store.close)
        digest=sha256(b'abcd').hexdigest(); extra=sha256(b'xy').hexdigest()
        store.reserve_blocks({digest:4})
        with store.db:
            store.db.executemany('INSERT INTO blob_reservation_owners VALUES(?,?)',[(str(i),digest) for i in range(511)])
        with self.assertRaisesRegex(ValueError,'owner_limit'):
            store.reserve_blocks({extra:2},cluster='a'*64,plan='b'*64)
        self.assertEqual(store.usage()['available_bytes'],6)
        self.assertEqual(store.db.execute('SELECT COUNT(*) FROM blob_reservations').fetchone()[0],1)
        self.assertEqual(store.db.execute('SELECT COUNT(*) FROM blob_reservation_owners').fetchone()[0],512)

    def test_existing_unowned_reserve_migrates_to_local_owner(self):
        with TemporaryDirectory() as temp:
            path=str(Path(temp)/'blobs.sqlite'); store=BlobStore(path,max_bytes=6)
            digest=sha256(b'abcd').hexdigest(); store.reserve_blocks({digest:4})
            with store.db: store.db.execute('DROP TABLE blob_reservation_owners')
            store.close(); store=BlobStore(path)
            try:
                self.assertEqual(store.usage()['available_bytes'],2)
                store.release_blocks([digest])
                self.assertEqual(store.usage()['available_bytes'],6)
            finally: store.close()

    def test_cluster_plan_owners_share_bytes_and_cannot_cancel_each_other(self):
        with TemporaryDirectory() as temp:
            path=str(Path(temp)/'blobs.sqlite'); store=BlobStore(path,max_bytes=6)
            digest=sha256(b'abcd').hexdigest()
            a={'cluster':'a'*64,'plan':'1'*64}; b={'cluster':'b'*64,'plan':'2'*64}
            store.reserve_blocks({digest:4},**a); store.reserve_blocks({digest:4},**b)
            self.assertEqual(store.usage()['available_bytes'],2)
            store.close(); store=BlobStore(path)
            try:
                store.release_blocks([digest])
                store.release_blocks([digest],cluster='a'*64,plan='3'*64)
                self.assertEqual(store.usage()['available_bytes'],2)
                store.release_blocks([digest],**a)
                self.assertEqual(store.usage()['available_bytes'],2)
                store.release_blocks([digest],**b)
                self.assertEqual(store.usage()['available_bytes'],6)
                store.reserve_blocks({digest:4},**a); store.reserve_blocks({digest:4},**b)
                put(store,b'abcd')
                self.assertEqual(store.db.execute('SELECT COUNT(*) FROM blob_reservation_owners').fetchone()[0],0)
                self.assertEqual(store.usage()['used_bytes'],4)
            finally: store.close()

    def test_digest_reservations_survive_reopen_and_protect_headroom(self):
        with TemporaryDirectory() as temp:
            path=str(Path(temp)/'blobs.sqlite')
            digest=sha256(b'abcd').hexdigest()
            store=BlobStore(path,max_bytes=6)
            self.assertEqual(store.reserve_blocks({digest:4}),{'reserved_bytes':4,'blocks':1})
            store.close(); store=BlobStore(path)
            try:
                self.assertEqual(store.usage()['available_bytes'],2)
                self.assertEqual(store.reserve_blocks({digest:4})['reserved_bytes'],4)
                with self.assertRaisesRegex(ValueError,'size_conflict'): store.reserve_blocks({digest:3})
                with self.assertRaisesRegex(ValueError,'byte_limit_exceeded'): put(store,b'xyz')
                put(store,b'xy'); put(store,b'abcd')
                self.assertEqual(store.usage()['used_bytes'],6)
                self.assertEqual(store.db.execute('SELECT COUNT(*) FROM blob_reservations').fetchone()[0],0)
                put(store,b'abcd')
            finally: store.close()

    def test_reservation_batch_is_atomic_and_release_does_not_delete_data(self):
        store=BlobStore(':memory:',max_bytes=6); self.addCleanup(store.close)
        digest=sha256(b'abcd').hexdigest()
        with self.assertRaisesRegex(ValueError,'byte_limit_exceeded'):
            store.reserve_blocks({digest:4,sha256(b'xyz').hexdigest():3})
        self.assertEqual(store.usage()['available_bytes'],6)
        store.reserve_blocks({digest:4})
        store.release_blocks([digest]); self.assertEqual(store.usage()['available_bytes'],6)
        put(store,b'abcd'); store.release_blocks([digest])
        self.assertEqual(store.usage()['used_bytes'],4)

    def test_two_connections_cannot_overreserve_and_sql_writer_preserves_reserve(self):
        with TemporaryDirectory() as temp:
            path=str(Path(temp)/'blobs.sqlite')
            stores=[BlobStore(path,max_bytes=6),BlobStore(path)]
            barrier=threading.Barrier(2); results=[]
            def reserve(store,data):
                barrier.wait()
                try: store.reserve_blocks({sha256(data).hexdigest():4}); results.append('reserved')
                except ValueError as exc: results.append(str(exc))
            threads=[threading.Thread(target=reserve,args=(s,d)) for s,d in zip(stores,(b'aaaa',b'bbbb'))]
            try:
                for thread in threads: thread.start()
                for thread in threads: thread.join(6)
                self.assertTrue(all(not t.is_alive() for t in threads))
                self.assertEqual(sorted(results),['blob_byte_limit_exceeded','reserved'])
                with self.assertRaisesRegex(sqlite3.IntegrityError,'byte_limit_exceeded'):
                    with stores[1].db: stores[1].db.execute('INSERT INTO blobs VALUES(?,?)',('unreserved',b'xyz'))
                self.assertEqual(stores[0].usage()['available_bytes'],2)
            finally:
                for store in stores: store.close()

    def test_explicit_audit_detects_corrupt_accounting_without_repair(self):
        store=BlobStore(':memory:',max_bytes=10); self.addCleanup(store.close)
        put(store,b'abcd'); put(store,b'xy')
        self.assertTrue(store.audit_usage()['consistent'])
        with store.db:
            store.db.execute('UPDATE blob_usage SET used_bytes=5')
            # Preserve the total while making per-block sizes incorrect.
            store.db.execute('UPDATE blob_sizes SET size=3')
        audit=store.audit_usage()
        self.assertFalse(audit['consistent'])
        self.assertEqual((audit['actual_bytes'],audit['indexed_bytes'],audit['accounted_bytes']),(6,6,5))
        self.assertEqual(audit['mismatched_rows'],2)
        self.assertEqual(store.usage()['used_bytes'],5)
        with store.db:
            store.db.execute('DELETE FROM blob_sizes')
            store.db.execute('INSERT INTO blob_sizes VALUES(?,?)',('orphan',6))
        self.assertEqual(store.audit_usage()['mismatched_rows'],3)
        self.assertEqual(store.execute('get',{'digest':sha256(b'abcd').hexdigest()})['ciphertext'],b'abcd'.hex())

    def test_previous_counter_schema_is_rebuilt_once_during_upgrade(self):
        with TemporaryDirectory() as temp:
            path=str(Path(temp)/'blobs.sqlite')
            db=sqlite3.connect(path)
            db.executescript('CREATE TABLE blobs(digest TEXT PRIMARY KEY,data BLOB NOT NULL); CREATE TABLE blob_limits(singleton INTEGER PRIMARY KEY,max_bytes INTEGER); INSERT INTO blob_limits VALUES(1,10); CREATE TABLE blob_usage(singleton INTEGER PRIMARY KEY,used_bytes INTEGER); INSERT INTO blob_usage VALUES(1,9);')
            db.execute('INSERT INTO blobs VALUES(?,?)',(sha256(b'abcd').hexdigest(),b'abcd'))
            db.commit(); db.close()
            store=BlobStore(path)
            try:
                self.assertEqual(store.usage()['used_bytes'],4)
                put(store,b'abcd'); put(store,b'xy')
                self.assertEqual(store.usage()['used_bytes'],6)
            finally: store.close()

    def test_replace_tracks_delta_with_and_without_recursive_delete_triggers(self):
        for recursive in (0,1):
            with self.subTest(recursive=recursive),TemporaryDirectory() as temp:
                path=str(Path(temp)/'blobs.sqlite')
                store=BlobStore(path,max_bytes=8); writer=sqlite3.connect(path)
                try:
                    writer.execute('PRAGMA recursive_triggers='+str(recursive))
                    put(store,b'abcd')
                    digest=sha256(b'abcd').hexdigest()
                    for data in (b'ab',b'abcdef',b'abcdef'):
                        with writer: writer.execute('INSERT OR REPLACE INTO blobs VALUES(?,?)',(digest,data))
                        self.assertEqual(store.usage()['used_bytes'],len(data))
                    with self.assertRaisesRegex(sqlite3.IntegrityError,'byte_limit_exceeded'):
                        with writer: writer.execute('INSERT OR REPLACE INTO blobs VALUES(?,?)',(digest,b'123456789'))
                    self.assertEqual(store.usage()['used_bytes'],6)
                    put(store,b'abcd')
                    self.assertEqual(store.usage()['used_bytes'],4)
                    with self.assertRaises(RuntimeError):
                        with writer:
                            writer.execute('INSERT OR REPLACE INTO blobs VALUES(?,?)',(digest,b'x'))
                            raise RuntimeError('rollback')
                    self.assertEqual(store.usage()['used_bytes'],4)
                finally: writer.close(); store.close()

    def test_independent_legacy_writer_cannot_bypass_persisted_quota(self):
        with TemporaryDirectory() as temp:
            path=str(Path(temp)/'blobs.sqlite')
            store=BlobStore(path,max_bytes=4)
            writer=sqlite3.connect(path)
            try:
                put(store,b'abcd')
                for sql,args in (
                    ('INSERT INTO blobs VALUES(?,?)',('extra',b'x')),
                    ('UPDATE blobs SET data=?',(b'abcde',)),
                ):
                    with self.assertRaisesRegex(sqlite3.IntegrityError,'blob_byte_limit_exceeded'):
                        with writer: writer.execute(sql,args)
                    self.assertEqual(store.usage()['used_bytes'],4)
                # Maintenance shrinking and the following growth stay accounted.
                with writer: writer.execute('UPDATE blobs SET data=?',(b'ab',))
                self.assertEqual(store.usage()['available_bytes'],2)
                with writer: writer.execute('INSERT INTO blobs VALUES(?,?)',('extra',b'xy'))
                self.assertEqual(store.usage()['used_bytes'],4)
            finally: writer.close(); store.close()

    def test_usage_migration_and_transaction_rollback(self):
        with TemporaryDirectory() as temp:
            path=str(Path(temp)/'blobs.sqlite')
            db=sqlite3.connect(path)
            db.execute('CREATE TABLE blobs(digest TEXT PRIMARY KEY,data BLOB NOT NULL)')
            db.execute('INSERT INTO blobs VALUES(?,?)',(sha256(b'abcd').hexdigest(),b'abcd'))
            db.commit(); db.close()
            store=BlobStore(path,max_bytes=10)
            try:
                self.assertEqual(store.usage()['used_bytes'],4)
                with self.assertRaises(RuntimeError):
                    with store.db:
                        store.db.execute('UPDATE blobs SET data=?',(b'xx',))
                        self.assertEqual(store.usage()['used_bytes'],2)
                        raise RuntimeError('rollback')
                self.assertEqual(store.usage()['used_bytes'],4)
                with store.db: store.db.execute('DELETE FROM blobs')
                self.assertEqual(store.usage()['used_bytes'],0)
                put(store,b'abc')
            finally: store.close()
            store=BlobStore(path)
            try: self.assertEqual(store.usage()['used_bytes'],3)
            finally: store.close()

    def test_quota_checks_do_not_scan_all_blobs_after_migration(self):
        store=BlobStore(':memory:',max_bytes=10); self.addCleanup(store.close)
        statements=[]
        store.db.set_trace_callback(statements.append)
        put(store,b'abc'); put(store,b'abc'); store.usage()
        self.assertFalse(any('SUM(' in statement.upper() and
                             ('FROM BLOBS' in statement.upper() or 'FROM BLOB_SIZES' in statement.upper())
                             for statement in statements))
        self.assertEqual(store.usage()['used_bytes'],3)

    def test_full_store_rejects_growth_but_preserves_reads_and_idempotent_put(self):
        store=BlobStore(':memory:',max_bytes=4); self.addCleanup(store.close)
        put(store,b'abcd'); put(store,b'abcd')
        with self.assertRaisesRegex(ValueError,'byte_limit_exceeded'): put(store,b'x')
        self.assertEqual(store.usage(),{'used_bytes':4,'max_bytes':4,'available_bytes':0})
        self.assertEqual(store.execute('get',{'digest':sha256(b'abcd').hexdigest()})['ciphertext'],b'abcd'.hex())

    def test_limit_survives_reopen_and_cannot_be_silently_changed(self):
        with TemporaryDirectory() as temp:
            path=str(Path(temp)/'blobs.sqlite')
            store=BlobStore(path,max_bytes=4); put(store,b'abcd'); store.close()
            with self.assertRaisesRegex(ValueError,'limit_changed'): BlobStore(path,max_bytes=8)
            store=BlobStore(path)
            try:
                self.assertEqual(store.usage()['max_bytes'],4)
                with self.assertRaises(ValueError): put(store,b'x')
            finally: store.close()

    def test_two_connections_cannot_race_past_the_limit(self):
        with TemporaryDirectory() as temp:
            path=str(Path(temp)/'blobs.sqlite')
            stores=[BlobStore(path,max_bytes=10),BlobStore(path,max_bytes=10)]
            barrier=threading.Barrier(2); results=[]
            def write(store,data):
                barrier.wait()
                try: put(store,data); results.append('stored')
                except ValueError as exc: results.append(str(exc))
            threads=[threading.Thread(target=write,args=(store,data)) for store,data in zip(stores,(b'aaaaaa',b'bbbbbb'))]
            try:
                for thread in threads: thread.start()
                for thread in threads: thread.join(6)
                self.assertTrue(all(not thread.is_alive() for thread in threads))
                self.assertEqual(sorted(results),['blob_byte_limit_exceeded','stored'])
                self.assertEqual(stores[0].usage()['used_bytes'],6)
            finally:
                for store in stores: store.close()

    def test_healing_accounts_for_replaced_corrupt_bytes(self):
        store=BlobStore(':memory:',max_bytes=4); self.addCleanup(store.close)
        put(store,b'abcd')
        with store.db: store.db.execute('UPDATE blobs SET data=?',(b'bad',))
        put(store,b'abcd')
        self.assertEqual(store.usage()['used_bytes'],4)

    def test_legacy_store_is_not_truncated_to_fit(self):
        with TemporaryDirectory() as temp:
            path=str(Path(temp)/'blobs.sqlite')
            db=sqlite3.connect(path)
            db.execute('CREATE TABLE blobs(digest TEXT PRIMARY KEY,data BLOB NOT NULL)')
            db.execute('INSERT INTO blobs VALUES(?,?)',(sha256(b'abcd').hexdigest(),b'abcd'))
            db.commit(); db.close()
            with self.assertRaisesRegex(ValueError,'existing_blobs_exceed'): BlobStore(path,max_bytes=3)
            store=BlobStore(path,max_bytes=4)
            try: self.assertEqual(store.usage()['used_bytes'],4)
            finally: store.close()

    def test_http_write_rejection_and_measurement_headroom(self):
        keys=[Ed25519PrivateKey.generate() for _ in range(2)]
        ids=[node_id(key.public_key().public_bytes_raw()) for key in keys]
        roster=dict(zip(ids,[key.public_key().public_bytes_raw() for key in keys]))
        checks=[EnvelopeVerifier('lab',identity,roster,':memory:') for identity in ids]
        store=BlobStore(':memory:',max_bytes=4)
        sampler=SimpleNamespace(sample=lambda:{'free_bytes':1000000,'disk_bytes_per_second':1000000,'sampled_at':int(time.time())})
        server=LabServer(keys[1],checks[1],store,capacity_sampler=sampler)
        thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        try:
            payload={'digest':sha256(b'abcd').hexdigest(),'ciphertext':b'abcd'.hex()}
            exchange(server.endpoint,keys[0],checks[0],ids[1],'put',payload)
            try:
                exchange(server.endpoint,keys[0],checks[0],ids[1],'put',{'digest':sha256(b'x').hexdigest(),'ciphertext':b'x'.hex()})
                self.fail('quota bypassed over HTTP')
            except HTTPError as exc: exc.close()
            probe=exchange(server.endpoint,keys[0],checks[0],ids[1],'capacity-probe',{'challenge':'a'*64,'data':'00'*32768})
            self.assertEqual(probe['sample']['free_bytes'],0)
            self.assertEqual(exchange(server.endpoint,keys[0],checks[0],ids[1],'get',{'digest':payload['digest']})['ciphertext'],payload['ciphertext'])
        finally:
            server.shutdown(); server.server_close(); thread.join(2)
            store.close()
            for check in checks: check.close()
