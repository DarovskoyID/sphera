"""Replicated SDK documents and encrypted mail, with consensus-only OTK claims.

SDK-signed immutable operations are durable on a majority of approved points.
Reads reconcile a majority before returning. Acknowledgements are permanent
tombstones, so a delayed replica cannot resurrect acknowledged key mail.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from hashlib import sha256
import json
import time
import threading
import re
import secrets
import urllib.request

from sfera_mesh.storage import canonical
from sfera_mesh.identity import envelope, EnvelopeVerifier
from sfera_mesh.application_cipher import scope_for
from sfera_mesh.cipher_relay import CipherRelay, public, sdk_user
from sfera_mesh.application_keys import replay as key_pool
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature
from .signaling import application_peers


def entry_probe(origin,nonce):
    from sfera_mesh.consensus_directory import NoRedirect
    from sfera_mesh.public_transport import endpoint_url
    request=urllib.request.Request(endpoint_url(origin)+'/api/auth/mesh/entry/',data=canonical({'nonce':nonce}),
        headers={'Content-Type':'application/json'})
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    with opener.open(request,timeout=10) as response:
        raw=response.read(32769)
        if response.status!=200 or len(raw)>32768:raise ValueError('sdk_entry_probe_response')
    return json.loads(raw)


def post(origin, message):
    from sfera_mesh.consensus_directory import NoRedirect
    from sfera_mesh.public_transport import endpoint_url
    request = urllib.request.Request(endpoint_url(origin)+'/api/distribution/sdk/replica/',
        data=canonical(message), headers={'Content-Type':'application/json'})
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    with opener.open(request,timeout=10) as response:
        raw=response.read(1048577)
        if response.status!=200 or len(raw)>1048576:raise ValueError('sdk_replica_response')
    return json.loads(raw)


class SdkReplica:
    def __init__(self, authority, replay_path, *, peers=application_peers, transport=post, project=None, probe=entry_probe):
        self.backend=authority.sessions
        self.relay=CipherRelay(authority)
        self.peers,self.transport=peers,transport
        self.project=project
        self.probe=probe;self.discover_applications=peers is application_peers
        self.discovery_lock=threading.Lock()
        self.nodes=EnvelopeVerifier(self.backend.directory.network,self.backend.entry,{},replay_path)
        self.pool=ThreadPoolExecutor(max_workers=6,thread_name_prefix='sdk-replica')
        self.slots=threading.BoundedSemaphore(8)
        with self.backend.lock,self.backend.db:
            self.backend.db.executescript('''
                CREATE TABLE IF NOT EXISTS sdk_replica_operations(
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, device TEXT NOT NULL,
                    request TEXT NOT NULL, scope TEXT NOT NULL, roster TEXT NOT NULL,
                    epoch INTEGER NOT NULL, body BLOB NOT NULL,
                    UNIQUE(owner,device,request));
                CREATE TABLE IF NOT EXISTS sdk_replica_acks(
                    id TEXT NOT NULL, owner TEXT NOT NULL, device TEXT NOT NULL,
                    PRIMARY KEY(id,owner,device));
                CREATE TABLE IF NOT EXISTS sdk_replica_messages(
                    id TEXT PRIMARY KEY, scope TEXT NOT NULL, owner TEXT NOT NULL,
                    digest TEXT NOT NULL, operation TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sdk_replica_commits(id TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS sdk_application_entries(
                    identity TEXT PRIMARY KEY, origin TEXT NOT NULL, public_key BLOB NOT NULL);
            ''')

    def close(self):
        self.pool.shutdown(wait=True,cancel_futures=True)
        self.nodes.close()

    def roster(self):
        directory=self.backend.directory
        with directory.lock:
            directory.anchor()
            peers=self.peers(directory)
            if self.backend.entry not in peers:raise ValueError('sdk_entry_not_active')
        return self.application_bindings(peers) if self.discover_applications else peers

    def application_bindings(self,peers):
        # Consensus membership also contains seed/validator transport identities.
        # Several may share a host with one application process. Bind that
        # process to its exact approved key using a fresh signed entry challenge;
        # never count identities merely because they share an HTTPS address.
        with self.discovery_lock:
            with self.backend.lock:
                saved=self.backend.db.execute('SELECT identity,origin,public_key FROM sdk_application_entries').fetchall()
            result={i:peers[i] for i,origin,key in saved if i in peers
                and peers[i]['origin']==origin and peers[i]['public_key']==bytes(key)}
            origins={p['origin'] for p in peers.values()}
            unknown=origins-{p['origin'] for p in result.values()}
            def discover(origin):
                nonce=secrets.token_hex(32);value=self.probe(origin,nonce)
                if not isinstance(value,dict) or set(value)!={'body','signature'}:raise ValueError('sdk_entry_probe_schema')
                b=value['body'];now=int(time.time())
                if (not isinstance(b,dict) or set(b) not in (
                        {'domain','network','genesis','entry','nonce','issued_at','expires_at'},
                        {'domain','network','genesis','entry','nonce','issued_at','expires_at','profile_guard'})
                        or b.get('domain')!='sfera-mesh-application-entry-v1'
                        or b.get('network')!=self.backend.directory.network or b.get('genesis')!=self.backend.directory.pin
                        or b.get('nonce')!=nonce or b.get('entry') not in peers
                        or peers[b['entry']]['origin']!=origin or type(b.get('issued_at')) is not int
                        or not now-15<=b['issued_at']<=now+5 or b.get('expires_at')!=b['issued_at']+15
                        or b['expires_at']<=now):raise ValueError('sdk_entry_probe_context')
                Ed25519PublicKey.from_public_bytes(peers[b['entry']]['public_key']).verify(bytes.fromhex(value['signature']),canonical(b))
                return b['entry']
            if unknown:
                with ThreadPoolExecutor(max_workers=6,thread_name_prefix='sdk-entry-discovery') as pool:
                    identities=list(pool.map(discover,sorted(unknown)))
                with self.backend.lock,self.backend.db:
                    for identity in identities:
                        peer=peers[identity]
                        self.backend.db.execute('INSERT OR REPLACE INTO sdk_application_entries VALUES(?,?,?)',
                            (identity,peer['origin'],peer['public_key']))
                        result[identity]=peer
            if self.backend.entry not in result:raise ValueError('sdk_application_entry_not_active')
            return result

    def verify(self, record, *, historical=False):
        with self.backend.directory.lock:
            return self._verify(record,historical=historical)

    def _verify(self, record, *, historical=False):
        if not isinstance(record,dict) or set(record)!={'body','signature'} or len(canonical(record))>280000:
            raise ValueError('sdk_operation_schema')
        b=record['body']
        if not isinstance(b,dict) or set(b)!={'domain','network','genesis','owner','device','source','scope','roster','epoch','request','issued_at','expires_at'}:
            raise ValueError('sdk_operation_schema')
        d=self.backend.directory
        if b['domain']!='sfera-mesh-sdk-relay-v1' or b['network']!=d.network or b['genesis']!=d.pin or b['source'] not in ('dm','device'):
            raise ValueError('sdk_operation_context')
        now=int(time.time())
        if (type(b['issued_at']) is not int or type(b['expires_at']) is not int
                or not 60<=b['expires_at']-b['issued_at']<=61 or b['issued_at']>now+5
                or not historical and b['expires_at']<=now):raise ValueError('sdk_operation_expired')
        if b['source']=='device':
            if not isinstance(b['request'],dict):raise ValueError('sdk_request_schema')
            from sfera_mesh.application_profiles import application_user_id
            state=d.current['state'];history=state.get('devices',{}).get(b['owner'],[]);active=False
            for head in history:
                event=head['event']['body']
                if event['device_id']==b['device']:active=event['operation']=='enroll'
            pin=state.get('cipher_devices',{}).get(b['owner']+':'+b['device'])
            if not active or pin is None or b['scope']!=application_user_id(d.network,b['owner']) or b['request'].get('type')!=0:
                raise ValueError('sdk_device_bootstrap_actor')
            shared={'certificates':[pin['certificate']],'epoch':len(history),'roster':sha256(canonical([
                'sfera-mesh-sdk-device-scope-v1',d.network,d.pin,b['owner'],b['device'],len(history)])).hexdigest()}
        else:shared=scope_for(d.current['state'],d.network,d.pin,b['scope'])
        if b['roster']!=shared['roster'] or type(b['epoch']) is not int or b['epoch']!=shared['epoch']:
            raise ValueError('sdk_operation_roster_changed')
        peers={(sdk_user(c['body']),c['body']['device']):c['body'] for c in shared['certificates']}
        own=next((p for p in peers.values() if (p['owner'],p['device'])==(b['owner'],b['device'])),None)
        if own is None:raise ValueError('sdk_operation_actor')
        try:Ed25519PublicKey.from_public_bytes(public(own['ed25519'])).verify(public(record['signature'],64),canonical(b))
        except InvalidSignature as exc:raise ValueError('sdk_operation_signature') from exc
        r=b['request']
        if (not isinstance(r,dict) or set(r)!={'id','type','body'} or type(r['type']) is not int
                or r['type'] not in (0,1,3,4,5,6) or not isinstance(r['id'],str)
                or not 1<=len(r['id'])<=256 or not isinstance(r['body'],str) or len(r['body'].encode())>262144):
            raise ValueError('sdk_request_schema')
        body=json.loads(r['body'])
        if not isinstance(body,dict):raise ValueError('sdk_request_body')
        # Public OTK/fallback uploads and claims belong exclusively to BFT.
        if r['type']==0 and set(body)-{'device_keys'}:raise ValueError('sdk_keys_require_consensus')
        if r['type']==6:
            from sfera_messages.dm_cipher import parse,authorize
            from sfera_mesh.application_profiles import application_user_id
            if set(body)!={'cipher','queued_at'} or type(body['queued_at']) is not int or not 0<body['queued_at']<=now*1000+300000:
                raise ValueError('sdk_message_schema')
            value=parse(body['cipher'],b['scope'],author=application_user_id(d.network,b['owner']))
            authorize(value,{'domain':'sfera-mesh-cipher-scope-v2','network':d.network,'genesis':d.pin,**shared},
                {'owner':b['owner'],'device':b['device']})
        semantic={k:v for k,v in b.items() if k not in ('issued_at','expires_at')}
        return b,body,own,peers,sha256(canonical(semantic)).hexdigest()

    def apply(self, record):
        b,body,own,peers,identity=self.verify(record,historical=True)
        request=b['request'];db=self.backend.db
        if request['type'] not in (0,3,5,6):raise ValueError('sdk_write_required')
        with self.backend.lock,db:
            db.execute('BEGIN IMMEDIATE')
            old=db.execute('SELECT id FROM sdk_replica_operations WHERE owner=? AND device=? AND request=?',
                (b['owner'],b['device'],request['id'])).fetchone()
            if old:
                if old[0]!=identity:raise ValueError('sdk_request_conflict')
                return identity
            count,size=db.execute('SELECT COUNT(*),COALESCE(SUM(LENGTH(body)),0) FROM sdk_replica_operations').fetchone()
            if count>=16384 or size+len(canonical(record))>64*1024*1024:raise ValueError('sdk_replica_capacity')
            if db.execute('SELECT COUNT(*) FROM sdk_replica_operations WHERE scope=? AND roster=? AND epoch=?',
                    (b['scope'],b['roster'],b['epoch'])).fetchone()[0]>=4096:raise ValueError('sdk_scope_capacity')
            if request['type']==6:
                message=body['cipher'];digest=sha256(canonical(message)).hexdigest()
                previous=db.execute('SELECT digest,operation FROM sdk_replica_messages WHERE id=?',(message['id'],)).fetchone()
                if previous and previous!=(digest,identity):raise ValueError('sdk_message_identity_conflict')
                db.execute('INSERT OR IGNORE INTO sdk_replica_messages VALUES(?,?,?,?,?)',
                    (message['id'],b['scope'],b['owner'],digest,identity))
            else:
                self.relay._perform(request['type'],body,own,peers,'dm',b['scope'],b['roster'],b['epoch'],
                    mail_identity=lambda owner,device:sha256(canonical([identity,owner,device])).hexdigest())
            if request['type']==5:
                for mail in body['ids']:
                    db.execute('INSERT OR IGNORE INTO sdk_replica_acks VALUES(?,?,?)',(mail,b['owner'],b['device']))
            db.execute('DELETE FROM cipher_relay_mail WHERE EXISTS(SELECT 1 FROM sdk_replica_acks a WHERE a.id=cipher_relay_mail.id AND a.owner=cipher_relay_mail.owner AND a.device=cipher_relay_mail.device)')
            db.execute('INSERT INTO sdk_replica_operations VALUES(?,?,?,?,?,?,?,?)',
                (identity,b['owner'],b['device'],request['id'],b['scope'],b['roster'],b['epoch'],canonical(record)))
        return identity

    def local(self, mode, record, ids=None):
        b,body,own,peers,_=self.verify(record,historical=mode=='repair')
        if mode in ('write','repair'):return {'stored':self.apply(record)}
        if mode not in ('inventory','fetch') or b['request']['type'] not in (0,1,4,6):raise ValueError('sdk_read_required')
        with self.backend.lock:
            rows=self.backend.db.execute('SELECT id,body FROM sdk_replica_operations WHERE scope=? AND roster=? AND epoch=? ORDER BY id',
                (b['scope'],b['roster'],b['epoch'])).fetchall()
        if mode=='inventory':
            if len(rows)>4096:raise ValueError('sdk_scope_capacity')
            result={'ids':[r[0] for r in rows]}
            if b['request']['type']==1:
                with self.backend.lock:
                    result['documents']=self.relay._perform(1,body,own,peers,'dm',b['scope'],b['roster'],b['epoch'])
            return result
        if not isinstance(ids,list) or not 1<=len(ids)<=2 or any(not isinstance(v,str) or len(v)!=64 for v in ids):raise ValueError('sdk_fetch_schema')
        return {'records':[json.loads(raw) for identity,raw in rows if identity in ids]}

    def receive(self,message):
        peers=self.roster();self.nodes.roster={k:v['public_key'] for k,v in peers.items()}
        sender,payload=self.nodes.verify(message,'sdk-replica-v1')
        if not isinstance(payload,dict) or set(payload)!={'mode','record','ids'}:raise ValueError('sdk_replica_payload')
        with self.backend.directory.lock:
            result=self.local(payload['mode'],payload['record'],payload['ids'])
        return envelope(self.backend.entry_key,self.backend.directory.network,sender,'sdk-replica-reply-v1',
            {'nonce':message['record']['nonce'],'result':result})

    def exchange(self,identity,peer,mode,record,ids=None):
        message=envelope(self.backend.entry_key,self.backend.directory.network,identity,'sdk-replica-v1',{'mode':mode,'record':record,'ids':ids})
        reply=self.transport(peer['origin'],message)
        sender,payload=self.nodes.verify(reply,'sdk-replica-reply-v1')
        if sender!=identity or set(payload)!={'nonce','result'} or payload['nonce']!=message['record']['nonce']:raise ValueError('sdk_replica_reply')
        return payload['result']

    def request(self,record,user,claim):
        if not self.slots.acquire(blocking=False):raise ValueError('sdk_replica_quorum_unavailable')
        try:return self._request(record,user,claim)
        finally:self.slots.release()

    def _request(self,record,user,claim):
        d=self.backend.directory
        peers=self.roster();self.nodes.roster={k:v['public_key'] for k,v in peers.items()}
        with d.lock,self.backend.lock:
            self.backend.require(user,claim)
            b,body,own,scope_peers,identity=self.verify(record)
            if (b['owner'],b['device'])!=(claim['owner'],claim['device']):raise ValueError('sdk_session_actor')
        kind=b['request']['type'];mode='write' if kind in (0,3,5,6) else 'inventory'
        result=self.local(mode,record);success=1
        futures={self.pool.submit(self.exchange,i,p,mode,record):i for i,p in peers.items() if i!=self.backend.entry}
        for future in as_completed(futures):
            try:
                response=future.result()
                if mode=='write':
                    if response!={'stored':identity}:raise ValueError('sdk_write_receipt')
                else:
                    ids=response.get('ids')
                    if not isinstance(ids,list) or len(ids)>4096 or len(set(ids))!=len(ids):raise ValueError('sdk_inventory')
                    if kind==1:
                        docs=response.get('documents')
                        if not isinstance(docs,dict) or set(docs)!={'device_keys','failures'}:raise ValueError('sdk_device_documents')
                        for target_user,devices in docs['device_keys'].items():
                            for device,doc in devices.items():
                                peer=scope_peers.get((target_user,device))
                                if peer is None:raise ValueError('sdk_device_not_member')
                                with self.backend.lock,self.backend.db:
                                    self.relay._perform(0,{'device_keys':doc},peer,scope_peers,'dm',b['scope'],b['roster'],b['epoch'])
                    with self.backend.lock:
                        known={row[0] for row in self.backend.db.execute('SELECT id FROM sdk_replica_operations')}
                    missing=[v for v in ids if v not in known]
                    for start in range(0,len(missing),2):
                        wanted=missing[start:start+2]
                        fetched=self.exchange(futures[future],peers[futures[future]],'fetch',record,wanted)
                        records=fetched.get('records')
                        if not isinstance(records,list) or len(records)!=len(wanted):raise ValueError('sdk_fetch_incomplete')
                        for item in records:
                            if any(item['body'][k]!=b[k] for k in ('source','scope','roster','epoch')):raise ValueError('sdk_fetch_scope')
                            if self.apply(item) not in wanted:raise ValueError('sdk_fetch_substitution')
                success+=1
                if success>=2*len(peers)//3+1:break
            except (OSError,ValueError,TypeError,KeyError,InvalidSignature) as exc:
                import logging
                reason=str(exc) if isinstance(exc,ValueError) and re.fullmatch('[a-z][a-z0-9_]{0,95}',str(exc)) else type(exc).__name__
                logging.getLogger(__name__).warning('SDK peer exchange rejected: %s',reason)
                continue
        if success<2*len(peers)//3+1:raise ValueError('sdk_replica_quorum_unavailable')
        if set(self.roster())!=set(peers):raise ValueError('sdk_replica_membership_changed')
        if mode=='write':
            with self.backend.lock,self.backend.db:
                self.backend.db.execute('INSERT OR IGNORE INTO sdk_replica_commits VALUES(?)',(identity,))
        # A read may discover a write whose sender lost its connection before
        # replication completed. Repair it to a quorum before exposing it as
        # accepted, including after the original SDK request has expired.
        with self.backend.lock:
            pending=self.backend.db.execute('SELECT o.id,o.body FROM sdk_replica_operations o LEFT JOIN sdk_replica_commits c ON c.id=o.id WHERE o.scope=? AND o.roster=? AND o.epoch=? AND c.id IS NULL',
                (b['scope'],b['roster'],b['epoch'])).fetchall()
        for operation_id,raw in pending:
            operation=json.loads(raw);repairs=1
            jobs=[self.pool.submit(self.exchange,i,p,'repair',operation) for i,p in peers.items() if i!=self.backend.entry]
            for future in as_completed(jobs):
                try:
                    if future.result()=={'stored':operation_id}:repairs+=1
                except (OSError,ValueError,TypeError,KeyError,InvalidSignature):continue
            if repairs<2*len(peers)//3+1:raise ValueError('sdk_replica_quorum_unavailable')
            with self.backend.lock,self.backend.db:
                self.backend.db.execute('INSERT OR IGNORE INTO sdk_replica_commits VALUES(?)',(operation_id,))
        with d.lock,self.backend.lock:
            d.anchor();self.backend.require(user,claim)
            self.verify(record)
            if self.project is not None:
                rows=self.backend.db.execute('SELECT body FROM sdk_replica_operations WHERE scope=? AND roster=? AND epoch=? ORDER BY id',
                    (b['scope'],b['roster'],b['epoch'])).fetchall()
                for (raw,) in rows:
                    operation=json.loads(raw)
                    if operation['body']['request']['type']==6:self.project(operation)
            if kind in (3,5,6):return {}
            if kind==0:
                pool=key_pool(d.current['state'],d.network,d.pin).get(b['owner']+':'+b['device'],{})
                return {'one_time_key_counts':{'signed_curve25519':sum(not v['consumed'] and not v['fallback'] for v in pool.values())}}
            return self.relay._perform(kind,body,own,scope_peers,'dm',b['scope'],b['roster'],b['epoch'])
