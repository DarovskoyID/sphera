from hashlib import sha256
from dataclasses import replace
import json
import unittest
from unittest.mock import patch
from . import test_replacement
from .identity import EnvelopeVerifier
from .replication import ReplicaJournal
from .replacement import replacement_proposal
from .storage import canonical


class PreparationTests(unittest.TestCase):
    def test_sized_index_above_128_reserves_and_copies_in_batches(self):
        from .transport import BlobStore
        data={sha256(str(index).encode()).hexdigest():str(index).encode() for index in range(129)}
        self.publish_manifest(sorted(data),sizes={digest:len(value) for digest,value in data.items()})
        with self.journal.db:self.journal.db.execute('INSERT INTO replica_preparation_reservations VALUES(1)')
        store=BlobStore(':memory:',max_bytes=sum(map(len,data.values())))
        self.addCleanup(store.close)
        trace=[]
        def request(node,operation,body):
            trace.append(operation)
            if operation=='placement-reserve':return self.fixture.signers[self.target].reserve(body,store,self.journal.verifier.recipient)
            if node==self.target:return store.execute(operation,body)
            return {'digest':body['digest'],'ciphertext':data[body['digest']].hex()}
        with patch.object(self.journal,'_request',side_effect=request):
            for _ in range(32):
                status=self.journal.prepare_replacement(self.directory,self.proposal,limit=16)
                if status['ready']:break
        self.assertTrue(status['ready'],status)
        self.assertEqual(trace[0],'placement-reserve')
        self.assertEqual(store.db.execute('SELECT COUNT(*) FROM blobs').fetchone()[0],129)
        self.assertEqual(store.audit_usage()['reserved_bytes'],0)

    def test_multiple_skipped_manifest_versions_release_through_durable_cleanup(self):
        from .transport import BlobStore
        from .manifests import manifest_record
        from .manifest_ancestry import lineage_root, ancestor_proof
        store=BlobStore(':memory:',max_bytes=8);self.addCleanup(store.close)
        digest=self.journal.stage(self.cluster,b'abcd');self.publish_manifest([digest])
        old=json.loads(canonical(self.proposal));signer=self.fixture.signers[self.target]
        sender=self.journal.verifier.recipient
        with self.journal.db:self.journal.db.execute('INSERT INTO replica_preparation_reservations VALUES(1)')
        def interrupted(node,operation,body):
            if operation=='placement-reserve':return signer.reserve(body,store,sender)
            if operation=='get':return {'error':'not_found'}
            return None
        with patch.object(self.journal,'_request',side_effect=interrupted):
            self.assertFalse(self.journal.prepare_replacement(self.directory,old)['ready'])
        hashes=[self.fixture.state['manifests'][self.cluster]['digest']]
        placement=self.fixture.state['placements'][self.cluster]
        for version in range(2,8):
            record=manifest_record('lab',placement,[digest],self.fixture.fixture.keys[:2],version=version,previous=hashes[-1])
            hashes.append(sha256(canonical(record)).hexdigest())
        self.fixture.state['manifests'][self.cluster]={'record':record,'digest':hashes[-1]}
        self.fixture.state['manifest_lineage']={self.cluster:{'first':1,'hashes':hashes,'root':lineage_root('lab',self.cluster,1,hashes)}}
        with self.assertRaisesRegex(ValueError,'finalized_transition'):
            signer.release({'proposal':old,'digests':[digest]},store,sender)
        evidence=ancestor_proof(self.fixture.state,'lab',self.cluster,hashes[0])
        forged=json.loads(canonical(evidence));forged['path'][0]='0'*64
        with self.assertRaises(ValueError):
            signer.release({'proposal':old,'digests':[digest],'ancestry':forged},store,sender)
        self.assertEqual(store.usage()['available_bytes'],4)
        def release(node,operation,payload):
            self.assertIn('ancestry',payload)
            self.assertLessEqual(len(payload['ancestry']['path']),3)
            return signer.release(payload,store,sender)
        with patch.object(self.journal,'_request',side_effect=release):
            self.assertEqual(self.journal.release_preparation_reservations(self.directory),{'released':1,'pending':0})
        self.assertEqual(store.usage()['available_bytes'],8)

    def test_sized_index_reserves_before_fetching_and_streams_one_block(self):
        from .transport import BlobStore
        data={sha256(value).hexdigest():value for value in (b'abcd',b'efgh')}
        for value in data.values(): self.journal.stage(self.cluster,value)
        self.publish_manifest(sorted(data),sizes={digest:4 for digest in data})
        with self.journal.db:
            self.journal.db.execute('INSERT INTO replica_preparation_reservations VALUES(1)')
            self.journal.db.execute('UPDATE replica_jobs SET payload=NULL')
        with patch.object(self.journal,'_request',return_value=None) as network:
            result=self.journal.prepare_replacement(self.directory,self.proposal,limit=1)
            self.assertEqual(result['reason'],'preparation_reservation_unavailable')
            self.assertEqual(network.call_count,1)
            self.assertEqual(network.call_args.args[1],'placement-reserve')
            self.assertEqual(network.call_args.args[2]['blocks'],{digest:4 for digest in data})
        store=BlobStore(':memory:',max_bytes=8); self.addCleanup(store.close)
        reads=[]
        def request(node,operation,body):
            if operation=='placement-reserve': return self.fixture.signers[self.target].reserve(body,store,self.journal.verifier.recipient)
            if node==self.target: return store.execute(operation,body)
            reads.append(body['digest'])
            return {'digest':body['digest'],'ciphertext':data[body['digest']].hex()}
        with patch.object(self.journal,'_request',side_effect=request):
            self.assertFalse(self.journal.prepare_replacement(self.directory,self.proposal,limit=1)['ready'])
            self.assertEqual(len(reads),1)
            self.assertEqual(store.usage()['used_bytes'],4)
            self.assertEqual(store.audit_usage()['reserved_bytes'],4)
            self.assertTrue(self.journal.prepare_replacement(self.directory,self.proposal,limit=1)['ready'])
        self.assertEqual(store.usage()['used_bytes'],8)

    def test_sized_index_rejects_source_length_before_put(self):
        from .transport import BlobStore
        data=b'abcd'; digest=self.journal.stage(self.cluster,data)
        self.publish_manifest([digest],sizes={digest:5})
        with self.journal.db:
            self.journal.db.execute('INSERT INTO replica_preparation_reservations VALUES(1)')
            self.journal.db.execute('UPDATE replica_jobs SET payload=NULL')
        store=BlobStore(':memory:',max_bytes=8); self.addCleanup(store.close)
        writes=[]
        def request(node,operation,body):
            if operation=='placement-reserve': return self.fixture.signers[self.target].reserve(body,store,self.journal.verifier.recipient)
            if operation=='put': writes.append(body)
            if node==self.target: return store.execute(operation,body)
            return {'digest':digest,'ciphertext':data.hex()}
        with patch.object(self.journal,'_request',side_effect=request):
            result=self.journal.prepare_replacement(self.directory,self.proposal)
        self.assertEqual(result['reason'],'preparation_committed_size_mismatch')
        self.assertEqual(writes,[])
        self.assertEqual(store.usage()['used_bytes'],0)

    def test_committed_sizes_gate_reservation_and_actual_readiness(self):
        from .transport import BlobStore
        store=BlobStore(':memory:',max_bytes=8); self.addCleanup(store.close)
        data=b'abcd'; digest=sha256(data).hexdigest()
        self.publish_manifest([digest],sizes={digest:4})
        signer=self.fixture.signers[self.target]; sender=self.journal.verifier.recipient
        with self.assertRaisesRegex(ValueError,'committed_size_mismatch'):
            signer.reserve({'proposal':self.proposal,'blocks':{digest:5}},store,sender)
        signer.reserve({'proposal':self.proposal,'blocks':{digest:4}},store,sender)
        store.execute('put',{'digest':digest,'ciphertext':data.hex()})
        signer.ready(self.proposal,store)
        # Even a majority-certified wrong size cannot produce actual readiness.
        self.publish_manifest([digest],sizes={digest:5})
        with self.assertRaisesRegex(ValueError,'copy_size_mismatch'):
            signer.ready(self.proposal,store)

    def test_chain_license_deadline_releases_reserve_but_local_clock_does_not(self):
        from .transport import BlobStore
        store=BlobStore(':memory:',max_bytes=8); self.addCleanup(store.close)
        digest=self.journal.stage(self.cluster,b'abcd'); self.publish_manifest([digest])
        old=json.loads(canonical(self.proposal)); signer=self.fixture.signers[self.target]
        sender=self.journal.verifier.recipient
        with self.journal.db: self.journal.db.execute('INSERT INTO replica_preparation_reservations VALUES(1)')
        def interrupted(node,operation,body):
            if operation=='placement-reserve': return signer.reserve(body,store,sender)
            if operation=='get': return {'error':'not_found'}
            return None
        with patch.object(self.journal,'_request',side_effect=interrupted):
            self.assertFalse(self.journal.prepare_replacement(self.directory,old)['ready'])
        deadline=min(doc['claims']['expires_at'] for doc in old['licenses'])
        self.fixture.state['block_time']=deadline-1
        with patch('time.time',return_value=deadline+100),patch.object(self.journal,'_request') as network:
            self.assertEqual(self.journal.release_preparation_reservations(self.directory)['pending'],1)
            network.assert_not_called()
        with self.assertRaisesRegex(ValueError,'finalized_transition'):
            signer.release({'proposal':old,'digests':[digest]},store,sender)
        self.fixture.state['block_time']=deadline
        tampered=json.loads(canonical(old)); tampered['licenses'][0]['claims']['expires_at']=1
        with self.assertRaisesRegex(ValueError,'finalized_transition'):
            signer.release({'proposal':tampered,'digests':[digest]},store,sender)
        self.assertEqual(store.usage()['available_bytes'],4)
        with patch.object(self.journal,'_request',side_effect=lambda node,op,body:signer.release(body,store,sender)):
            self.assertEqual(self.journal.release_preparation_reservations(self.directory),{'released':1,'pending':0})
        self.assertEqual(store.usage()['available_bytes'],8)
        self.assertEqual(self.directory.placement(self.cluster)['record']['body']['epoch'],1)

    def test_committed_direct_manifest_successor_releases_old_plan_before_epoch_change(self):
        from .transport import BlobStore
        from .manifests import manifest_record
        store=BlobStore(':memory:',max_bytes=8); self.addCleanup(store.close)
        digest=self.journal.stage(self.cluster,b'abcd'); self.publish_manifest([digest])
        old=json.loads(canonical(self.proposal)); signer=self.fixture.signers[self.target]
        sender=self.journal.verifier.recipient
        with self.journal.db: self.journal.db.execute('INSERT INTO replica_preparation_reservations VALUES(1)')
        def interrupted(node,operation,body):
            if operation=='placement-reserve': return signer.reserve(body,store,sender)
            if operation=='get': return {'error':'not_found'}
            return None
        with patch.object(self.journal,'_request',side_effect=interrupted):
            self.assertFalse(self.journal.prepare_replacement(self.directory,old)['ready'])
        before=self.fixture.state['manifests'][self.cluster]['digest']
        head=self.fixture.state['placements'][self.cluster]
        successor=manifest_record('lab',head,sorted([digest,sha256(b'new').hexdigest()]),self.fixture.fixture.keys[:2],version=2,previous=before)
        self.fixture.state['manifests'][self.cluster]={'record':successor,'digest':sha256(canonical(successor)).hexdigest()}
        successor['body']['previous']='f'*64
        with self.assertRaisesRegex(ValueError,'finalized_transition'):
            signer.release({'proposal':old,'digests':[digest]},store,sender)
        with patch.object(self.journal,'_request') as network:
            self.assertEqual(self.journal.release_preparation_reservations(self.directory)['pending'],1)
            network.assert_not_called()
        self.assertEqual(store.usage()['available_bytes'],4)
        successor['body']['previous']=before
        with self.assertRaisesRegex(ValueError,'proposal_changed'):
            signer.reserve({'proposal':old,'blocks':{digest:4}},store,sender)
        def release(node,operation,body):
            self.assertEqual(operation,'placement-release')
            return signer.release(body,store,sender)
        with patch.object(self.journal,'_request',side_effect=release):
            self.assertEqual(self.journal.release_preparation_reservations(self.directory),{'released':1,'pending':0})
        self.assertEqual(store.usage()['available_bytes'],8)
        self.assertEqual(self.directory.placement(self.cluster)['record']['body']['epoch'],1)

    def test_full_index_reserve_waits_for_all_sizes_and_prevents_partial_copy(self):
        from .transport import BlobStore
        data=[b'abcd',b'efgh']; by_hash={sha256(value).hexdigest():value for value in data}
        for value in data: self.journal.stage(self.cluster,value)
        self.publish_manifest(sorted(by_hash))
        with self.journal.db:
            self.journal.db.execute('INSERT INTO replica_preparation_reservations VALUES(1)')
            self.journal.db.execute('UPDATE replica_jobs SET payload=NULL')
        small=BlobStore(':memory:',max_bytes=4); large=BlobStore(':memory:',max_bytes=8)
        self.addCleanup(small.close); self.addCleanup(large.close)
        store=small; calls=[]
        def request(node,operation,body):
            calls.append(operation)
            if operation=='placement-reserve':
                self.assertEqual(body['blocks'],{digest:4 for digest in by_hash})
                try: return self.fixture.signers[self.target].reserve(body,store,self.journal.verifier.recipient)
                except ValueError: return None
            if node==self.target: return store.execute(operation,body)
            return {'digest':body['digest'],'ciphertext':by_hash[body['digest']].hex()}
        with patch.object(self.journal,'_request',side_effect=request):
            first=self.journal.prepare_replacement(self.directory,self.proposal,limit=1)
            self.assertEqual(first['reason'],'preparation_reservation_preflight')
            self.assertNotIn('placement-reserve',calls); self.assertNotIn('put',calls)
            calls.clear()
            denied=self.journal.prepare_replacement(self.directory,self.proposal,limit=1)
            self.assertEqual(denied['reason'],'preparation_reservation_unavailable')
            self.assertNotIn('put',calls)
            self.assertEqual(small.audit_usage()['reserved_bytes'],0)
            self.assertEqual(small.usage()['used_bytes'],0)
            store=large; calls.clear()
            self.assertFalse(self.journal.prepare_replacement(self.directory,self.proposal,limit=1)['ready'])
            self.assertEqual(calls[0],'placement-reserve')
            self.assertTrue(self.journal.prepare_replacement(self.directory,self.proposal,limit=1)['ready'])
        self.assertEqual(large.usage()['used_bytes'],8)
        self.assertEqual(large.audit_usage()['reserved_bytes'],0)

    def test_uncertain_reservation_cleanup_survives_restart_and_lost_release_reply(self):
        from tempfile import TemporaryDirectory
        from .transport import BlobStore
        store=BlobStore(':memory:',max_bytes=8); self.addCleanup(store.close)
        with TemporaryDirectory() as temp:
            path=temp+'/replicas.sqlite'
            def reopen(): return ReplicaJournal(path,self.journal.key,self.journal.verifier,self.journal.endpoints,require_consensus=True,reserve_preparation=True)
            journal=reopen()
            try:
                journal.apply_confirmed_placement(self.directory,self.cluster,self.directory.placement_candidates(cluster=self.cluster))
                data=b'abcd'; digest=journal.stage(self.cluster,data); self.publish_manifest([digest])
                signer=self.fixture.signers[self.target]; sender=self.journal.verifier.recipient
                def uncertain(node,operation,body):
                    if operation=='get': return {'error':'not_found'}
                    if operation=='placement-reserve': return signer.reserve(body,store,sender)
                    return None  # put never reached the target
                with patch.object(journal,'_request',side_effect=uncertain):
                    self.assertFalse(journal.prepare_replacement(self.directory,self.proposal)['ready'])
                self.assertEqual(store.usage()['available_bytes'],4)
                journal.close(); journal=reopen()
                with patch.object(journal,'_request') as network:
                    self.assertEqual(journal.release_preparation_reservations(self.directory)['pending'],1)
                    network.assert_not_called()
                prior=json.loads(canonical(self.fixture.state['placements'][self.cluster]))
                self.fixture.state['placement_history'][self.cluster]=[prior]
                self.fixture.state['placements'][self.cluster]['record']['body']['epoch']=self.proposal['body']['epoch']
                def lost(node,operation,body):
                    self.assertEqual(operation,'placement-release'); signer.release(body,store,sender)
                    return None
                with patch.object(journal,'_request',side_effect=lost):
                    self.assertEqual(journal.release_preparation_reservations(self.directory),{'released':0,'pending':1})
                self.assertEqual(store.usage()['available_bytes'],8)
                journal.close(); journal=reopen()
                with journal.db: journal.db.execute('UPDATE replica_reservation_outbox SET retry_at=0')
                with patch.object(journal,'_request',side_effect=lambda node,op,body:signer.release(body,store,sender)):
                    self.assertEqual(journal.release_preparation_reservations(self.directory),{'released':1,'pending':0})
            finally: journal.close()

    def test_finalized_release_requires_historical_holder_and_preserves_other_plan(self):
        from .transport import BlobStore
        store=BlobStore(':memory:',max_bytes=8); self.addCleanup(store.close)
        digest=sha256(b'abcd').hexdigest(); self.publish_manifest([digest])
        signer=self.fixture.signers[self.target]; holder=self.old_members[0]
        signer.reserve({'proposal':self.proposal,'blocks':{digest:4}},store,holder)
        request={'proposal':self.proposal,'digests':[digest]}
        with self.assertRaisesRegex(ValueError,'finalized_transition'):
            signer.release(request,store,holder)
        self.assertEqual(store.usage()['available_bytes'],4)
        prior=json.loads(canonical(self.fixture.state['placements'][self.cluster]))
        self.fixture.state['placement_history'][self.cluster]=[prior]
        self.fixture.state['placements'][self.cluster]['record']['body']['epoch']=self.proposal['body']['epoch']
        with self.assertRaisesRegex(ValueError,'historical_holder'):
            signer.release(request,store,self.target)
        with self.assertRaisesRegex(ValueError,'wrong_target'):
            self.fixture.signers[holder].release(request,store,holder)
        store.reserve_blocks({digest:4},cluster=self.cluster,plan='f'*64)
        self.assertTrue(signer.release(request,store,holder)['released'])
        self.assertEqual(store.usage()['available_bytes'],4)
        store.release_blocks([digest],cluster=self.cluster,plan='f'*64)
        self.assertEqual(store.usage()['available_bytes'],8)
        store.execute('put',{'digest':digest,'ciphertext':b'abcd'.hex()})
        self.assertTrue(signer.release(request,store,holder)['released'])
        self.assertEqual(store.usage()['used_bytes'],4)

    def test_preparation_reserve_mode_survives_reopen_and_denial_blocks_put(self):
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as temp:
            path=temp+'/replicas.sqlite'
            journal=ReplicaJournal(path,self.journal.key,self.journal.verifier,self.journal.endpoints,require_consensus=True,reserve_preparation=True)
            journal.close()
            journal=ReplicaJournal(path,self.journal.key,self.journal.verifier,self.journal.endpoints,require_consensus=True)
            try:
                journal.apply_confirmed_placement(self.directory,self.cluster,self.directory.placement_candidates(cluster=self.cluster))
                payload=b'prepared encrypted bytes'; digest=journal.stage(self.cluster,payload)
                self.publish_manifest([digest]); calls=[]
                def denied(node,operation,body):
                    calls.append(operation)
                    if operation=='get': return {'error':'not_found'}
                    if operation=='placement-reserve': return None
                    self.fail('write happened before reservation')
                with patch.object(journal,'_request',side_effect=denied):
                    result=journal.prepare_replacement(self.directory,self.proposal)
                self.assertEqual(result['reason'],'preparation_reservation_unavailable')
                self.assertEqual(calls,['placement-reserve'])
                self.assertEqual(journal.db.execute('SELECT COUNT(*) FROM replica_preparations').fetchone()[0],0)
                data={}; calls=[]
                def accepted(node,operation,body):
                    calls.append(operation)
                    if operation=='get': return {'digest':digest,'ciphertext':data[digest].hex()} if digest in data else {'error':'not_found'}
                    if operation=='placement-reserve':
                        self.assertEqual(body,{'proposal':self.proposal,'blocks':{digest:len(payload)}})
                        return {'body_hash':sha256(canonical(self.proposal['body'])).hexdigest(),'reserved_bytes':len(payload),'blocks':1}
                    data[digest]=bytes.fromhex(body['ciphertext']); return {'stored':True,'digest':digest}
                with patch.object(journal,'_request',side_effect=accepted):
                    self.assertTrue(journal.prepare_replacement(self.directory,self.proposal)['ready'])
                self.assertEqual(calls,['placement-reserve','get','put','get'])
            finally: journal.close()

    def test_target_reserves_only_current_indexed_plan_from_existing_holder(self):
        from .transport import BlobStore
        store=BlobStore(':memory:',max_bytes=8); self.addCleanup(store.close)
        digest=sha256(b'abcd').hexdigest(); self.publish_manifest([digest])
        signer=self.fixture.signers[self.target]
        payload={'proposal':self.proposal,'blocks':{digest:4}}
        result=signer.reserve(payload,store,self.old_members[0])
        self.assertEqual(result['reserved_bytes'],4)
        self.assertEqual(store.usage()['available_bytes'],4)
        with self.assertRaisesRegex(ValueError,'current_holder'):
            signer.reserve(payload,store,self.target)
        with self.assertRaisesRegex(ValueError,'unindexed'):
            signer.reserve({**payload,'blocks':{'f'*64:4}},store,self.old_members[0])
        wrong=self.fixture.signers[self.old_members[0]]
        with self.assertRaisesRegex(ValueError,'wrong_target'):
            wrong.reserve(payload,store,self.old_members[0])
        changed=json.loads(canonical(payload)); changed['proposal']['body']['previous']='f'*64
        with self.assertRaisesRegex(ValueError,'proposal_changed'):
            signer.reserve(changed,store,self.old_members[0])
        self.assertEqual(store.usage()['available_bytes'],4)

    def test_reservation_roundtrip_over_authenticated_http(self):
        import threading
        from .transport import BlobStore,LabServer,exchange
        store=BlobStore(':memory:',max_bytes=4)
        lookup=dict(zip(self.fixture.fixture.ids,self.fixture.fixture.keys))
        holder=self.old_members[0]; key=lookup[holder]
        roster={identity:k.public_key().public_bytes_raw() for identity,k in lookup.items()}
        client=EnvelopeVerifier('lab',holder,roster,':memory:')
        target=EnvelopeVerifier('lab',self.target,roster,':memory:')
        server=LabServer(lookup[self.target],target,store,placement_signer=self.fixture.signers[self.target])
        thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        digest=sha256(b'abcd').hexdigest(); self.publish_manifest([digest])
        try:
            payload={'proposal':self.proposal,'blocks':{digest:4}}
            result=exchange(server.endpoint,key,client,self.target,'placement-reserve',payload)
            self.assertEqual(result['body_hash'],sha256(canonical(self.proposal['body'])).hexdigest())
            self.assertEqual(result['reserved_bytes'],4)
            self.assertEqual(store.usage()['available_bytes'],0)
            exchange(server.endpoint,key,client,self.target,'put',{'digest':digest,'ciphertext':b'abcd'.hex()})
            self.assertEqual(store.usage()['used_bytes'],4)
            self.assertEqual(store.db.execute('SELECT COUNT(*) FROM blob_reservation_owners').fetchone()[0],0)
            prior=json.loads(canonical(self.fixture.state['placements'][self.cluster]))
            self.fixture.state['placement_history'][self.cluster]=[prior]
            self.fixture.state['placements'][self.cluster]['record']['body']['epoch']=self.proposal['body']['epoch']
            released=exchange(server.endpoint,key,client,self.target,'placement-release',{'proposal':self.proposal,'digests':[digest]})
            self.assertTrue(released['released'])
            self.assertEqual(store.usage()['used_bytes'],4)
        finally:
            server.shutdown(); server.server_close(); thread.join(2)
            store.close(); client.close(); target.close()

    def publish_manifest(self,digests,*,sizes=None):
        from .manifests import manifest_record
        head=self.fixture.state['placements'][self.cluster]
        keys=self.fixture.fixture.keys[:2]
        record=manifest_record('lab',head,digests,keys,sizes=sizes)
        self.fixture.state['manifests']={self.cluster:{'record':record,'digest':sha256(canonical(record)).hexdigest()}}
        self.proposal=replacement_proposal(self.directory,self.cluster)
    def setUp(self):
        fixture=test_replacement.ReplacementTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.fixture=fixture
        self.directory=fixture.directory
        self.cluster=fixture.cluster
        head=fixture.state['placements'][self.cluster]
        fixture.state['placement_history']={self.cluster:[head]}
        original=self.directory.placement
        self.directory.placement=lambda cluster:{**original(cluster),'finality':{'height':1}}
        key=fixture.fixture.keys[0]
        roster={identity:k.public_key().public_bytes_raw() for identity,k in zip(fixture.fixture.ids,fixture.fixture.keys)}
        verifier=EnvelopeVerifier('lab',fixture.fixture.ids[0],roster,':memory:')
        self.addCleanup(verifier.close)
        journal=ReplicaJournal(':memory:',key,verifier,fixture.journal.endpoints,require_consensus=True)
        self.addCleanup(journal.close)
        self.journal=journal
        # Bootstrap before the failure, then obtain the actual replacement plan.
        failed=fixture.fixture.ids[2]
        fixture.state['resources'][failed]['record']['body']['capacity_slots']=2
        journal.apply_confirmed_placement(self.directory,self.cluster,self.directory.placement_candidates(cluster=self.cluster))
        fixture.state['resources'][failed]['record']['body']['capacity_slots']=0
        self.proposal=replacement_proposal(self.directory,self.cluster)
        self.old_members=head['record']['body']['members']
        self.target=next(iter(set(self.proposal['body']['members'])-set(self.old_members)))

    def test_consensus_policy_composition_is_not_reranked_locally(self):
        profiles = self.directory.placement_candidates(cluster=self.cluster)
        journal = ReplicaJournal(':memory:', self.journal.key, self.journal.verifier, self.journal.endpoints, require_consensus=True)
        self.addCleanup(journal.close)
        # Even a later negative assessment cannot rewrite the accepted epoch.
        with patch('sfera_mesh.replication.choose_cluster', side_effect=AssertionError('local reranking')):
            self.assertTrue(journal.apply_confirmed_placement(self.directory, self.cluster, profiles)['changed'])
        untrusted = ReplicaJournal(':memory:', self.journal.key, self.journal.verifier, self.journal.endpoints, require_consensus=True)
        self.addCleanup(untrusted.close)
        with self.assertRaisesRegex(ValueError, 'unverified_profile'):
            untrusted.apply_confirmed_placement(self.directory, self.cluster, [replace(node, grant_verified=False) for node in profiles])

    def test_warmup_fetches_ciphertext_without_switching_membership_or_receipts(self):
        payload=b'encrypted payload recovered before the vote'
        digest=self.journal.stage(self.cluster,payload)
        self.publish_manifest([digest])
        with self.journal.db: self.journal.db.execute('UPDATE replica_jobs SET payload=NULL')
        stores={identity:{digest:payload} if identity in self.old_members else {} for identity in self.fixture.fixture.ids}
        def request(node,operation,body):
            if operation=='put':
                data=bytes.fromhex(body['ciphertext'])
                self.assertEqual(sha256(data).hexdigest(),body['digest'])
                stores[node][body['digest']]=data
                return {'digest':body['digest'],'stored':True}
            data=stores[node].get(body['digest'])
            return {'digest':body['digest'],'ciphertext':data.hex()} if data is not None else {'error':'not_found'}
        with patch.object(self.journal,'_request',side_effect=request):
            result=self.journal.prepare_replacement(self.directory,self.proposal)
        self.assertTrue(result['ready'])
        self.assertEqual(stores[self.target][digest],payload)
        current=self.journal.db.execute('SELECT epoch,members FROM replica_clusters').fetchone()
        self.assertEqual(current[0],1)
        self.assertEqual(json.loads(current[1]),self.old_members)
        self.assertEqual(self.journal.status(self.cluster,digest)['copies'],[])
        self.assertEqual(self.directory.placement(self.cluster)['record']['body']['epoch'],1)

    def test_missing_or_corrupt_source_blocks_preparation(self):
        digest=self.journal.stage(self.cluster,b'expected ciphertext')
        self.publish_manifest([digest])
        with self.journal.db: self.journal.db.execute('UPDATE replica_jobs SET payload=NULL')
        def request(node,operation,body):
            self.assertEqual(operation,'get')
            return {'error':'not_found'} if node==self.target else {'digest':digest,'ciphertext':b'corrupt'.hex()}
        with patch.object(self.journal,'_request',side_effect=request):
            result=self.journal.prepare_replacement(self.directory,self.proposal)
        self.assertFalse(result['ready'])
        self.assertEqual(self.journal.db.execute('SELECT COUNT(*) FROM replica_preparations').fetchone()[0],0)

    def test_confirmed_index_finds_data_absent_from_local_journal(self):
        data=b'ciphertext missing from the local manifest'
        digest=sha256(data).hexdigest()
        self.publish_manifest([digest])
        target={}
        def request(node,operation,body):
            if operation=='put':
                target[body['digest']]=bytes.fromhex(body['ciphertext'])
                return {'stored':True,'digest':body['digest']}
            payload=target.get(body['digest']) if node==self.target else data
            return {'ciphertext':payload.hex(),'digest':body['digest']} if payload is not None else {'error':'not_found'}
        with patch.object(self.journal,'_request',side_effect=request):
            self.assertTrue(self.journal.prepare_replacement(self.directory,self.proposal)['ready'])
        self.assertEqual(target[digest],data)
        self.assertEqual(self.journal.status(self.cluster,digest)['epoch'],1)

    def test_uncommitted_local_data_cannot_be_ignored(self):
        self.journal.stage(self.cluster,b'uncommitted local ciphertext')
        self.publish_manifest([])
        with patch.object(self.journal,'_request') as request:
            result=self.journal.prepare_replacement(self.directory,self.proposal)
        self.assertFalse(result['ready'])
        self.assertEqual(result['reason'],'unconfirmed_manifest_entries')
        request.assert_not_called()
