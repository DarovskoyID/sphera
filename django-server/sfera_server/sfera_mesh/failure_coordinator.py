"""Durable aggregation of three fixed-genesis observer reports; loopback lab."""
import base64
from hashlib import sha256
from itertools import combinations
import json
from pathlib import Path
import sqlite3
import threading
import time
from urllib.error import HTTPError
from .consensus_directory import ConsensusDirectory, validate_address, rpc
from .directory import digest64
from .failures import validate_observations
from .identity import node_id
from .refresh_lock import RefreshLock
from .resources import validate_resource
from .storage import canonical
from .transport import exchange,validate_peer_endpoint


class FailureCoordinator:
    def __init__(self,path,directory,address,key,verifier,assessors):
        validate_address(address)
        if not isinstance(directory,ConsensusDirectory) or set(assessors)!=set(directory.placement_assessors) or len(assessors)!=4 or verifier.network!=directory.network or verifier.recipient!=node_id(key.public_key().public_bytes_raw()):
            raise ValueError('four_pinned_failure_assessors_required')
        observers=set()
        for item in assessors.values():
            if not isinstance(item,dict) or set(item)!={'observer','endpoint'} or item['observer'] not in verifier.roster or item['observer'] in observers:
                raise ValueError('independent_failure_inventory_required')
            validate_peer_endpoint(verifier,item['observer'],item['endpoint']); observers.add(item['observer'])
        self.directory,self.address,self.key,self.verifier=directory,address,key,verifier
        self.assessors=json.loads(canonical(assessors))
        self.bindings={identity:item['observer'] for identity,item in assessors.items()}
        self.lock=threading.RLock()
        self.process_lock=RefreshLock(None if str(path)==':memory:' else str(Path(path).resolve())+'.failure.lock')
        self.db=sqlite3.connect(path,check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS failure_pin(singleton INTEGER PRIMARY KEY CHECK(singleton=1),context BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS failure_jobs(cluster TEXT PRIMARY KEY,record BLOB,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at REAL NOT NULL DEFAULT 0,error TEXT);
        ''')
        try:
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                context=canonical({'genesis':directory.pin,'node':verifier.recipient,'assessors':assessors})
                old=self.db.execute('SELECT context FROM failure_pin').fetchone()
                if old and old[0]!=context: raise ValueError('failure_coordinator_context_changed')
                self.db.execute('INSERT OR IGNORE INTO failure_pin VALUES(1,?)',(context,))
        except Exception:
            self.db.close(); raise

    def close(self):
        with self.lock: self.db.close()

    def status(self,cluster):
        with self.lock:
            row=self.db.execute('SELECT state,error FROM failure_jobs WHERE cluster=?',(cluster,)).fetchone()
            return dict(zip(('state','error'),row)) if row else {'state':'idle','error':None}

    def _request(self,assessor,operation,payload):
        item=self.assessors[assessor]
        try:
            return exchange(item['endpoint'],self.key,self.verifier,item['observer'],operation,payload)
        except HTTPError as exc:
            exc.close(); raise

    def step(self,cluster):
        if not digest64(cluster): raise ValueError('invalid_failure_cluster')
        with self.lock:
            if not self.process_lock.acquire(): return {'state':'busy','error':None}
            try:
                row=self.db.execute('SELECT record,retry_at FROM failure_jobs WHERE cluster=?',(cluster,)).fetchone()
                if row and row[1]>time.time(): return self.status(cluster)
                self.directory.refresh(self.address)
                pending=json.loads(row[0]) if row and row[0] else None
                with self.directory.lock:
                    self.directory.anchor()
                    if pending:
                        old=self.directory.current['state'].get('resources',{}).get(pending['body']['node_id'])
                        if old and old['digest']==sha256(canonical(pending)).hexdigest():
                            with self.db: self.db.execute("UPDATE failure_jobs SET state='confirmed',retry_at=?,attempts=0,error=NULL WHERE cluster=?",(time.time()+2,cluster))
                            # Continue gathering on a later tick, not replaying old evidence.
                            with self.db: self.db.execute('UPDATE failure_jobs SET record=NULL WHERE cluster=?',(cluster,))
                            return self.status(cluster)
                        if pending['body']['expires_at']<=int(time.time()) or old is None or old['digest']!=pending['body']['previous']:
                            pending=None
                if pending is None:
                    reports=[]
                    for assessor in sorted(self.assessors):
                        try:
                            record=self._request(assessor,'failure-observation',{'cluster':cluster})
                            if sha256(bytes.fromhex(record['public_key'])).hexdigest()==assessor:
                                reports.append(record)
                        except (ValueError,OSError,KeyError,TypeError): continue
                    evidence=observations=None
                    for group in combinations(reports,3):
                        try:
                            evidence=validate_observations(list(group),self.directory,self.bindings)
                            observations=list(group); break
                        except ValueError: continue
                    if evidence is None: raise ValueError('independent_failure_quorum_unavailable')
                    with self.directory.lock:
                        self.directory.anchor()
                        state=self.directory.current['state']
                        old=state.get('resources',{}).get(evidence['node_id'])
                        candidate=state['candidates'][evidence['node_id']]
                        if old is None: raise ValueError('prior_resource_assessment_required')
                        if old['record']['body']['capacity_slots']==0 and old['record']['body']['candidate_hash']==evidence['candidate_hash'] and old['record']['body']['expires_at']>int(time.time()):
                            return {'state':'already_revoked','error':None}
                        now=int(time.time())
                        body={'domain':'sfera-mesh-resource-v1','network':self.directory.network,'node_id':evidence['node_id'],'candidate_hash':evidence['candidate_hash'],'version':old['record']['body']['version']+1,'previous':old['digest'],'failure_domain':old['record']['body']['failure_domain'],'capacity_slots':0,'issued_at':now,'expires_at':min(now+15,evidence['expires_at'],candidate['record']['body']['license']['claims']['expires_at'])}
                    consents=[]
                    for observation in observations:
                        assessor=sha256(bytes.fromhex(observation['public_key'])).hexdigest()
                        response=self._request(assessor,'failure-consent',{'body':body,'observations':observations})
                        consents.append(response['consent'])
                    pending={'body':body,'consents':sorted(consents,key=lambda consent:consent['public_key'])}
                    validate_resource(pending,self.directory.network,self.directory.placement_assessors)
                    with self.db:
                        self.db.execute("INSERT INTO failure_jobs(cluster,record,state) VALUES(?,?,'prepared') ON CONFLICT(cluster) DO UPDATE SET record=excluded.record,state='prepared',error=NULL",(cluster,canonical(pending)))
                result=rpc(self.address,'broadcast_tx_sync',{'tx':base64.b64encode(canonical(pending)).decode()})
                if result.get('code',0): raise ValueError('failure_revocation_rejected')
                with self.db: self.db.execute("UPDATE failure_jobs SET state='submitted',retry_at=?,error=NULL WHERE cluster=?",(time.time()+2,cluster))
                return self.status(cluster)
            except (ValueError,OSError,sqlite3.Error,KeyError,TypeError) as exc:
                if isinstance(exc,HTTPError): exc.close()
                with self.db:
                    self.db.execute("INSERT OR IGNORE INTO failure_jobs(cluster,state) VALUES(?,'waiting')",(cluster,))
                    attempts=self.db.execute('SELECT attempts FROM failure_jobs WHERE cluster=?',(cluster,)).fetchone()[0]+1
                    error=str(exc) if isinstance(exc,ValueError) and len(str(exc))<=96 else 'failure_quorum_unavailable'
                    self.db.execute("UPDATE failure_jobs SET state='waiting',attempts=?,retry_at=?,error=? WHERE cluster=?",(attempts,time.time()+min(15,2**min(attempts,4)),error,cluster))
                return self.status(cluster)
            finally: self.process_lock.release()
