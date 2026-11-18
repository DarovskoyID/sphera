"""Replicated laboratory approval history; never changes active validator votes."""
import base64
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import threading
import time
from urllib.error import HTTPError
from .admission_registry import AdmissionRegistry
from .consensus_directory import rpc
from .directory import digest64
from .identity import node_id
from .refresh_lock import RefreshLock
from .storage import canonical


def committee_from_assessors(assessors):
    return {node_id(bytes.fromhex(public)):public for public in assessors.values()}


def admission_snapshot(state,network,genesis,committee):
    histories,rotations = state.get('admissions',{}),state.get('admission_rotations',{})
    policy = state.get('admission_policy','')
    if not isinstance(histories,dict) or not isinstance(rotations,dict) or len(histories)>128 or len(rotations)>128:
        raise ValueError('invalid_admission_snapshot')
    if not histories:
        if policy or rotations: raise ValueError('admission_history_required')
        return None
    if state.get('genesis_pin')!=genesis or not digest64(policy): raise ValueError('admission_genesis_or_policy_mismatch')
    registry = AdmissionRegistry(':memory:',network,genesis,policy,committee)
    try:
        count = 0
        with registry.db:
            for node,history in histories.items():
                if not digest64(node) or not isinstance(history,list) or not 1<=len(history)<=33: raise ValueError('invalid_admission_history')
                for head in history:
                    count += 1
                    if count>640 or not isinstance(head,dict) or set(head)!={'application','approval','digest','accepted_at'} or type(head['accepted_at']) is not int or not 0<=head['accepted_at']<=state['block_time']:
                        raise ValueError('invalid_admission_snapshot_head')
                    registry.db.execute('INSERT INTO admission_history VALUES(?,?,?,?,?,?)',
                        (node,head['approval']['body']['version'],head['digest'],canonical(head['application']),canonical(head['approval']),head['accepted_at']))
            for digest,link in rotations.items():
                if not digest64(digest) or not isinstance(link,dict) or set(link)!={'proof','old_node','new_node','accepted_at'}:
                    raise ValueError('invalid_admission_rotation_head')
                if type(link['accepted_at']) is not int or not 0<=link['accepted_at']<=state['block_time']: raise ValueError('invalid_admission_rotation_time')
                registry.db.execute('INSERT INTO admission_rotations VALUES(?,?,?,?,?)',
                                    (digest,link['old_node'],link['new_node'],canonical(link['proof']),link['accepted_at']))
        registry._verify_history()
        registry._verify_rotations()
        return registry
    except Exception:
        registry.close(); raise


def validate_admission_state(state,network,genesis,committee):
    registry = admission_snapshot(state,network,genesis,committee)
    if registry is not None: registry.close()


def admission_packet(network,operation,**fields):
    expected={'approve':{'application','approval'},'revoke':{'revocation'},'rotate':{'application','approval','revocation','rotation'}}
    if operation not in expected or set(fields)!=expected[operation]: raise ValueError('invalid_admission_packet')
    return {'body':{'domain':'sfera-mesh-admission-update-lab-v1','network':network,'operation':operation},**fields}


class AdmissionPublisher:
    def __init__(self,path,directory,address):
        from .consensus_directory import validate_address
        validate_address(address)
        self.directory,self.address = directory,address
        self.committee = committee_from_assessors(directory.placement_assessors)
        if not 4<=len(self.committee)<=16: raise ValueError('pinned_admission_authorities_required')
        self.lock = threading.RLock()
        self.process_lock = RefreshLock(None if str(path)==':memory:' else str(Path(path).resolve())+'.admission.lock')
        self.db = sqlite3.connect(path,check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('CREATE TABLE IF NOT EXISTS admission_publisher_pin(singleton INTEGER PRIMARY KEY CHECK(singleton=1),context BLOB NOT NULL); CREATE TABLE IF NOT EXISTS admission_outbox(digest TEXT PRIMARY KEY,packet BLOB NOT NULL,retry_at REAL NOT NULL DEFAULT 0);')
        try:
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                context=canonical({'genesis':directory.pin,'committee':self.committee})
                prior=self.db.execute('SELECT context FROM admission_publisher_pin').fetchone()
                if prior and prior[0]!=context: raise ValueError('admission_publisher_context_changed')
                self.db.execute('INSERT OR IGNORE INTO admission_publisher_pin VALUES(1,?)',(context,))
        except Exception:
            self.db.close(); raise

    def close(self):
        with self.lock: self.db.close()

    def step(self,packet):
        if not isinstance(packet,dict) or not isinstance(packet.get('body'),dict): raise ValueError('invalid_admission_packet')
        body=packet['body'];fields={key:value for key,value in packet.items() if key!='body'}
        if set(body)!={'domain','network','operation'} or canonical(packet)!=canonical(admission_packet(self.directory.network,body['operation'],**fields)) or len(canonical(packet))>16384:
            raise ValueError('invalid_admission_packet')
        with self.lock:
            if not self.process_lock.acquire(): return {'state':'busy'}
            try:
                self.directory.refresh(self.address)
                with self.directory.lock:
                    self.directory.anchor()
                    state=json.loads(canonical(self.directory.current['state']))
                if state.get('genesis_pin')!=self.directory.pin: raise ValueError('admission_genesis_pin_required')
                registry=admission_snapshot(state,self.directory.network,self.directory.pin,self.committee)
                if registry is None:
                    if body['operation']!='approve': raise ValueError('admission_history_required')
                    registry=AdmissionRegistry(':memory:',self.directory.network,self.directory.pin,packet['approval']['body']['policy'],self.committee)
                try:
                    at=state['block_time']
                    if body['operation']=='approve': result=registry.accept(packet['application'],packet['approval'],now=at)
                    elif body['operation']=='revoke': result=registry.revoke(packet['revocation'],now=at)
                    else: result=registry.rotate(packet['rotation'],packet['application'],packet['approval'],packet['revocation'],now=at)
                finally: registry.close()
                if not result['accepted']: return {'state':'confirmed','digest':result['digest'],'active_committee_changed':False}
                digest=sha256(canonical(packet)).hexdigest()
                row=self.db.execute('SELECT packet,retry_at FROM admission_outbox WHERE digest=?',(digest,)).fetchone()
                if row and row[1]>time.time(): return {'state':'waiting','digest':digest}
                if not row:
                    with self.db:
                        if self.db.execute('SELECT COUNT(*) FROM admission_outbox').fetchone()[0]>=128: raise ValueError('admission_outbox_limit')
                        self.db.execute('INSERT INTO admission_outbox(digest,packet) VALUES(?,?)',(digest,canonical(packet)))
                result=rpc(self.address,'broadcast_tx_sync',{'tx':base64.b64encode(canonical(packet)).decode()})
                if result.get('code',0): raise ValueError('admission_transaction_rejected')
                with self.db:self.db.execute('UPDATE admission_outbox SET retry_at=? WHERE digest=?',(time.time()+2,digest))
                return {'state':'submitted','digest':digest,'active_committee_changed':False}
            except OSError as exc:
                if isinstance(exc,HTTPError):exc.close()
                return {'state':'waiting','error':'admission_publish_unavailable'}
            finally:self.process_lock.release()
