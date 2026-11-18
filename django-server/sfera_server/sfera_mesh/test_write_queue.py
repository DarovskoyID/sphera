from contextlib import closing
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from . import test_publication
from .publication import ReplicaPublication
from .replication import ReplicaJournal
from .storage import canonical
from .write_queue import ConsensusWriteQueue, validate_write_queue, write_consent


class WriteQueueTests(unittest.TestCase):
    def setUp(self):
        base = test_publication.ReplicaPublicationTests(); base.setUp()
        self.addCleanup(base.doCleanups)
        self.base = base
        self.cluster, self.token, self.digest = base.cluster, 'b'*64, base.digest
        self.path = Path(base.temp.name)/'queue.sqlite'
        self.queue = ConsensusWriteQueue(self.path,base.publication)
        self.addCleanup(lambda:self.queue.close())
        self.fixture = base.fixture
        self.fixture.state['placement_history'] = {self.cluster:[self.fixture.state['placements'][self.cluster]]}

    def consent(self,endpoint,key,verifier,recipient,operation,payload):
        return write_consent(self.fixture.signers[recipient],payload,self.base.owner.store,verifier.recipient)

    def submit(self,reply=None):
        with patch('sfera_mesh.write_queue.exchange',side_effect=self.consent), \
             patch('sfera_mesh.write_queue.rpc',side_effect=reply or (lambda *args:{'code':0})):
            return self.queue.submit(self.cluster,self.token,self.digest,4)

    def record(self):
        return json.loads(self.queue.db.execute('SELECT record FROM write_outbox').fetchone()[0])

    def accept(self):
        record = self.record()
        self.fixture.state['write_queue'] = {record['body']['request_id']:{'record':record,
            'digest':sha256(canonical(record)).hexdigest(),'accepted_at':self.fixture.state['block_time']}}
        validate_write_queue(self.fixture.state,'lab')

    def test_three_holder_outbox_is_not_queued_until_verified_consensus(self):
        self.assertEqual(self.submit()['state'],'submitted')
        record = self.record()
        self.assertEqual(len(record['consents']),3)
        self.queue.close(); self.queue = ConsensusWriteQueue(self.path,self.base.publication)
        self.accept()
        with patch('sfera_mesh.write_queue.exchange') as consent, patch('sfera_mesh.write_queue.rpc') as broadcast:
            self.assertEqual(self.queue.submit(self.cluster,self.token,self.digest,4)['state'],'queued')
            consent.assert_not_called(); broadcast.assert_not_called()
        with self.assertRaisesRegex(ValueError,'immutable_write'):
            self.queue.submit(self.cluster,self.token,self.digest,5)

    def test_last_slot_reserved_in_consensus_rejects_competitor_before_signing(self):
        from .manifests import manifest_record
        values = {sha256(f'occupied-{index}'.encode()).hexdigest(): 1 for index in range(511)}
        record = manifest_record('lab', self.fixture.state['placements'][self.cluster], sorted(values),
            self.fixture.fixture.keys[:2], sizes=values)
        self.fixture.state['manifests'] = {self.cluster: {'record': record, 'digest': sha256(canonical(record)).hexdigest()}}
        self.submit(); self.accept()
        with patch('sfera_mesh.write_queue.exchange') as consent, patch('sfera_mesh.write_queue.rpc') as broadcast:
            with self.assertRaisesRegex(ValueError, 'capacity_exhausted'):
                self.queue.submit(self.cluster, 'c' * 64, sha256(b'competitor').hexdigest(), 4)
            consent.assert_not_called(); broadcast.assert_not_called()
        self.assertEqual(self.queue.db.execute('SELECT COUNT(*) FROM write_outbox').fetchone()[0], 1)
        self.assertEqual(self.submit()['state'], 'queued')

    def test_direct_manifest_holder_refuses_to_steal_reserved_slot(self):
        from .manifests import manifest_record, manifest_body
        values = {sha256(f'occupied-{index}'.encode()).hexdigest(): 1 for index in range(511)}
        placement = self.fixture.state['placements'][self.cluster]
        record = manifest_record('lab', placement, sorted(values), self.fixture.fixture.keys[:2], sizes=values)
        prior = {'record': record, 'digest': sha256(canonical(record)).hexdigest()}
        self.fixture.state['manifests'] = {self.cluster: prior}
        self.submit(); self.accept()
        values[sha256(b'competitor').hexdigest()] = 4
        body = manifest_body('lab', placement, sorted(values), version=2, previous=prior['digest'], sizes=values)
        sender = self.fixture.fixture.ids[0]
        with self.assertRaisesRegex(ValueError, 'capacity_exhausted'):
            self.fixture.signers[sender].manifest_consent({'body': body}, self.base.owner.store, sender)

    def test_signed_snapshot_cannot_overcommit_a_confirmed_queue_reservation(self):
        from .manifests import manifest_record
        self.submit(); self.accept()
        sizes = {sha256(f'occupied-{index}'.encode()).hexdigest(): 1 for index in range(512)}
        record = manifest_record('lab', self.fixture.state['placements'][self.cluster], sorted(sizes),
            self.fixture.fixture.keys[:2], sizes=sizes)
        self.fixture.state['manifests'] = {self.cluster: {'record': record, 'digest': sha256(canonical(record)).hexdigest()}}
        with self.assertRaisesRegex(ValueError, 'capacity_exhausted'): validate_write_queue(self.fixture.state, 'lab')

    def test_uncertain_broadcast_resumes_exact_signed_request(self):
        def lost(*args): raise OSError('lost reply')
        self.assertEqual(self.submit(lost)['state'],'waiting')
        record = self.record()
        self.queue.close(); self.queue = ConsensusWriteQueue(self.path,self.base.publication)
        with patch('sfera_mesh.write_queue.exchange') as consents,patch('sfera_mesh.write_queue.rpc',return_value={'code':0}):
            self.assertEqual(self.queue.submit(self.cluster,self.token,self.digest,4)['state'],'submitted')
            consents.assert_not_called()
        self.assertEqual(self.record(),record)

    def test_missing_third_holder_never_broadcasts_partial_request(self):
        failed = self.fixture.fixture.ids[2]
        def missing(*args):
            if args[3] == failed: raise OSError('offline')
            return self.consent(*args)
        with patch('sfera_mesh.write_queue.exchange',side_effect=missing),patch('sfera_mesh.write_queue.rpc') as broadcast:
            self.assertEqual(self.queue.submit(self.cluster,self.token,self.digest,4)['state'],'waiting')
            broadcast.assert_not_called()
        self.assertEqual(self.queue.db.execute('SELECT COUNT(*) FROM write_outbox').fetchone()[0],0)

    def test_holder_checks_bytes_sender_and_exact_size(self):
        self.submit(); body = self.record()['body']
        sender = body['origin']; signer = self.fixture.signers[sender]
        with self.assertRaisesRegex(ValueError,'holder_required'):
            write_consent(signer,{'body':body},self.base.owner.store,'a'*64)
        wrong = {**body,'size':5}
        with self.assertRaisesRegex(ValueError,'copy_mismatch'):
            write_consent(signer,{'body':wrong},self.base.owner.store,sender)

    def test_another_machine_without_source_journal_continues_committed_work(self):
        self.submit(); self.accept()
        self.queue.close(); self.base.journal.close()
        base = self.fixture.fixture
        verifier = SimpleNamespace(network='lab',recipient=base.ids[1],roster=self.base.owner.verifier.roster)
        journal = ReplicaJournal(Path(self.base.temp.name)/'second-machine.sqlite',base.keys[1],verifier,
                                 self.fixture.journal.endpoints,require_consensus=True)
        self.addCleanup(journal.close)
        head = self.base.directory.placement(self.cluster)
        with journal.db:
            journal.db.execute('INSERT INTO replica_trust VALUES(1,?)',(self.base.directory.pin,))
            journal.db.execute('INSERT INTO replica_clusters VALUES(?,?,?)',(self.cluster,1,canonical(head['record']['body']['members'])))
            journal.db.execute('INSERT INTO replica_confirmations VALUES(?,?,?,?)',(self.cluster,1,head['record_hash'],1))
        publication = ReplicaPublication(Path(self.base.temp.name)/'second-outboxes',self.base.directory,'http://127.0.0.1:9999',journal)
        queue = ConsensusWriteQueue(':memory:',publication); self.addCleanup(queue.close)
        with patch.object(journal,'_request',side_effect=self.base.request), \
             patch('sfera_mesh.manifest_publisher.exchange',side_effect=self.base.owner.consent), \
             patch('sfera_mesh.manifest_publisher.rpc',return_value={'code':0}):
            self.assertEqual(queue.step(self.cluster)['state'],'submitted')
        self.assertTrue(journal.status(self.cluster,self.digest)['replicated'])
        path = next(publication.path.glob('*.sqlite'))
        with closing(sqlite3.connect(path)) as db:
            record = json.loads(db.execute('SELECT record FROM manifest_job').fetchone()[0])
        self.assertEqual(record['body']['digests'],[self.digest])

    def test_local_unqueued_data_does_not_enter_queue_worker_index(self):
        self.submit(); self.accept()
        extra = self.base.journal.stage(self.cluster,b'xyz')
        with patch.object(self.base.journal,'_request',side_effect=self.base.request), \
             patch('sfera_mesh.manifest_publisher.exchange',side_effect=self.base.owner.consent), \
             patch('sfera_mesh.manifest_publisher.rpc',return_value={'code':0}):
            self.assertEqual(self.queue.step(self.cluster)['state'],'submitted')
        record = self.base.pending()
        self.assertEqual(record['body']['digests'],[self.digest])
        self.assertNotIn(extra,record['body']['digests'])

    def test_snapshot_corruption_and_wrong_context_are_rejected(self):
        self.submit(); self.accept()
        head = next(iter(self.fixture.state['write_queue'].values()))
        head['digest'] = '0'*64
        with self.assertRaisesRegex(ValueError,'digest_mismatch'):
            validate_write_queue(self.fixture.state,'lab')
        self.queue.close()
        with patch.object(self.base.directory,'pin','other'):
            with self.assertRaisesRegex(ValueError,'context_changed'):
                ConsensusWriteQueue(self.path,self.base.publication)

    def test_content_bound_completion_prunes_local_outbox_and_retries_without_rpc(self):
        from .manifests import manifest_record
        from .write_queue import content_request_id
        self.queue.content_bound = True
        self.assertEqual(self.submit()['state'], 'submitted')
        record = self.record()
        self.assertEqual(record['body']['domain'], 'sfera-mesh-write-v2')
        self.assertEqual(record['body']['request_id'], content_request_id('lab', self.cluster,
            record['body']['origin'], self.token, self.digest, 4))
        self.assertNotEqual(content_request_id('lab', self.cluster, record['body']['origin'], self.token, self.digest, 5), record['body']['request_id'])
        self.accept()
        manifest = manifest_record('lab', self.fixture.state['placements'][self.cluster],
            [self.digest], self.fixture.fixture.keys[:2], sizes={self.digest:4})
        self.fixture.state['manifests'] = {self.cluster:{'record':manifest,'digest':sha256(canonical(manifest)).hexdigest()}}
        self.fixture.state['write_queue'] = {}
        self.queue.close()
        self.queue = ConsensusWriteQueue(self.path, self.base.publication, content_bound=True)
        with patch('sfera_mesh.write_queue.exchange') as consent, patch('sfera_mesh.write_queue.rpc') as broadcast:
            for i in range(160):
                self.assertEqual(self.queue.submit(self.cluster, f'{i:064x}', self.digest, 4)['state'], 'queued')
            consent.assert_not_called(); broadcast.assert_not_called()
        self.assertEqual(self.queue.db.execute('SELECT COUNT(*) FROM write_outbox').fetchone()[0],0)

    def test_v2_opt_in_preserves_existing_legacy_identity(self):
        self.submit()
        old = self.record()
        self.queue.content_bound = True
        self.accept()
        self.assertEqual(self.submit()['request_id'], old['body']['request_id'])
        with self.assertRaisesRegex(ValueError, 'immutable_write'):
            self.queue.submit(self.cluster,self.token,self.digest,5)
        self.assertEqual(self.record(), old)

    def test_content_bound_lost_reply_reuses_exact_record_after_restart(self):
        self.queue.content_bound = True
        def lost(*args): raise OSError('lost reply')
        self.assertEqual(self.submit(lost)['state'], 'waiting')
        old = self.record()
        self.queue.close()
        self.queue = ConsensusWriteQueue(self.path, self.base.publication, content_bound=True)
        with patch('sfera_mesh.write_queue.exchange') as consent, patch('sfera_mesh.write_queue.rpc',return_value={'code':0}) as broadcast:
            self.assertEqual(self.queue.submit(self.cluster,self.token,self.digest,4)['state'], 'submitted')
            consent.assert_not_called()
            import base64
            self.assertEqual(base64.b64decode(broadcast.call_args.args[2]['tx']), canonical(old))

    def test_content_bound_identity_golden(self):
        from .write_queue import content_request_id
        self.assertEqual(content_request_id('lab','a'*64,'b'*64,'c'*64,'d'*64,4),
            '8e4098f57e36f4455bf43e5125b768d9f737010f89ead88b917ef1229797b05d')

    def test_ready_batch_requires_consensus_and_uses_one_fresh_snapshot(self):
        self.submit()
        requests = [{'cluster': self.cluster, 'block_token': self.token, 'digest': self.digest, 'size': 4}] * 64
        self.assertEqual(self.queue.ready_many(requests), [False] * 64)
        self.accept()
        with patch.object(self.base.directory, 'refresh', wraps=self.base.directory.refresh) as refresh, \
                patch('sfera_mesh.write_queue.exchange') as sign, patch('sfera_mesh.write_queue.rpc') as send:
            self.assertEqual(self.queue.ready_many(requests), [True] * 64)
            refresh.assert_called_once(); sign.assert_not_called(); send.assert_not_called()
        with self.assertRaisesRegex(ValueError, 'immutable_write'):
            self.queue.ready_many([{**requests[0], 'size': 5}])

    def test_ready_manifest_shortcut_is_content_bound_only(self):
        from .manifests import manifest_record
        manifest = manifest_record('lab', self.fixture.state['placements'][self.cluster], [self.digest],
            self.fixture.fixture.keys[:2], sizes={self.digest: 4})
        self.fixture.state['manifests'] = {self.cluster: {'record': manifest, 'digest': sha256(canonical(manifest)).hexdigest()}}
        requests = [{'cluster': self.cluster, 'block_token': self.token, 'digest': self.digest, 'size': 4}]
        self.assertEqual(self.queue.ready_many(requests), [False])
        self.queue.content_bound = True
        self.assertEqual(self.queue.ready_many(requests), [True])

    def test_ready_batch_rejects_changed_replica_trust(self):
        with self.base.journal.db: self.base.journal.db.execute("UPDATE replica_trust SET pin='different'")
        with self.assertRaisesRegex(ValueError, 'placement_trust_changed'):
            self.queue.ready_many([{'cluster': self.cluster, 'block_token': self.token, 'digest': self.digest, 'size': 4}])
