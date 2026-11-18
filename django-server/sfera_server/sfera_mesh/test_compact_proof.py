from pathlib import Path
import copy
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import time
import unittest
from unittest.mock import patch
from .compact_proof import CompactProofClient
from .storage import canonical


class CompactProofClientTests(unittest.TestCase):
    def test_multiple_pages_do_not_mix_manifest_versions(self):
        first={'manifest_hash':'d'*64,'manifest_version':1,'total':3,'entries':[{'digest':'a'*64,'size':1},{'digest':'b'*64,'size':1}]}
        second={**first,'entries':[{'digest':'c'*64,'size':1}]}
        with patch.object(self.client,'fetch_page',side_effect=[first,second]):
            self.assertEqual(len(self.client.fetch_manifest('unused',self.cluster,page_size=2)['entries']),3)
        second['manifest_hash']='f'*64
        with patch.object(self.client,'fetch_page',side_effect=[first,second]):
            with self.assertRaisesRegex(ValueError,'manifest_changed'):self.client.fetch_manifest('unused',self.cluster,page_size=2)

    def test_page_rejects_missing_reordered_and_mixed_manifest_entries(self):
        body={'network':'lab','cluster':self.cluster,'placement_hash':'e'*64,'version':1,'epoch':1}
        meta={'index':10,'count':30,'leaf':{'key':f'manifest/{self.cluster}/meta','value':{'head':{'digest':'d'*64,'record':{'body':body}},'count':2,'sized':True}}}
        first={'index':8,'count':30,'leaf':self.result()['leaf']}
        second=copy.deepcopy(first);second['index']=9;second['leaf']['key']=f'manifest/{self.cluster}/entry/'+('f'*64)
        page={'meta':meta,'entries':[first,second],'offset':0}
        def native(evidence):return {**self.result(),'leaf':evidence['proof']['leaf']}
        with patch.object(self.client,'_native',side_effect=native):
            for mode in ('missing','reordered','mixed'):
                bad=copy.deepcopy(page)
                if mode=='missing':bad['entries'].pop()
                elif mode=='reordered':bad['entries'].reverse()
                else:bad['entries'][1]['leaf']['value']['manifest_hash']='0'*64
                with self.assertRaises(ValueError):self.client.verify_page({'page':bad,'signed_header':{}},self.cluster,offset=0,limit=2)
                self.assertEqual(self.client.db.execute('SELECT COUNT(*) FROM proof_checkpoint').fetchone()[0],0)
            result=self.client.verify_page({'page':page,'signed_header':{}},self.cluster,offset=0,limit=2)
            self.assertEqual(result['total'],2)
            self.assertEqual(len(result['entries']),2)

    def setUp(self):
        self.temp=TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.genesis=Path(self.temp.name)/'genesis.json'
        self.genesis.write_bytes(canonical({'chain_id':'lab','app_state':{'state_commitment':'sfera-mesh-state-merkle-v1'}}))
        self.path=Path(self.temp.name)/'proof.sqlite'
        self.client=CompactProofClient(self.path,'verifier.exe',self.genesis)
        self.addCleanup(lambda:self.client.close())
        self.cluster,self.digest='a'*64,'b'*64

    def result(self,height=10,header='c'*64):
        return {'leaf':{'key':f'manifest/{self.cluster}/entry/{self.digest}',
                        'value':{'size':4,'manifest_hash':'d'*64,'version':1,'epoch':1,'placement_hash':'e'*64}},
                'network':'lab','height':height,'header_hash':header,'expires_at':int(time.time())+20}

    def verify(self,result=None,**kwargs):
        with patch('sfera_mesh.compact_proof.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout=canonical(result or self.result()))):
            return self.client.verify({'proof':'fixture'},self.cluster,self.digest,**kwargs)

    def test_durable_high_water_mark_and_fork_rejection(self):
        self.assertTrue(self.verify(size=4)['consensus_committed'])
        self.client.close();self.client=CompactProofClient(self.path,'verifier.exe',self.genesis)
        with self.assertRaisesRegex(ValueError,'rollback_or_fork'):self.verify(self.result(9))
        with self.assertRaisesRegex(ValueError,'rollback_or_fork'):self.verify(self.result(10,'f'*64))
        self.verify(self.result(11))

    def test_committed_committee_prefix_survives_restart_and_higher_height(self):
        first=self.result();first['committee_history']=[{'digest':'1'*64}]
        self.verify(first)
        self.client.close();self.client=CompactProofClient(self.path,'verifier.exe',self.genesis)
        for history in ([],[{'digest':'2'*64}]):
            changed=self.result(11);changed['committee_history']=history
            with self.assertRaisesRegex(ValueError,'committee_history_rollback_or_fork'):self.verify(changed)
        continued=self.result(11);continued['committee_history']=first['committee_history']+[{'digest':'3'*64}]
        self.verify(continued)

    def test_wrong_block_size_and_stale_output_never_advance_checkpoint(self):
        wrong=self.result();wrong['leaf']['key']='other'
        with self.assertRaises(ValueError):self.verify(wrong)
        with self.assertRaises(ValueError):self.verify(size=5)
        stale=self.result();stale['expires_at']=0
        with self.assertRaises(ValueError):self.verify(stale)
        self.assertEqual(self.client.db.execute('SELECT COUNT(*) FROM proof_checkpoint').fetchone()[0],0)

    def test_bad_cryptographic_proof_is_not_accepted(self):
        with patch('sfera_mesh.compact_proof.subprocess.run',return_value=SimpleNamespace(returncode=1,stdout=b'')):
            with self.assertRaisesRegex(ValueError,'invalid_or_stale'):self.client.verify({},self.cluster,self.digest)

    def test_pinned_file_and_legacy_genesis_are_checked(self):
        self.genesis.write_bytes(canonical({'chain_id':'other','app_state':{'state_commitment':'sfera-mesh-state-merkle-v1'}}))
        with self.assertRaisesRegex(ValueError,'genesis_changed'):self.verify()
        self.client.close()
        with self.assertRaisesRegex(ValueError,'genesis_changed'):CompactProofClient(self.path,'verifier.exe',self.genesis)
        self.genesis.write_bytes(canonical({'chain_id':'lab'}))
        with self.assertRaisesRegex(ValueError,'compact_proof_genesis_required'):CompactProofClient(':memory:','verifier.exe',self.genesis)
