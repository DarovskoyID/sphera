"""Durable one-request initial batch controller; no participant keys held."""
import base64
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import threading
import time
from urllib.error import HTTPError
from .consensus_directory import ConsensusDirectory, validate_address, rpc
from .directory import ZERO
from .identity import node_id
from .initial_planning import initial_batch
from .placements import cluster_id, validate_placement, verify_placement_licenses
from .refresh_lock import RefreshLock
from .storage import canonical
from .transport import exchange,validate_peer_endpoint


def initial_proposals(directory,count):
    with directory.lock:
        plan=directory.initial_plan(count)
        if not plan['complete']: raise ValueError('complete_initial_plan_unavailable')
        proposals=[]
        state=directory.current['state']
        for group in plan['groups']:
            cluster=cluster_id(directory.network,group)
            if cluster in state.get('placements',{}): raise ValueError('initial_cluster_already_exists')
            documents=[state['candidates'][node]['record']['body']['license'] for node in group]
            body={'domain':'sfera-mesh-placement-v2','network':directory.network,'cluster':cluster,
                  'epoch':1,'previous':ZERO,'members':group,'licenses_hash':sha256(canonical(documents)).hexdigest()}
            proposals.append({'body':body,'licenses':documents})
        return plan,json.loads(canonical(proposals))


class InitialController:
    def __init__(self,path,directory,address,key,verifier,endpoints,*,count):
        validate_address(address)
        if not isinstance(directory,ConsensusDirectory) or not directory.placement_assessors or verifier.network!=directory.network or verifier.recipient!=node_id(key.public_key().public_bytes_raw()) or type(count) is not int or not 1<=count<=4:
            raise ValueError('matching_initial_controller_required')
        if not 3<=len(endpoints)<=64 or any(node not in verifier.roster for node in endpoints): raise ValueError('pinned_initial_endpoints_required')
        for peer,endpoint in endpoints.items(): validate_peer_endpoint(verifier,peer,endpoint)
        self.directory,self.address,self.key,self.verifier=directory,address,key,verifier
        self.endpoints,self.count=dict(endpoints),count
        self.lock=threading.RLock()
        self.process_lock=RefreshLock(None if str(path)==':memory:' else str(Path(path).resolve())+'.initial.lock')
        self.db=sqlite3.connect(path,check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS initial_pin(singleton INTEGER PRIMARY KEY CHECK(singleton=1),context BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS initial_job(singleton INTEGER PRIMARY KEY CHECK(singleton=1),record BLOB,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at REAL NOT NULL DEFAULT 0,error TEXT);
        ''')
        try:
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                context=canonical({'genesis':directory.pin,'node':verifier.recipient,'count':count,'endpoints':self.endpoints})
                old=self.db.execute('SELECT context FROM initial_pin').fetchone()
                if old and old[0]!=context: raise ValueError('initial_controller_context_changed')
                self.db.execute('INSERT OR IGNORE INTO initial_pin VALUES(1,?)',(context,))
        except Exception:
            self.db.close(); raise

    def close(self):
        with self.lock: self.db.close()

    def status(self):
        with self.lock:
            row=self.db.execute('SELECT state,error FROM initial_job').fetchone()
            return dict(zip(('state','error'),row)) if row else {'state':'idle','error':None}

    def step(self):
        with self.lock:
            if not self.process_lock.acquire(): return {'state':'busy','error':None}
            try:
                row=self.db.execute('SELECT record,state,retry_at FROM initial_job').fetchone()
                if row and (row[1]=='confirmed' or row[2]>time.time()): return self.status()
                self.directory.refresh(self.address)
                pending=json.loads(row[0]) if row and row[0] else None
                with self.directory.lock:
                    self.directory.anchor()
                    if pending and sha256(canonical(pending)).hexdigest() in self.directory.current['state'].get('initial_batches',{}):
                        with self.db: self.db.execute("UPDATE initial_job SET state='confirmed',attempts=0,retry_at=0,error=NULL")
                        return self.status()
                    if pending:
                        expiry=min(document['claims']['expires_at'] for record in pending['placements'] for document in record['licenses'])
                        # Absence from an authenticated snapshot after an
                        # irreversible license deadline proves this old packet
                        # cannot still commit. A wall-clock timeout does not.
                        if self.directory.current['state']['block_time']>=expiry:
                            pending=None
                    plan,proposals=initial_proposals(self.directory,self.count)
                issuers={identity:bytes.fromhex(public) for identity,public in self.directory.license_issuers.items()}
                reusable=pending is not None and pending['body']['pool_hash']==plan['pool_hash'] and canonical([{'body':record['body'],'licenses':record['licenses']} for record in pending['placements']])==canonical(proposals)
                if reusable:
                    try:
                        for record in pending['placements']: verify_placement_licenses(record,issuers)
                    except ValueError: reusable=False
                if pending is not None and not reusable:
                    raise ValueError('initial_outbox_waiting_finalized_expiry')
                if not reusable:
                    if any(node not in self.endpoints for group in plan['groups'] for node in group): raise ValueError('initial_endpoint_not_pinned')
                    records=[]
                    for proposal in proposals:
                        consents=[]
                        for node in proposal['body']['members']:
                            payload={'count':self.count,'pool_hash':plan['pool_hash'],'proposal':proposal}
                            result=exchange(self.endpoints[node],self.key,self.verifier,node,'initial-consent',payload)
                            consents.append(result['consent'])
                        record={**proposal,'consents':consents}
                        validate_placement(record,self.directory.network)
                        records.append(record)
                    # The last signer may have seen the old pool just before
                    # another transaction committed. Discard unsent consents
                    # rather than persisting a packet already known to be stale.
                    self.directory.refresh(self.address)
                    with self.directory.lock:
                        self.directory.anchor()
                        latest,latest_proposals=initial_proposals(self.directory,self.count)
                        if latest['pool_hash']!=plan['pool_hash'] or canonical(latest_proposals)!=canonical(proposals):
                            raise ValueError('initial_plan_changed_before_send')
                    pending=initial_batch(plan,records)
                    if len(canonical(pending))>65536: raise ValueError('initial_batch_too_large')
                    with self.db:
                        self.db.execute("INSERT INTO initial_job(singleton,record,state) VALUES(1,?,'prepared') ON CONFLICT(singleton) DO UPDATE SET record=excluded.record,state='prepared',retry_at=0,error=NULL",(canonical(pending),))
                result=rpc(self.address,'broadcast_tx_sync',{'tx':base64.b64encode(canonical(pending)).decode()})
                if result.get('code',0): raise ValueError('initial_batch_rejected')
                with self.db: self.db.execute("UPDATE initial_job SET state='submitted',retry_at=?,error=NULL",(time.time()+2,))
                return self.status()
            except (ValueError,OSError,sqlite3.Error) as exc:
                if isinstance(exc,HTTPError): exc.close()
                with self.db:
                    self.db.execute("INSERT OR IGNORE INTO initial_job(singleton,state) VALUES(1,'waiting')")
                    attempts=self.db.execute('SELECT attempts FROM initial_job').fetchone()[0]+1
                    error=str(exc) if isinstance(exc,ValueError) and len(str(exc))<=96 else 'initial_batch_unavailable'
                    self.db.execute("UPDATE initial_job SET state='waiting',attempts=?,retry_at=?,error=?",(attempts,time.time()+min(60,2**min(attempts,6)),error))
                return self.status()
            finally: self.process_lock.release()
