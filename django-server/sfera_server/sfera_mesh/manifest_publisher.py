"""One durable laboratory request to include ciphertext sizes in consensus."""
import base64
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import threading
import time
from urllib.error import HTTPError
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .consensus_directory import ConsensusDirectory,validate_address,rpc
from .directory import ZERO,digest64
from .identity import node_id
from .manifests import manifest_body,validate_manifest
from .refresh_lock import RefreshLock
from .storage import canonical
from .transport import exchange,validate_peer_endpoint
from .write_capacity import check_write_capacity


def initialize_manifest_schema(db):
    db.executescript('CREATE TABLE IF NOT EXISTS manifest_pin(singleton INTEGER PRIMARY KEY CHECK(singleton>=1),context BLOB NOT NULL); CREATE TABLE IF NOT EXISTS manifest_job(singleton INTEGER PRIMARY KEY CHECK(singleton>=1),record BLOB,state TEXT NOT NULL,retry_at REAL NOT NULL DEFAULT 0,error TEXT);')


class ManifestPublisher:
    def __init__(self,path,directory,address,key,verifier,endpoints,*,cluster,sizes,job_id=1):
        if type(job_id) is not int or not 1<=job_id<=2**53-1:raise ValueError('manifest_job_id')
        self.job_id=job_id
        validate_address(address)
        if not isinstance(directory,ConsensusDirectory) or directory.network!=verifier.network or verifier.recipient!=node_id(key.public_key().public_bytes_raw()) or not digest64(cluster):
            raise ValueError('matching_manifest_publisher_required')
        if not isinstance(sizes,dict) or not 1<=len(sizes)<=512 or any(not digest64(digest) or type(size) is not int or not 1<=size<=262144 for digest,size in sizes.items()):
            raise ValueError('invalid_manifest_publisher_sizes')
        if not 3<=len(endpoints)<=64 or any(identity not in verifier.roster for identity in endpoints): raise ValueError('pinned_manifest_endpoints_required')
        for peer,endpoint in endpoints.items(): validate_peer_endpoint(verifier,peer,endpoint)
        self.directory,self.address,self.key,self.verifier=directory,address,key,verifier
        self.endpoints,self.cluster,self.sizes=dict(endpoints),cluster,dict(sizes)
        self.lock=threading.RLock()
        self.process_lock=RefreshLock(None if str(path)==':memory:' else str(Path(path).resolve())+'.manifest.lock')
        self.db=sqlite3.connect(path,check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        initialize_manifest_schema(self.db)
        try:
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                context=canonical({'genesis':directory.pin,'node':verifier.recipient,'cluster':cluster,'sizes':self.sizes,'endpoints':self.endpoints})
                old=self.db.execute('SELECT context FROM manifest_pin WHERE singleton=?',(self.job_id,)).fetchone()
                if old and old[0]!=context: raise ValueError('manifest_publisher_context_changed')
                self.db.execute('INSERT OR IGNORE INTO manifest_pin VALUES(?,?)',(self.job_id,context))
        except Exception:
            self.db.close(); raise

    def close(self):
        with self.lock: self.db.close()

    def status(self):
        with self.lock:
            row=self.db.execute('SELECT state,error FROM manifest_job WHERE singleton=?',(self.job_id,)).fetchone()
            return dict(zip(('state','error'),row)) if row else {'state':'idle','error':None}

    def step(self):
        with self.lock:
            if not self.process_lock.acquire(): return {'state':'busy','error':None}
            try:
                row=self.db.execute('SELECT record,state,retry_at FROM manifest_job WHERE singleton=?',(self.job_id,)).fetchone()
                if row and (row[1]=='confirmed' or row[2]>time.time()): return self.status()
                self.directory.refresh(self.address)
                with self.directory.lock:
                    self.directory.anchor()
                    head=self.directory.placement(self.cluster)
                    placement={'record':head['record'],'digest':head['record_hash']}
                    old=self.directory.current['state'].get('manifests',{}).get(self.cluster)
                    prior=old['record']['body'] if old else None
                    known=dict(zip(prior['digests'],prior['sizes'])) if prior and 'sizes' in prior else {}
                    if all(known.get(digest)==size for digest,size in self.sizes.items()):
                        with self.db: self.db.execute("INSERT INTO manifest_job(singleton,state) VALUES(?,'confirmed') ON CONFLICT(singleton) DO UPDATE SET state='confirmed',error=NULL,retry_at=0",(self.job_id,))
                        return self.status()
                    if any(digest in known and known[digest]!=size for digest,size in self.sizes.items()): raise ValueError('manifest_committed_size_conflict')
                    sizes={**known,**self.sizes}
                    if prior and not set(prior['digests']).issubset(sizes): raise ValueError('existing_manifest_sizes_required')
                    body=manifest_body(self.directory.network,placement,sorted(sizes),version=prior['version']+1 if prior else 1,previous=old['digest'] if old else ZERO,sizes=sizes)
                    check_write_capacity(self.directory.current['state'], self.cluster, sizes)
                    members=list(head['record']['body']['members'])
                    if self.verifier.recipient not in members: raise ValueError('manifest_current_holder_required')
                pending=json.loads(row[0]) if row and row[0] else None
                if pending is None or canonical(pending['body'])!=canonical(body):
                    consents=[]
                    for identity in members:
                        if identity not in self.endpoints: continue
                        try:
                            result=exchange(self.endpoints[identity],self.key,self.verifier,identity,'manifest-consent',{'body':body})
                            consent=result['consent']; public=bytes.fromhex(consent['public_key']); signature=bytes.fromhex(consent['signature'])
                            if set(consent)!={'public_key','signature'} or result['body_hash']!=sha256(canonical(body)).hexdigest() or node_id(public)!=identity or public.hex()!=consent['public_key'] or len(signature)!=64 or signature.hex()!=consent['signature']: raise ValueError('invalid_manifest_consent')
                            Ed25519PublicKey.from_public_bytes(public).verify(signature,canonical(body))
                            consents.append(consent)
                        except (ValueError,OSError,KeyError,TypeError,InvalidSignature) as exc:
                            if isinstance(exc,HTTPError): exc.close()
                            continue
                        if len(consents)==2: break
                    pending={'body':body,'consents':sorted(consents,key=lambda consent:consent['public_key'])}
                    validate_manifest(pending,self.directory.network,placement)
                    with self.db: self.db.execute("INSERT INTO manifest_job(singleton,record,state) VALUES(?,?,'prepared') ON CONFLICT(singleton) DO UPDATE SET record=excluded.record,state='prepared',error=NULL,retry_at=0",(self.job_id,canonical(pending)))
                result=rpc(self.address,'broadcast_tx_sync',{'tx':base64.b64encode(canonical(pending)).decode()})
                if result.get('code',0): raise ValueError('manifest_transaction_rejected')
                with self.db: self.db.execute("UPDATE manifest_job SET state='submitted',retry_at=?,error=NULL WHERE singleton=?",(time.time()+2,self.job_id))
                return self.status()
            except (ValueError,OSError,sqlite3.Error) as exc:
                if isinstance(exc,HTTPError): exc.close()
                error=str(exc) if isinstance(exc,ValueError) and len(str(exc))<=96 else 'manifest_publish_unavailable'
                with self.db: self.db.execute("INSERT INTO manifest_job(singleton,state,retry_at,error) VALUES(?,'waiting',?,?) ON CONFLICT(singleton) DO UPDATE SET state='waiting',retry_at=excluded.retry_at,error=excluded.error",(self.job_id,time.time()+5,error))
                return self.status()
            finally: self.process_lock.release()
