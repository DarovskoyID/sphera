"""Durable positive-only renewals by three independent pinned assessors."""
import base64
from hashlib import sha256
import json
import re
from pathlib import Path
import sqlite3
import threading
import time
from urllib.error import HTTPError
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .consensus_directory import ConsensusDirectory, ConsensusUnavailable, validate_address, rpc
from .directory import digest64, ZERO
from .identity import node_id
from .refresh_lock import RefreshLock
from .resources import validate_resource, validate_resource_body
from .storage import canonical
from .transport import exchange,validate_peer_endpoint


class CapacityRenewal:
    def __init__(self, path, directory, address, key, verifier, assessors, failure_domains, *, slots=2, ttl=55, renew_before=20):
        validate_address(address)
        if not isinstance(directory,ConsensusDirectory) or len(assessors)!=4 or set(assessors)!=set(directory.placement_assessors) or verifier.network!=directory.network or verifier.recipient!=node_id(key.public_key().public_bytes_raw()):
            raise ValueError('four_pinned_capacity_assessors_required')
        observers=set()
        for item in assessors.values():
            if not isinstance(item,dict) or set(item)!={'observer','endpoint'} or item['observer'] not in verifier.roster or item['observer'] in observers:
                raise ValueError('independent_capacity_inventory_required')
            validate_peer_endpoint(verifier,item['observer'],item['endpoint']); observers.add(item['observer'])
        if type(slots) is not int or slots not in (1,2) or type(ttl) is not int or not 30<=ttl<=60 or type(renew_before) is not int or not 5<=renew_before<ttl:
            raise ValueError('invalid_positive_renewal_schedule')
        self.directory,self.address,self.key,self.verifier=directory,address,key,verifier
        self.assessors=json.loads(canonical(assessors))
        self.domains=dict(failure_domains)
        if not 1<=len(self.domains)<=64 or any(not digest64(node) or node not in verifier.roster or not isinstance(domain,str) or not re.fullmatch('[a-zA-Z0-9._-]{1,64}',domain) for node,domain in self.domains.items()):
            raise ValueError('pinned_capacity_domains_required')
        self.slots,self.ttl,self.renew_before=slots,ttl,renew_before
        self.lock=threading.RLock()
        self.process_lock=RefreshLock(None if str(path)==':memory:' else str(Path(path).resolve())+'.capacity.lock')
        self.db=sqlite3.connect(path,check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS capacity_pin(singleton INTEGER PRIMARY KEY CHECK(singleton=1),context BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS capacity_jobs(node TEXT PRIMARY KEY,record BLOB,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at REAL NOT NULL DEFAULT 0,error TEXT);
        ''')
        try:
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                context=canonical({'genesis':directory.pin,'node':verifier.recipient,'assessors':self.assessors,'domains':self.domains,'slots':slots,'ttl':ttl,'renew_before':renew_before})
                old=self.db.execute('SELECT context FROM capacity_pin').fetchone()
                if old and old[0]!=context: raise ValueError('capacity_renewal_context_changed')
                self.db.execute('INSERT OR IGNORE INTO capacity_pin VALUES(1,?)',(context,))
        except Exception:
            self.db.close(); raise

    def close(self):
        with self.lock: self.db.close()

    def status(self,node):
        with self.lock:
            row=self.db.execute('SELECT state,error FROM capacity_jobs WHERE node=?',(node,)).fetchone()
            return dict(zip(('state','error'),row)) if row else {'state':'idle','error':None}

    def _fresh(self,state,node,now):
        candidate=state.get('candidates',{}).get(node)
        old=state.get('resources',{}).get(node)
        return bool(candidate and candidate['record']['body']['available'] and old and old['record']['body']['candidate_hash']==candidate['digest'] and old['record']['body']['failure_domain']==self.domains[node] and old['record']['body']['capacity_slots']>0 and old['record']['body']['expires_at']>now+self.renew_before)

    def _mark_fresh(self,node):
        status=self.status(node)
        if status['state']=='fresh': return status
        with self.db:
            self.db.execute("INSERT INTO capacity_jobs(node,state) VALUES(?,'fresh') ON CONFLICT(node) DO UPDATE SET record=NULL,state='fresh',attempts=0,retry_at=0,error=NULL",(node,))
        return self.status(node)

    def step(self,node):
        if not digest64(node) or node not in self.domains: raise ValueError('pinned_capacity_target_required')
        with self.lock:
            if not self.process_lock.acquire(): return {'state':'busy','error':None}
            try:
                row=self.db.execute('SELECT record,retry_at FROM capacity_jobs WHERE node=?',(node,)).fetchone()
                if row and row[1]>time.time(): return self.status(node)
                # A fresh verified cache can avoid 64 identical RPC refreshes.
                # It only skips work; it never signs or extends an assessment.
                if not row or row[0] is None:
                    with self.directory.lock:
                        try:
                            self.directory.anchor()
                        except ConsensusUnavailable:
                            pass
                        else:
                            if self._fresh(self.directory.current['state'],node,int(time.time())):
                                return self._mark_fresh(node)
                self.directory.refresh(self.address)
                with self.directory.lock:
                    self.directory.anchor()
                    state=self.directory.current['state']
                    old=state.get('resources',{}).get(node)
                    candidate=state.get('candidates',{}).get(node)
                    now=int(time.time())
                    if not candidate or not candidate['record']['body']['available']: raise ValueError('available_capacity_candidate_required')
                    pending=json.loads(row[0]) if row and row[0] else None
                    if pending and old and old['digest']==sha256(canonical(pending)).hexdigest():
                        with self.db: self.db.execute("UPDATE capacity_jobs SET record=NULL,state='confirmed',attempts=0,retry_at=0,error=NULL WHERE node=?",(node,))
                        return self.status(node)
                    if pending and (pending['body']['expires_at']<=now or pending['body']['candidate_hash']!=candidate['digest'] or pending['body']['previous']!=(old['digest'] if old else ZERO)):
                        pending=None
                    if pending is None:
                        if self._fresh(state,node,now):
                            return self._mark_fresh(node)
                        expires=min(now+self.ttl,candidate['record']['body']['license']['claims']['expires_at'])
                        if expires<=now+self.renew_before: raise ValueError('candidate_license_renewal_required')
                        body={'domain':'sfera-mesh-resource-v1','network':self.directory.network,'node_id':node,'candidate_hash':candidate['digest'],'version':old['record']['body']['version']+1 if old else 1,'previous':old['digest'] if old else ZERO,'failure_domain':self.domains[node],'capacity_slots':self.slots,'issued_at':now,'expires_at':expires}
                        validate_resource_body(body,self.directory.network)
                if pending is None:
                    consents=[]
                    for assessor,item in sorted(self.assessors.items()):
                        try:
                            response=exchange(item['endpoint'],self.key,self.verifier,item['observer'],'capacity-consent',{'body':body})
                            consent=response['consent']
                            if sha256(bytes.fromhex(consent['public_key'])).hexdigest()!=assessor: continue
                            Ed25519PublicKey.from_public_bytes(bytes.fromhex(consent['public_key'])).verify(bytes.fromhex(consent['signature']),canonical(body))
                            consents.append(consent)
                        except HTTPError as exc: exc.close()
                        except (ValueError,OSError,KeyError,TypeError,InvalidSignature): continue
                        if len(consents)==3: break
                    pending={'body':body,'consents':sorted(consents,key=lambda item:item['public_key'])}
                    validate_resource(pending,self.directory.network,self.directory.placement_assessors)
                    with self.db:
                        self.db.execute("INSERT INTO capacity_jobs(node,record,state) VALUES(?,?,'prepared') ON CONFLICT(node) DO UPDATE SET record=excluded.record,state='prepared',retry_at=0,error=NULL",(node,canonical(pending)))
                validate_resource(pending,self.directory.network,self.directory.placement_assessors)
                result=rpc(self.address,'broadcast_tx_sync',{'tx':base64.b64encode(canonical(pending)).decode()})
                if result.get('code',0): raise ValueError('capacity_renewal_rejected')
                with self.db: self.db.execute("UPDATE capacity_jobs SET state='submitted',retry_at=?,error=NULL WHERE node=?",(time.time()+2,node))
                return self.status(node)
            except (ValueError,OSError,sqlite3.Error) as exc:
                if isinstance(exc,HTTPError): exc.close()
                with self.db:
                    self.db.execute("INSERT OR IGNORE INTO capacity_jobs(node,state) VALUES(?,'waiting')",(node,))
                    attempts=self.db.execute('SELECT attempts FROM capacity_jobs WHERE node=?',(node,)).fetchone()[0]+1
                    error=str(exc) if isinstance(exc,ValueError) and len(str(exc))<=96 else 'capacity_renewal_unavailable'
                    self.db.execute("UPDATE capacity_jobs SET state='waiting',attempts=?,retry_at=?,error=? WHERE node=?",(attempts,time.time()+min(60,2**min(attempts,6)),error,node))
                return self.status(node)
            finally:
                self.process_lock.release()
