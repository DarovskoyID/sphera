from pathlib import Path
import runpy
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'django-server/sfera_server'))
from server_wan_trial_job import dataset,exercise_peer


@unittest.skipUnless(sys.platform=='linux','Linux trial file permissions and services')
class TrialJobTests(unittest.TestCase):
    def test_managed_inventory_requires_licensed_distinct_endpoints_and_genesis(self):
        import base64,hashlib
        from unittest.mock import patch
        from types import SimpleNamespace
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from server_wan_managed import managed_inventory
        nodes=[];peers={};roster={};assessors={}
        for index in range(4):
            host='93.184.216.'+str(index+1);public=Ed25519PrivateKey.generate().public_key().public_bytes_raw();observer=Ed25519PrivateKey.generate().public_key().public_bytes_raw();identity=hashlib.sha256(observer).hexdigest()
            nodes.append({'host':host,'validator_public_key':{'value':base64.b64encode(public).decode()}});peers[identity]={'endpoint':'https://'+host+':9444','public_key':observer.hex()};roster[identity]=observer;assessors[hashlib.sha256(public).hexdigest()]=public.hex()
        profile={'validators':[n['host'] for n in nodes],'nodes':nodes};directory=SimpleNamespace(placement_assessors=assessors)
        with patch('sfera_mesh.discovery.discovered_peers',return_value={'peers':peers}),patch('sfera_mesh.network_peers.approved_network_peers',return_value=roster):
            self.assertEqual(len(managed_inventory(profile,directory)),4)
            victim=next(iter(roster));saved=roster.pop(victim)
            with self.assertRaises(ValueError):managed_inventory(profile,directory)
            roster[victim]=saved;directory.placement_assessors={}
            with self.assertRaises(ValueError):managed_inventory(profile,directory)

    def test_partition_arms_recovery_first_and_scopes_every_firewall_rule(self):
        import json
        from types import SimpleNamespace
        from unittest.mock import patch
        import server_wan_trial_job as job
        calls=[]
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);sign=root/'consensus/data';sign.mkdir(parents=True);(sign/'priv_validator_state.json').write_text(json.dumps({'height':'100'}))
            def command(argv,**kwargs):calls.append(argv);return SimpleNamespace(returncode=1 if '-S' in argv else 0)
            policy={'target_host':'93.184.216.1','pause_seconds':5,'partition_peers':['93.184.216.2','93.184.216.3','93.184.216.4'],'job_id':'a'*32}
            with patch.object(job,'ROOT',root),patch('shutil.which',return_value='/usr/sbin/iptables'),patch.object(job.subprocess,'run',side_effect=command),patch.object(job.time,'sleep',side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):job.partition(policy,root,{'public_endpoint':'https://93.184.216.1:8443'})
            armed=next(i for i,c in enumerate(calls) if c[0]=='systemd-run');mutated=next(i for i,c in enumerate(calls) if '-N' in c);self.assertLess(armed,mutated)
            self.assertTrue(any(str(root/'remove-partition.py') in c and c[0]==sys.executable for c in calls))
            rules=[c for c in calls if '-A' in c];self.assertEqual(len(rules),12)
            self.assertTrue(all('26656' in c and 'DROP' in c and any(p in c for p in policy['partition_peers']) for c in rules))
            cleanup=(root/'remove-partition.py').read_text();self.assertNotIn("'-F']",cleanup);self.assertNotIn('22',cleanup);self.assertNotIn('8443',cleanup)

    def test_repair_exercise_deletes_only_manifest_pinned_test_copy(self):
        import hashlib,sqlite3,threading,time
        from unittest.mock import patch
        from sfera_mesh.identity import create_identity,node_id
        from sfera_mesh.transport import BlobStore
        from server_wan_managed import remove_test_copy
        raw=b'c'*1052;digest=hashlib.sha256(raw).hexdigest();other=hashlib.sha256(b'keep').hexdigest();cluster='f'*64
        with tempfile.TemporaryDirectory() as temporary:
            state=Path(temporary);key=create_identity(state/'node.key');own=node_id(key.public_key().public_bytes_raw());members=sorted([own,'a'*64,'b'*64]);store=BlobStore(state/'blobs.sqlite',max_bytes=1048576)
            store.execute('put',{'digest':digest,'ciphertext':raw.hex()});store.execute('put',{'digest':other,'ciphertext':b'keep'.hex()})
            class Directory:
                current={'state':{'manifests':{cluster:{'record':{'body':{'digests':[digest]}}}}}}
                def __init__(self,*args):pass
                def refresh(self,*args):pass
                def close(self):pass
                def placement(self,*args):return {'record':{'body':{'members':members}}}
            config={'node_key':str(state/'node.key'),'state_directory':str(state),'verifier_binary':'unused','genesis':'unused','consensus_gateways':['https://93.184.216.1:9443']}
            job={'target_host':'93.184.216.1','test_cluster':cluster,'test_members':members,'test_digest':digest,'test_size':1052};receipt={'host':job['target_host']}
            restored=threading.Event()
            def background_copy():
                with sqlite3.connect(state/'blobs.sqlite') as db:
                    deadline=time.monotonic()+5
                    while db.execute('SELECT COUNT(*) FROM blobs WHERE digest=?',(digest,)).fetchone()[0] and time.monotonic()<deadline:time.sleep(.01)
                # Model another process copying only after the absence is visible.
                time.sleep(.1);store.execute('put',{'digest':digest,'ciphertext':raw.hex()});restored.set()
            worker=threading.Thread(target=background_copy);worker.start()
            try:
                with patch('sfera_mesh.consensus_directory.ConsensusDirectory',Directory):
                    result=remove_test_copy(job,config,receipt,state)
                self.assertTrue(result['automatic_restore_observed']);self.assertTrue(result['copy_missing_observed']);self.assertFalse(result['manual_put_after_delete']);self.assertTrue(restored.is_set())
                self.assertEqual(store.execute('get',{'digest':other})['ciphertext'],b'keep'.hex());self.assertEqual(store.usage()['used_bytes'],1056)
                with patch('sfera_mesh.consensus_directory.ConsensusDirectory',Directory):
                    with self.assertRaises(ValueError):remove_test_copy({**job,'test_size':2048},config,receipt,state)
                self.assertEqual(store.execute('get',{'digest':digest})['ciphertext'],raw.hex())
            finally:worker.join(timeout=6);store.close()

    def test_local_assessor_matches_genesis_and_never_creates_key_copy(self):
        import base64,hashlib,json
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from server_wan_managed import validator_identity
        key=Ed25519PrivateKey.generate();public=key.public_key().public_bytes_raw();authorized={hashlib.sha256(public).hexdigest():public.hex()}
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'validator.json';path.write_text(json.dumps({'priv_key':{'type':'tendermint/PrivKeyEd25519','value':base64.b64encode(key.private_bytes_raw()+public).decode()},'pub_key':{'value':base64.b64encode(public).decode()}}));path.chmod(0o600);original=path.read_bytes()
            self.assertEqual(validator_identity(path,authorized).public_key().public_bytes_raw(),public)
            self.assertEqual(list(Path(temporary).iterdir()),[path]);self.assertEqual(path.read_bytes(),original)
            with self.assertRaises(ValueError):validator_identity(path,{})
            path.chmod(0o644)
            with self.assertRaises(ValueError):validator_identity(path,authorized)

    def test_interrupted_pause_starts_original_service_in_finally(self):
        from unittest.mock import patch
        import server_wan_trial_job as job
        calls=[]
        with tempfile.TemporaryDirectory() as temporary:
            folder=Path(temporary)
            def command(argv,**kwargs):calls.append(argv);return object()
            with patch.object(job.subprocess,'run',side_effect=command),patch.object(job.time,'sleep',side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):job.service_fault({'action':'point_restart','target_host':'93.184.216.1','pause_seconds':5,'job_id':'a'*32},folder,{'public_endpoint':'https://93.184.216.1:8443'},None)
            scheduled=next(i for i,c in enumerate(calls) if c[0]=='systemd-run');stopped=next(i for i,c in enumerate(calls) if c[:2]==['systemctl','stop'] and c[-1]=='sphere-point.service')
            self.assertLess(scheduled,stopped);self.assertIn(['systemctl','start','sphere-point.service'],calls)

    def test_dataset_is_persistent_bounded_and_authenticated(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder=Path(temporary);rows,cipher,aad=dataset(folder,'a'*32,'b'*64,2,1024);again,_,_=dataset(folder,'a'*32,'b'*64,2,1024)
            self.assertEqual([r['digest'] for r in rows],[r['digest'] for r in again])
            raw=bytes.fromhex(rows[0]['ciphertext']);self.assertEqual(cipher.decrypt(raw[:12],raw[12:],aad),rows[0]['plain'])
            with self.assertRaises(ValueError):dataset(folder,'a'*32,'b'*64,3,1024)
            with self.assertRaises(ValueError):dataset(folder,'a'*32,'b'*64,10000,16384)

    def test_real_signed_https_write_read_and_read_only_check(self):
        fixture_type=runpy.run_path(str(Path(__file__).with_name('test-mesh-public-transport.py')))['PublicTransportTests'];fixture=fixture_type();fixture.setUp();self.addCleanup(fixture.tearDown)
        with tempfile.TemporaryDirectory() as temporary:
            rows,cipher,aad=dataset(Path(temporary),'a'*32,fixture.ids[1],4,1024)
            result=exercise_peer(fixture.client,fixture.keys[1],fixture.checks[1],fixture.ids[0],rows,cipher,aad)
            self.assertTrue(result['passed']);self.assertEqual(result['verified_read_bytes'],4*1052)
            result=exercise_peer(fixture.client,fixture.keys[1],fixture.checks[1],fixture.ids[0],rows,cipher,aad,read_only=True)
            self.assertTrue(result['passed']);self.assertEqual(result['written_bytes'],0)
            fixture.store.db.execute('DELETE FROM blobs');fixture.store.db.commit()
            missing=exercise_peer(fixture.client,fixture.keys[1],fixture.checks[1],fixture.ids[0],rows,cipher,aad,read_only=True)
            self.assertFalse(missing['passed']);self.assertEqual(len(missing['failures']),4)

    def test_lost_ack_retries_same_ciphertext_without_duplicate_storage(self):
        fixture_type=runpy.run_path(str(Path(__file__).with_name('test-mesh-public-transport.py')))['PublicTransportTests'];fixture=fixture_type();fixture.setUp();self.addCleanup(fixture.tearDown)
        class LostAck:
            dropped=False
            def exchange(self,*args,**kwargs):
                result=fixture.client.exchange(*args,**kwargs)
                if args[3]=='put' and not self.dropped:self.dropped=True;raise TimeoutError('lost acknowledgement fixture')
                return result
        with tempfile.TemporaryDirectory() as temporary:
            rows,cipher,aad=dataset(Path(temporary),'a'*32,fixture.ids[1],1,1024)
            result=exercise_peer(LostAck(),fixture.keys[1],fixture.checks[1],fixture.ids[0],rows,cipher,aad,max_attempts=2)
            self.assertTrue(result['passed']);self.assertEqual(result['recovered_blocks'],1);self.assertEqual(len(result['attempt_errors']),1)
            self.assertEqual(fixture.store.db.execute('SELECT COUNT(*) FROM blobs').fetchone()[0],1)


if __name__=='__main__':unittest.main()
