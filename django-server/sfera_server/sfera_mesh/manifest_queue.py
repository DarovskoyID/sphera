"""Bounded durable runtime manifest intake; authenticated current holders only."""
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import threading
from .directory import digest64
from .manifest_publisher import ManifestPublisher,initialize_manifest_schema
from .storage import canonical


class ManifestQueue:
    def __init__(self,path,directory,address,key,verifier,endpoints,store):
        self.path,self.directory,self.address,self.key,self.verifier,self.endpoints,self.store=path,directory,address,key,verifier,dict(endpoints),store
        self.lock=threading.RLock();self.cursor=0
        self.db=sqlite3.connect(path,check_same_thread=False);self.db.execute('PRAGMA synchronous=FULL')
        initialize_manifest_schema(self.db)
        self.db.executescript('''CREATE TABLE IF NOT EXISTS manifest_queue_pin(id INTEGER PRIMARY KEY,context BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS manifest_requests(id INTEGER PRIMARY KEY AUTOINCREMENT,digest TEXT UNIQUE NOT NULL,sender TEXT NOT NULL,body BLOB NOT NULL,state TEXT NOT NULL);''')
        try:
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                context=canonical({'genesis':directory.pin,'node':verifier.recipient,'endpoints':self.endpoints})
                old=self.db.execute('SELECT context FROM manifest_queue_pin WHERE id=1').fetchone()
                if old and old[0]!=context:raise ValueError('manifest_queue_context_changed')
                self.db.execute('INSERT OR IGNORE INTO manifest_queue_pin VALUES(1,?)',(context,))
        except BaseException:self.db.close();raise

    def close(self):
        with self.lock:self.db.close()

    def authorize(self,sender,cluster):
        with self.directory.lock:
            self.directory.anchor();members=self.directory.placement(cluster)['record']['body']['members']
            if sender not in members or self.verifier.recipient not in members:raise ValueError('manifest_intake_current_holders_required')

    def submit(self,sender,body):
        if (not isinstance(body,dict) or set(body)!={'cluster','sizes'} or not digest64(body['cluster'])
                or not isinstance(body['sizes'],dict) or not 1<=len(body['sizes'])<=16
                or any(not digest64(d) or type(s) is not int or not 1<=s<=262144 for d,s in body['sizes'].items())):raise ValueError('bounded_manifest_intake_required')
        raw=canonical(body);self.authorize(sender,body['cluster'])
        for digest,size in body['sizes'].items():
            result=self.store.execute('get',{'digest':digest});data=bytes.fromhex(result.get('ciphertext',''))
            if len(data)!=size or sha256(data).hexdigest()!=digest:raise ValueError('manifest_intake_local_copy_required')
        digest=sha256(canonical({'sender':sender,'body':body})).hexdigest()
        with self.lock,self.db:
            self.db.execute('BEGIN IMMEDIATE')
            old=self.db.execute('SELECT state FROM manifest_requests WHERE digest=?',(digest,)).fetchone()
            if old:return {'request_id':digest,'state':old[0]}
            if self.db.execute("SELECT COUNT(*) FROM manifest_requests WHERE state!='confirmed'").fetchone()[0]>=64:raise ValueError('manifest_queue_full')
            # Keep bounded completion receipts, never reuse IDs/outbox slots.
            stale=self.db.execute("SELECT id FROM manifest_requests WHERE state='confirmed' ORDER BY id DESC LIMIT -1 OFFSET 1023").fetchall()
            for (job_id,) in stale:
                self.db.execute('DELETE FROM manifest_job WHERE singleton=?',(job_id,));self.db.execute('DELETE FROM manifest_pin WHERE singleton=?',(job_id,));self.db.execute('DELETE FROM manifest_requests WHERE id=?',(job_id,))
            self.db.execute("INSERT INTO manifest_requests(digest,sender,body,state) VALUES(?,?,?,'queued')",(digest,sender,raw))
        return {'request_id':digest,'state':'queued'}

    def receipt(self,sender,body):
        if not isinstance(body,dict) or set(body)!={'request_id'} or not digest64(body['request_id']):raise ValueError('manifest_receipt_request')
        with self.lock:row=self.db.execute('SELECT sender,body,state FROM manifest_requests WHERE digest=?',(body['request_id'],)).fetchone()
        if row is None:raise ValueError('unknown_manifest_request')
        self.authorize(sender,json.loads(row[1])['cluster'])
        return {'request_id':body['request_id'],'state':row[2]}

    def step(self):
        with self.lock:
            rows=self.db.execute("SELECT id,digest,body FROM manifest_requests WHERE state!='confirmed' ORDER BY id").fetchall()
        if not rows:return {'state':'idle'}
        job_id,digest,raw=next((row for row in rows if row[0]>self.cursor),rows[0]);self.cursor=job_id;body=json.loads(raw)
        publisher=ManifestPublisher(self.path,self.directory,self.address,self.key,self.verifier,self.endpoints,cluster=body['cluster'],sizes=body['sizes'],job_id=job_id)
        try:result=publisher.step()
        finally:publisher.close()
        with self.lock,self.db:self.db.execute('UPDATE manifest_requests SET state=? WHERE id=?',(result['state'],job_id))
        return {'request_id':digest,**result}
