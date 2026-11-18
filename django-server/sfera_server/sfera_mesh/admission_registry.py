"""Bounded local laboratory approval history; confers no consensus votes."""
from hashlib import sha256
import json
import sqlite3
import threading
import time
from .admission import _context,verify_approval
from .admission_revocation import verify_revocation
from .admission_rotation import verify_rotation
from .directory import ZERO,digest64
from .identity import node_id
from .storage import canonical


class AdmissionRegistry:
    def __init__(self,path,network,genesis,policy,committee):
        _context(network,genesis,policy)
        if not isinstance(committee,dict) or not 3<=len(committee)<=16 or any(not digest64(identity) or not digest64(public) or node_id(bytes.fromhex(public))!=identity for identity,public in committee.items()):
            raise ValueError('pinned_admission_committee_required')
        self.network,self.genesis,self.policy=network,genesis,policy
        self.committee=json.loads(canonical(committee))
        self.lock=threading.RLock()
        self.db=sqlite3.connect(path,check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('CREATE TABLE IF NOT EXISTS admission_pin(singleton INTEGER PRIMARY KEY CHECK(singleton=1),context BLOB NOT NULL); CREATE TABLE IF NOT EXISTS admission_history(node TEXT NOT NULL,version INTEGER NOT NULL,digest TEXT NOT NULL UNIQUE,application BLOB NOT NULL,approval BLOB NOT NULL,accepted_at INTEGER NOT NULL,PRIMARY KEY(node,version));')
        self.db.execute('CREATE TABLE IF NOT EXISTS admission_rotations(digest TEXT PRIMARY KEY,old_node TEXT NOT NULL UNIQUE,new_node TEXT NOT NULL UNIQUE,proof BLOB NOT NULL,accepted_at INTEGER NOT NULL)')
        try:
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                pin=canonical({'network':network,'genesis':genesis,'policy':policy,'committee':self.committee})
                old=self.db.execute('SELECT context FROM admission_pin').fetchone()
                if old and old[0]!=pin: raise ValueError('admission_registry_context_changed')
                self.db.execute('INSERT OR IGNORE INTO admission_pin VALUES(1,?)',(pin,))
                self._verify_history()
                self._verify_rotations()
        except Exception:
            self.db.close(); raise

    def close(self):
        with self.lock: self.db.close()

    def _verify(self,request,record,at,version,previous,head=None):
        if head and head['approval']['body']['domain']=='sfera-mesh-admission-revocation-lab-v1':
            raise ValueError('admission_registry_node_revoked')
        if record.get('body',{}).get('domain')=='sfera-mesh-admission-revocation-lab-v1':
            if head is None or canonical(request)!=canonical(head['application']): raise ValueError('admission_revocation_anchor_required')
            return verify_revocation(record,head,self.network,self.genesis,self.policy,self.committee,now=at)
        return verify_approval(record,request,self.network,self.genesis,self.policy,self.committee,now=at,expected_version=version,expected_previous=previous)

    def _verify_history(self):
        rows=self.db.execute('SELECT node,version,digest,application,approval,accepted_at FROM admission_history ORDER BY node,version LIMIT 641').fetchall()
        if len(rows)>640: raise ValueError('admission_registry_limit')
        heads={}; approvals=0
        for node,version,digest,request,record,at in rows:
            request,record=json.loads(request),json.loads(record)
            old=heads.get(node)
            expected=old[0]+1 if old else 1
            previous=old[1] if old else ZERO
            revoking=record['body']['domain']=='sfera-mesh-admission-revocation-lab-v1'
            approvals+=not revoking
            if approvals>512: raise ValueError('admission_registry_limit')
            if version!=expected or version>(33 if revoking else 32) or type(at) is not int or request['body']['node_id']!=node or (old and (at<old[2] or request['body']['operator']!=old[3])) or self._verify(request,record,at,expected,previous,old[4] if old else None)!=digest:
                raise ValueError('invalid_admission_registry_history')
            heads[node]=(version,digest,at,request['body']['operator'],{'application':request,'approval':record,'digest':digest,'accepted_at':at})
        if len(heads)>128: raise ValueError('admission_registry_limit')

    def accept(self,request,record,*,now=None):
        now=int(time.time()) if now is None else now
        request=json.loads(canonical(request)); record=json.loads(canonical(record))
        body=request.get('body') if isinstance(request,dict) else None
        approval_body=record.get('body') if isinstance(record,dict) else None
        if type(now) is not int or not isinstance(body,dict) or not digest64(body.get('node_id')) or not isinstance(approval_body,dict) or type(approval_body.get('version')) is not int:
            raise ValueError('invalid_admission_registry_record')
        node,version=body['node_id'],approval_body['version']
        with self.lock,self.db:
            self.db.execute('BEGIN IMMEDIATE')
            return self._accept(request,record,now)

    def _accept(self,request,record,now):
        body=request['body']
        node,version=request['body']['node_id'],record['body']['version']
        old=self.db.execute('SELECT application,approval FROM admission_history WHERE node=? AND version=?',(node,version)).fetchone()
        if old:
            if old!=(canonical(request),canonical(record)): raise ValueError('admission_registry_version_conflict')
            # A historical retry neither extends expiry nor restores rights.
            return {'accepted':False,'digest':sha256(canonical(record)).hexdigest()}
        head=self.db.execute('SELECT version,digest,accepted_at,application,approval FROM admission_history WHERE node=? ORDER BY version DESC LIMIT 1',(node,)).fetchone()
        expected=head[0]+1 if head else 1
        previous=head[1] if head else ZERO
        if head and (now<head[2] or body.get('operator')!=json.loads(head[3])['body']['operator']):
            raise ValueError('admission_registry_identity_or_time_changed')
        prior={'application':json.loads(head[3]),'approval':json.loads(head[4]),'digest':head[1],'accepted_at':head[2]} if head else None
        digest=self._verify(request,record,now,expected,previous,prior)
        revoking=record['body']['domain']=='sfera-mesh-admission-revocation-lab-v1'
        # Keep room for one terminal revocation per node even when the
        # ordinary approval history has reached its laboratory bound.
        if expected>(33 if revoking else 32) or self.db.execute('SELECT COUNT(*) FROM admission_history').fetchone()[0]>=(640 if revoking else 512) or (not head and self.db.execute('SELECT COUNT(DISTINCT node) FROM admission_history').fetchone()[0]>=128):
            raise ValueError('admission_registry_limit')
        self.db.execute('INSERT INTO admission_history VALUES(?,?,?,?,?,?)',(node,version,digest,canonical(request),canonical(record),now))
        return {'accepted':True,'digest':digest}

    def revoke(self,record,*,now=None):
        body=record.get('body') if isinstance(record,dict) else None
        if not isinstance(body,dict) or not digest64(body.get('node_id')): raise ValueError('invalid_admission_revocation')
        with self.lock:
            head=self.head(body['node_id'])
            if head is None: raise ValueError('admission_revocation_anchor_required')
            return self.accept(head['application'],record,now=now)

    def history(self,node):
        if not digest64(node): raise ValueError('invalid_admission_node')
        with self.lock:
            rows=self.db.execute('SELECT application,approval,digest,accepted_at FROM admission_history WHERE node=? ORDER BY version',(node,)).fetchall()
            return [{'application':json.loads(request),'approval':json.loads(record),'digest':digest,'accepted_at':at} for request,record,digest,at in rows]

    def head(self,node,*,now=None):
        now=int(time.time()) if now is None else now
        if type(now) is not int: raise ValueError('invalid_admission_time')
        history=self.history(node)
        if not history: return None
        result=history[-1]
        body=result['approval']['body']
        revoked=body['domain']=='sfera-mesh-admission-revocation-lab-v1'
        return {**result,'revoked':revoked,'document_live':not revoked and body['issued_at']<=now<body['expires_at']}

    def rotate(self,proof,request,approved,revoked,*,now):
        proof,request,approved,revoked=json.loads(canonical([proof,request,approved,revoked]))
        digest=sha256(canonical(proof)).hexdigest()
        with self.lock,self.db:
            self.db.execute('BEGIN IMMEDIATE')
            existing=self.db.execute('SELECT old_node,new_node FROM admission_rotations WHERE digest=?',(digest,)).fetchone()
            if existing:
                source=self.history(existing[0]); target=self.history(existing[1])
                if canonical(source[-1]['approval'])!=canonical(revoked) or canonical(target[0]['application'])!=canonical(request) or canonical(target[0]['approval'])!=canonical(approved):
                    raise ValueError('admission_rotation_retry_conflict')
                return {'accepted':False,'digest':digest}
            source=self.db.execute('SELECT node FROM admission_history WHERE digest=?',(proof['body']['previous'],)).fetchone()
            if source is None: raise ValueError('admission_rotation_anchor_required')
            head=self.head(source[0],now=now); target=request['body']['node_id']
            if head['digest']!=proof['body']['previous'] or self.history(target):
                raise ValueError('admission_rotation_conflict')
            verify_rotation(proof,head,request,approved,self.network,self.genesis,self.policy,self.committee,now=now)
            if revoked['body']['reason']!=digest: raise ValueError('admission_rotation_revocation_required')
            self._accept(head['application'],revoked,now)
            self._accept(request,approved,now)
            self.db.execute('INSERT INTO admission_rotations VALUES(?,?,?,?,?)',(digest,source[0],target,canonical(proof),now))
            return {'accepted':True,'digest':digest}

    def _verify_rotations(self):
        rows=self.db.execute('SELECT digest,old_node,new_node,proof,accepted_at FROM admission_rotations LIMIT 129').fetchall()
        if len(rows)>128: raise ValueError('admission_registry_limit')
        for digest,old,new,proof,at in rows:
            source=self.history(old); target=self.history(new)
            proof=json.loads(proof)
            if len(source)<2 or not target or source[-1]['accepted_at']!=at or target[0]['accepted_at']!=at or source[-1]['approval']['body'].get('reason')!=digest or verify_rotation(proof,source[-2],target[0]['application'],target[0]['approval'],self.network,self.genesis,self.policy,self.committee,now=at)!=digest:
                raise ValueError('invalid_admission_rotation_history')
