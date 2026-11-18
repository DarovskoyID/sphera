"""Native client verification of block inclusion without downloading whole state."""
import base64
from hashlib import sha256
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import threading
import time
from .consensus_directory import rpc,ConsensusUnavailable,committee_evidence
from .directory import digest64
from .storage import canonical


class CompactProofClient:
    def __init__(self,path,binary,genesis):
        self.binary,self.genesis=str(Path(binary).resolve()),str(Path(genesis).resolve())
        if str(path)!=':memory:' and os.path.normcase(str(Path(path).resolve())) in {os.path.normcase(self.binary),os.path.normcase(self.genesis)}:
            raise ValueError('proof_state_must_be_separate')
        raw=Path(self.genesis).read_bytes();config=json.loads(raw)
        if (config.get('app_state') or {}).get('state_commitment')!='sfera-mesh-state-merkle-v1':
            raise ValueError('compact_proof_genesis_required')
        self.pin=sha256(raw).hexdigest();self.network=config['chain_id'];self.lock=threading.RLock()
        self.db=sqlite3.connect(path,check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('CREATE TABLE IF NOT EXISTS proof_pin(singleton INTEGER PRIMARY KEY CHECK(singleton=1),genesis TEXT NOT NULL); CREATE TABLE IF NOT EXISTS proof_checkpoint(singleton INTEGER PRIMARY KEY CHECK(singleton=1),height INTEGER NOT NULL,header_hash TEXT NOT NULL);')
        self.db.execute('CREATE TABLE IF NOT EXISTS proof_committees(singleton INTEGER PRIMARY KEY CHECK(singleton=1),history BLOB NOT NULL)')
        try:
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                old=self.db.execute('SELECT genesis FROM proof_pin').fetchone()
                if old and old[0]!=self.pin:raise ValueError('proof_genesis_changed')
                self.db.execute('INSERT OR IGNORE INTO proof_pin VALUES(1,?)',(self.pin,))
        except Exception:self.db.close();raise

    def close(self):
        with self.lock:self.db.close()

    def _checkpoint(self,verified):
        history=verified.get('committee_history',[])
        if not isinstance(history,list) or len(history)>16:raise ValueError('invalid_verified_committee_history')
        with self.lock,self.db:
            self.db.execute('BEGIN IMMEDIATE')
            old=self.db.execute('SELECT height,header_hash FROM proof_checkpoint').fetchone()
            if old and (verified['height']<old[0] or verified['height']==old[0] and verified['header_hash']!=old[1]):raise ValueError('block_proof_rollback_or_fork')
            prior=self.db.execute('SELECT history FROM proof_committees').fetchone()
            if prior:
                known=json.loads(prior[0])
                if len(history)<len(known) or canonical(history[:len(known)])!=canonical(known):raise ValueError('committee_history_rollback_or_fork')
            self.db.execute('INSERT OR REPLACE INTO proof_checkpoint VALUES(1,?,?)',(verified['height'],verified['header_hash']))
            self.db.execute('INSERT OR REPLACE INTO proof_committees VALUES(1,?)',(canonical(history),))

    def _native(self,evidence):
        if sha256(Path(self.genesis).read_bytes()).hexdigest()!=self.pin:raise ValueError('proof_genesis_changed')
        raw=canonical(evidence)
        if len(raw)>524288:raise ValueError('proof_evidence_too_large')
        result=subprocess.run([self.binary,'--verify-state-proof-genesis',self.genesis],input=raw,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=8,check=False)
        if result.returncode:raise ConsensusUnavailable('invalid_or_stale_block_proof')
        verified=json.loads(result.stdout)
        if verified['network']!=self.network or type(verified['height']) is not int or not digest64(verified['header_hash']) or not time.time()<verified['expires_at']<=time.time()+35:
            raise ValueError('block_proof_context_mismatch')
        return verified

    def verify_page(self,evidence,cluster,*,offset,limit=16,minimum_height=1):
        if not digest64(cluster) or type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=64 or type(minimum_height) is not int or minimum_height<1:
            raise ValueError('invalid_manifest_page_request')
        if not isinstance(evidence,dict) or set(evidence)-{'committee_transitions'}!={'page','signed_header'} or len(canonical(evidence))>786432:
            raise ValueError('invalid_manifest_page_evidence')
        evidence=json.loads(canonical(evidence));page=evidence['page']
        if not isinstance(page,dict) or set(page)!={'meta','entries','offset'} or type(page['offset']) is not int or page['offset']!=offset:
            raise ValueError('manifest_page_offset_mismatch')
        trust = {'committee_transitions': evidence['committee_transitions']} if 'committee_transitions' in evidence else {}
        meta=self._native({'proof':page['meta'],'signed_header':evidence['signed_header'],**trust})
        leaf=meta['leaf'];value=leaf['value']
        if leaf['key']!=f'manifest/{cluster}/meta' or not isinstance(value,dict) or set(value)!={'head','count','sized'} or value['sized'] is not True or type(value['count']) is not int or not 0<=value['count']<=512 or offset>value['count'] or meta['height']<minimum_height:
            raise ValueError('invalid_manifest_page_meta')
        total=value['count'];head=value['head'];body=head['record']['body']
        if not digest64(head['digest']) or body['cluster']!=cluster or body['network']!=self.network or not digest64(body['placement_hash']) or type(body['version']) is not int or body['version']<1 or type(body['epoch']) is not int or body['epoch']<1:
            raise ValueError('invalid_manifest_page_head')
        entries=page['entries']
        if not isinstance(entries,list) or len(entries)!=min(limit,total-offset):raise ValueError('manifest_page_incomplete')
        result=[]
        first=page['meta']['index']-total
        if first<0:raise ValueError('invalid_manifest_page_range')
        for index,proof in enumerate(entries):
            verified=self._native({'proof':proof,'signed_header':evidence['signed_header'],**trust})
            prefix=f'manifest/{cluster}/entry/'
            key=verified['leaf']['key'];entry=verified['leaf']['value']
            digest=key[len(prefix):] if key.startswith(prefix) else ''
            if verified['height']!=meta['height'] or verified['header_hash']!=meta['header_hash'] or proof['index']!=first+offset+index or proof['count']!=page['meta']['count'] or not digest64(digest):
                raise ValueError('manifest_page_gap_or_context')
            if not isinstance(entry,dict) or set(entry)!={'size','manifest_hash','version','epoch','placement_hash'} or type(entry['size']) is not int or not 1<=entry['size']<=262144 or any(type(entry[field]) is not int for field in ('version','epoch')) or entry['manifest_hash']!=head['digest'] or entry['version']!=body['version'] or entry['epoch']!=body['epoch'] or entry['placement_hash']!=body['placement_hash']:
                raise ValueError('manifest_page_entry_mismatch')
            result.append({'digest':digest,'size':entry['size']})
        self._checkpoint(meta)
        return {'consensus_committed':True,'cluster':cluster,'offset':offset,'total':total,'entries':result,
                'manifest_hash':head['digest'],'manifest_version':body['version'],
                'height':meta['height'],'header_hash':meta['header_hash'],'expires_at':meta['expires_at']}

    def fetch_page(self,address,cluster,*,offset=0,limit=16,minimum_height=1):
        if not digest64(cluster) or type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=64:raise ValueError('invalid_manifest_page_request')
        query=canonical({'cluster':cluster,'offset':offset,'limit':limit})
        response=rpc(address,'abci_query',{'path':'/manifest-page','data':query.hex(),'prove':False})['response']
        if response.get('code',0):raise ConsensusUnavailable('manifest_page_unavailable')
        raw=base64.b64decode(response['value'],validate=True)
        if len(raw)>250000:raise ValueError('manifest_page_too_large')
        page=json.loads(raw)
        if str(page['meta']['height'])!=str(response['height']):raise ValueError('proof_query_height_mismatch')
        deadline=time.monotonic()+4
        while True:
            try:header=rpc(address,'commit',{'height':str(page['meta']['height']+1)})['signed_header'];break
            except ConsensusUnavailable:
                if time.monotonic()>=deadline:raise
                time.sleep(.15)
        transitions=committee_evidence(address,page['meta']['height'])
        return self.verify_page({'page':page,'signed_header':header,**({'committee_transitions':transitions} if transitions else {})},cluster,offset=offset,limit=limit,minimum_height=minimum_height)

    def fetch_manifest(self,address,cluster,*,page_size=16,minimum_height=1):
        """Collect one immutable index; never silently mix two manifest versions."""
        if type(page_size) is not int or not 1<=page_size<=64:raise ValueError('invalid_manifest_page_request')
        offset=0;entries=[];identity=None;last=None
        while True:
            page=self.fetch_page(address,cluster,offset=offset,limit=page_size,minimum_height=minimum_height)
            current=(page['manifest_hash'],page['manifest_version'],page['total'])
            if identity is not None and current!=identity:raise ConsensusUnavailable('manifest_changed_during_pagination')
            identity=current;last=page
            entries.extend(page['entries']);offset+=len(page['entries'])
            if offset==page['total']:break
            if not page['entries'] or offset>512:raise ValueError('manifest_page_incomplete')
        return {**last,'offset':0,'entries':entries}

    def verify(self,evidence,cluster,digest,*,size=None,minimum_height=1):
        if not digest64(cluster) or not digest64(digest) or type(minimum_height) is not int or minimum_height<1 or size is not None and (type(size) is not int or not 1<=size<=262144):
            raise ValueError('invalid_block_proof_request')
        if sha256(Path(self.genesis).read_bytes()).hexdigest()!=self.pin:raise ValueError('proof_genesis_changed')
        raw=canonical(evidence)
        if len(raw)>524288:raise ValueError('proof_evidence_too_large')
        result=subprocess.run([self.binary,'--verify-state-proof-genesis',self.genesis],input=raw,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=8,check=False)
        if result.returncode:raise ConsensusUnavailable('invalid_or_stale_block_proof')
        verified=json.loads(result.stdout)
        leaf=verified['leaf'];value=leaf['value'];height=verified['height']
        if verified['network']!=self.network or leaf['key']!=f'manifest/{cluster}/entry/{digest}' or type(height) is not int or height<minimum_height or not digest64(verified['header_hash']) or not time.time()<verified['expires_at']<=time.time()+35:
            raise ValueError('block_proof_context_mismatch')
        if not isinstance(value,dict) or set(value)!={'size','manifest_hash','version','epoch','placement_hash'} or type(value['size']) is not int or not 1<=value['size']<=262144 or size is not None and value['size']!=size or any(not digest64(value[field]) for field in ('manifest_hash','placement_hash')) or any(type(value[field]) is not int or value[field]<1 for field in ('version','epoch')):
            raise ValueError('block_proof_value_mismatch')
        self._checkpoint(verified)
        return {'consensus_committed':True,'network':self.network,'cluster':cluster,'digest':digest,**value,
                'height':height,'header_hash':verified['header_hash'],'expires_at':verified['expires_at']}

    def verify_recovery_tree(self, evidence, publisher, source, scope, *, entries=(), minimum_height=1):
        """One fresh BFT head proof plus bounded sparse inclusion/absence proofs.

        This verifies the requested leaves, not completeness of an application
        feed. Each page must separately verify its encrypted index references.
        """
        from .recovery_roots import namespace
        from .recovery_tree import validate_head, path_root
        key = namespace(publisher, source, scope)
        if type(minimum_height) is not int or minimum_height < 1:
            raise ValueError('invalid_recovery_tree_minimum_height')
        entries = json.loads(canonical(list(entries)))
        if len(entries) > 32 or len(canonical(entries)) > 300000:
            raise ValueError('recovery_tree_proof_page_limit')
        verified = self._native(evidence)
        leaf = verified['leaf']
        if leaf['key'] != f'recovery-tree/{key}/head' or verified['height'] < minimum_height:
            raise ValueError('recovery_tree_proof_context_mismatch')
        head = leaf['value']
        if not isinstance(head, dict) or set(head) != {'record', 'digest'}:
            raise ValueError('invalid_recovery_tree_proof_head')
        body, digest = validate_head(head['record'], self.network, self.pin)
        if (digest != head['digest'] or (body['publisher'], body['source'], body['scope']) != (publisher, source, scope)):
            raise ValueError('recovery_tree_proof_context_mismatch')
        seen, result = set(), []
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {'message', 'status', 'path'}:
                raise ValueError('invalid_recovery_tree_leaf_proof')
            if path_root(entry['message'], entry['status'], entry['path']) != body['root'] or entry['message'] in seen:
                raise ValueError('recovery_tree_leaf_proof_mismatch')
            seen.add(entry['message'])
            result.append({'message': entry['message'], 'status': entry['status']})
        self._checkpoint(verified)
        return {'consensus_committed': True, 'head': head, 'entries': result,
            'height': verified['height'], 'header_hash': verified['header_hash'], 'expires_at': verified['expires_at']}

    def fetch(self,address,cluster,digest,*,size=None,minimum_height=1):
        if not digest64(cluster) or not digest64(digest):raise ValueError('invalid_block_proof_request')
        key=f'manifest/{cluster}/entry/{digest}'
        response=rpc(address,'abci_query',{'path':'/state-proof','data':key.encode().hex(),'prove':False})['response']
        if response.get('code',0):raise ConsensusUnavailable('block_proof_unavailable')
        raw=base64.b64decode(response['value'],validate=True)
        if len(raw)>16384:raise ValueError('block_proof_too_large')
        proof=json.loads(raw)
        if type(proof.get('height')) is not int or str(proof['height'])!=str(response['height']):raise ValueError('proof_query_height_mismatch')
        deadline=time.monotonic()+4
        while True:
            try:
                header=rpc(address,'commit',{'height':str(proof['height']+1)})['signed_header'];break
            except ConsensusUnavailable:
                if time.monotonic()>=deadline:raise
                time.sleep(.15)
        transitions=committee_evidence(address,proof['height'])
        return self.verify({'proof':proof,'signed_header':header,**({'committee_transitions':transitions} if transitions else {})},cluster,digest,size=size,minimum_height=minimum_height)
