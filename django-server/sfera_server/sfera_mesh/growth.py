"""Three-holder prepared byte budgets, committed before growth-backed writes."""
import base64
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import threading
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .consensus_directory import ConsensusDirectory, rpc
from .directory import digest64
from .identity import node_id
from .refresh_lock import RefreshLock
from .storage import canonical


def growth_id(network, cluster, origin, token):
    return sha256(canonical({'domain':'sfera-mesh-growth-id-v1','network':network,'cluster':cluster,'origin':origin,'token':token})).hexdigest()


def validate_growth_body(body,network,placement,at):
    fields={'domain','network','cluster','epoch','placement_hash','origin','token','budget_id','amount','issued_at','prepare_expires_at'}
    if not isinstance(body,dict) or set(body)!=fields or body['domain']!='sfera-mesh-growth-v1' or body['network']!=network:
        raise ValueError('invalid_growth_body')
    if (any(not digest64(body[field]) for field in ('cluster','placement_hash','origin','token','budget_id')) or
            any(type(body[field]) is not int for field in ('epoch','amount','issued_at','prepare_expires_at')) or
            not 1<=body['amount']<=2**63-1 or body['cluster']!=placement['record']['body']['cluster'] or
            body['epoch']!=placement['record']['body']['epoch'] or body['placement_hash']!=placement['digest'] or
            body['origin'] not in placement['record']['body']['members'] or
            body['budget_id']!=growth_id(network,body['cluster'],body['origin'],body['token']) or
            not 0<body['issued_at']<=at+5 or body['issued_at']<at-30 or body['prepare_expires_at']<=at or
            not 0<body['prepare_expires_at']-body['issued_at']<=60):
        raise ValueError('invalid_growth_context')
    return body


def validate_growth_record(record,network,placement,at):
    if not isinstance(record,dict) or set(record)!={'body','consents'} or len(canonical(record))>4096:
        raise ValueError('invalid_growth_record')
    body=validate_growth_body(record['body'],network,placement,at)
    consents=record['consents']
    if not isinstance(consents,list) or len(consents)!=3:raise ValueError('three_growth_holders_required')
    previous=''
    for consent in consents:
        if not isinstance(consent,dict) or set(consent)!={'public_key','signature'} or not digest64(consent['public_key']) or consent['public_key']<=previous:
            raise ValueError('distinct_growth_signers_required')
        public=bytes.fromhex(consent['public_key'])
        try:
            signature=bytes.fromhex(consent['signature'])
            if node_id(public) not in placement['record']['body']['members'] or len(signature)!=64 or signature.hex()!=consent['signature']:
                raise ValueError('invalid_growth_signer')
            Ed25519PublicKey.from_public_bytes(public).verify(signature,canonical(body))
        except (ValueError,TypeError,InvalidSignature) as error:raise ValueError('invalid_growth_signature') from error
        previous=consent['public_key']
    return body,sha256(canonical(record)).hexdigest()


def validate_growth_grants(state,network):
    grants=state.get('growth_grants',{})
    if not isinstance(grants,dict) or len(grants)>128:raise ValueError('growth_grant_limit')
    from .licenses import verify_attestation
    issuers={issuer:bytes.fromhex(public) for issuer,public in state.get('license_issuers',{}).items()}
    for identity,head in grants.items():
        if not isinstance(head,dict) or set(head)!={'record','digest','accepted_at'} or type(head['accepted_at']) is not int or not 0<head['accepted_at']<=state['block_time']:
            raise ValueError('invalid_growth_head')
        body=head.get('record',{}).get('body',{})
        history=state.get('placement_history',{}).get(body.get('cluster'),[])
        epoch=body.get('epoch')
        if type(epoch) is not int or not 1<=epoch<=len(history):raise ValueError('growth_placement_history_required')
        placement=history[epoch-1]
        body,digest=validate_growth_record(head['record'],network,placement,head['accepted_at'])
        if identity!=body['budget_id'] or digest!=head['digest']:raise ValueError('invalid_growth_head')
        for document in placement['record']['licenses']:
            verify_attestation(document,issuers,document['claims']['node_id'],network,now=head['accepted_at'])


class GrowthParticipant:
    def __init__(self,key,directory,store):
        self.key,self.directory,self.store=key,directory,store
        self.identity=node_id(key.public_key().public_bytes_raw())

    def reserve(self,payload,sender):
        if not isinstance(payload,dict) or set(payload)!={'body'}:raise ValueError('invalid_growth_request')
        body=json.loads(canonical(payload['body']))
        if not isinstance(body,dict):raise ValueError('invalid_growth_body')
        with self.directory.lock:
            self.directory.anchor()
            state=self.directory.current['state']
            placement=state.get('placements',{}).get(body.get('cluster'))
            if placement is None:raise ValueError('confirmed_growth_placement_required')
            grant=state.get('growth_grants',{}).get(body.get('budget_id'))
            at=grant['accepted_at'] if grant else state['block_time']
            validate_growth_body(body,self.directory.network,placement,at)
            if sender!=body['origin'] or self.identity not in placement['record']['body']['members']:
                raise ValueError('growth_current_holder_required')
            if grant and canonical(grant['record']['body'])!=canonical(body):raise ValueError('growth_budget_conflict')
            budget=self.store.reserve_growth(body['cluster'],body['budget_id'],body['placement_hash'],body['amount'],proposal=body)
            if budget['closed'] or (not grant and budget['remaining_bytes']!=body['amount']):raise ValueError('growth_budget_not_prepared')
            consent={'public_key':self.key.public_key().public_bytes_raw().hex(),'signature':self.key.sign(canonical(body)).hex()}
            return {'body_hash':sha256(canonical(body)).hexdigest(),'consent':consent}

    def put(self,payload,sender):
        growth=payload.get('growth')
        if not isinstance(growth,dict) or set(growth)!={'cluster','budget'}:raise ValueError('invalid_growth_owner')
        with self.directory.lock:
            self.directory.anchor()
            state=self.directory.current['state']
            grant=state.get('growth_grants',{}).get(growth['budget'])
            placement=state.get('placements',{}).get(growth['cluster'])
            if grant is None or placement is None:raise ValueError('consensus_growth_grant_required')
            body=grant['record']['body'];members=placement['record']['body']['members']
            if body['cluster']!=growth['cluster'] or body['placement_hash']!=placement['digest'] or body['epoch']!=placement['record']['body']['epoch'] or sender not in members or self.identity not in members:
                raise ValueError('growth_placement_or_sender_changed')
            if canonical(self.store.growth_proposal(growth['cluster'],growth['budget']))!=canonical(body):raise ValueError('growth_proposal_conflict')
            return self.store.execute('put',payload)

    def release(self,payload,sender):
        if not isinstance(payload,dict) or set(payload)!={'cluster','budget'} or any(not digest64(payload[field]) for field in ('cluster','budget')):raise ValueError('invalid_growth_release')
        with self.directory.lock:
            self.directory.anchor()
            state=self.directory.current['state']
            try:body=self.store.growth_proposal(payload['cluster'],payload['budget'])
            except ValueError:
                try:self.store.growth_budget(payload['cluster'],payload['budget'])
                except ValueError:return {'budget_id':payload['budget'],'released':True}
                raise
            history=state.get('placement_history',{}).get(payload['cluster'],[])
            epoch=body['epoch']
            if type(epoch) is not int or not 1<=epoch<=len(history):raise ValueError('growth_history_required')
            old=history[epoch-1]
            validate_growth_body(body,self.directory.network,old,body['issued_at'])
            if sender!=body['origin'] or self.identity not in old['record']['body']['members'] or body['cluster']!=payload['cluster'] or body['budget_id']!=payload['budget']:
                raise ValueError('growth_release_owner_mismatch')
            current=state['placements'][body['cluster']]
            obsolete=current['record']['body']['epoch']>epoch
            expired=payload['budget'] not in state.get('growth_grants',{}) and state['block_time']>=body['prepare_expires_at']
            if not obsolete and not expired:raise ValueError('growth_release_requires_finality')
            self.store.release_growth(payload['cluster'],payload['budget'])
            return {'budget_id':payload['budget'],'released':True}


class GrowthCoordinator:
    def __init__(self,path,directory,address,journal):
        if not isinstance(directory,ConsensusDirectory) or directory.network!=journal.verifier.network:
            raise ValueError('verified_growth_directory_required')
        self.directory,self.address,self.journal=directory,address,journal
        self.origin=node_id(journal.key.public_key().public_bytes_raw())
        self.lock=threading.RLock()
        self.process_lock=RefreshLock(None if str(path)==':memory:' else str(Path(path).resolve())+'.growth.lock')
        self.db=sqlite3.connect(path,check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('CREATE TABLE IF NOT EXISTS growth_pin(singleton INTEGER PRIMARY KEY CHECK(singleton=1),context BLOB NOT NULL); CREATE TABLE IF NOT EXISTS growth_outbox(id TEXT PRIMARY KEY,body BLOB NOT NULL,record BLOB);')
        context=canonical({'genesis':directory.pin,'network':directory.network,'origin':self.origin})
        try:
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                old=self.db.execute('SELECT context FROM growth_pin').fetchone()
                if old and old[0]!=context:raise ValueError('growth_trust_changed')
                self.db.execute('INSERT OR IGNORE INTO growth_pin VALUES(1,?)',(context,))
        except BaseException:self.db.close();raise

    def close(self):
        with self.lock:self.db.close()

    def reserve(self,cluster,token,amount):
        if not digest64(cluster) or not digest64(token) or type(amount) is not int or not 1<=amount<=2**63-1:
            raise ValueError('invalid_growth_request')
        identity=growth_id(self.directory.network,cluster,self.origin,token)
        with self.lock:
            if not self.process_lock.acquire():return {'state':'busy','budget_id':identity}
            try:
                self.directory.refresh(self.address)
                self.journal.refresh_discovery()
                with self.directory.lock:
                    state=json.loads(canonical(self.directory.current['state']))
                placement=state.get('placements',{}).get(cluster)
                if placement is None or self.origin not in placement['record']['body']['members']:raise ValueError('growth_origin_must_be_holder')
                row=self.db.execute('SELECT body,record FROM growth_outbox WHERE id=?',(identity,)).fetchone()
                if row:
                    body=json.loads(row[0])
                    if body['amount']!=amount:raise ValueError('growth_budget_conflict')
                else:
                    at=state['block_time']
                    body={'domain':'sfera-mesh-growth-v1','network':self.directory.network,'cluster':cluster,'origin':self.origin,'token':token,'budget_id':identity,'epoch':placement['record']['body']['epoch'],'placement_hash':placement['digest'],'amount':amount,'issued_at':at,'prepare_expires_at':at+60}
                    with self.db:
                        if self.db.execute('SELECT COUNT(*) FROM growth_outbox').fetchone()[0]>=128:raise ValueError('growth_outbox_limit')
                        self.db.execute('INSERT INTO growth_outbox VALUES(?,?,NULL)',(identity,canonical(body)))
                grant=state.get('growth_grants',{}).get(identity)
                obsolete=placement['digest']!=body['placement_hash']
                if obsolete or not grant and state['block_time']>=body['prepare_expires_at']:
                    pending=0
                    history=state.get('placement_history',{}).get(cluster,[])
                    for target in history[body['epoch']-1]['record']['body']['members']:
                        if self.journal._request(target,'growth-release',{'cluster':cluster,'budget':identity}) is None:pending+=1
                    return {'state':'obsolete' if obsolete else 'expired','budget_id':identity,'pending_cleanup':pending}
                if grant:
                    if canonical(grant['record']['body'])!=canonical(body):raise ValueError('growth_budget_conflict')
                    return {'state':'confirmed','budget_id':identity,'grant_hash':grant['digest']}
                record=json.loads(row[1]) if row and row[1] else None
                if record is None:
                    consents=[]
                    for target in placement['record']['body']['members']:
                        result=self.journal._request(target,'growth-reserve',{'body':body})
                        if result is None:return {'state':'preparing','budget_id':identity,'prepared_holders':len(consents)}
                        if result.get('body_hash')!=sha256(canonical(body)).hexdigest():raise ValueError('growth_response_mismatch')
                        consents.append(result['consent'])
                    record={'body':body,'consents':sorted(consents,key=lambda vote:vote['public_key'])}
                    validate_growth_record(record,self.directory.network,placement,state['block_time'])
                    with self.db:self.db.execute('UPDATE growth_outbox SET record=? WHERE id=?',(canonical(record),identity))
                result=rpc(self.address,'broadcast_tx_sync',{'tx':base64.b64encode(canonical(record)).decode()})
                if result.get('code',0):raise ValueError('growth_transaction_rejected')
                return {'state':'submitted','budget_id':identity}
            except (ValueError,OSError,sqlite3.Error):return {'state':'waiting','budget_id':identity}
            finally:self.process_lock.release()
