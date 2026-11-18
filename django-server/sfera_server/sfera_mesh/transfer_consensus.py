"""Three-holder, short-lived consensus completion of one exact transfer context."""
import base64
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import threading
import time
from urllib.error import HTTPError
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature
from .consensus_directory import rpc
from .directory import digest64, ZERO
from .identity import node_id
from .refresh_lock import RefreshLock
from .storage import canonical
from .transport import exchange


def validate_transfer(record, network, placement, at):
    if not isinstance(record,dict) or set(record) != {'body','consents'}:
        raise ValueError('invalid_transfer_record')
    body = record['body']
    if not isinstance(body,dict) or set(body) != {'domain','network','cluster','epoch','placement_hash','manifest_hash','version','previous','issued_at','expires_at'}:
        raise ValueError('invalid_transfer_schema')
    head = placement['record']['body']
    if body['domain'] != 'sfera-mesh-transfer-v1' or body['network'] != network or body['cluster'] != head['cluster'] or type(body['epoch']) is not int or body['epoch'] != head['epoch'] or body['placement_hash'] != placement['digest'] or any(not digest64(body[field]) for field in ('manifest_hash','previous')):
        raise ValueError('invalid_transfer_context')
    if any(type(body[field]) is not int for field in ('version','issued_at','expires_at')) or body['version'] < 1 or body['version']==1 and body['previous']!=ZERO or not 0 < body['issued_at'] <= at+5 or not max(at,body['issued_at']) < body['expires_at'] <= body['issued_at']+30:
        raise ValueError('invalid_transfer_freshness')
    if not isinstance(record['consents'],list) or len(record['consents']) != 3:
        raise ValueError('three_transfer_holders_required')
    previous = ''
    for consent in record['consents']:
        if not isinstance(consent,dict) or set(consent) != {'public_key','signature'} or not digest64(consent['public_key']) or consent['public_key'] <= previous:
            raise ValueError('distinct_transfer_holders_required')
        public, signature = bytes.fromhex(consent['public_key']), bytes.fromhex(consent['signature'])
        if node_id(public) not in head['members'] or len(signature) != 64 or signature.hex() != consent['signature']:
            raise ValueError('invalid_transfer_signature')
        Ed25519PublicKey.from_public_bytes(public).verify(signature,canonical(body))
        previous = consent['public_key']


def validate_transfers(state,network):
    heads = state.get('transfers',{})
    if not isinstance(heads,dict) or len(heads) > 128: raise ValueError('invalid_transfer_registry')
    for cluster,head in heads.items():
        if not isinstance(head,dict) or set(head) != {'record','digest','accepted_at'}: raise ValueError('invalid_transfer_head')
        body = head['record']['body']; epoch = body['epoch']; history = state.get('placement_history',{}).get(cluster,[])
        if body['cluster'] != cluster or type(epoch) is not int or not 1 <= epoch <= len(history) or type(head['accepted_at']) is not int or not 0 < head['accepted_at'] <= state['block_time']:
            raise ValueError('invalid_transfer_history')
        validate_transfer(head['record'],network,history[epoch-1],head['accepted_at'])
        if sha256(canonical(head['record'])).hexdigest() != head['digest']: raise ValueError('transfer_digest_mismatch')


def transfer_consent(signer,payload,store,sender):
    if not isinstance(payload,dict) or set(payload) != {'body'}: raise ValueError('invalid_transfer_consent')
    body = payload['body']
    with signer.directory.lock:
        signer.directory.anchor()
        placement = signer.directory.placement(body['cluster'])
        members = placement['record']['body']['members']
        if sender not in members or node_id(signer.key.public_key().public_bytes_raw()) not in members:
            raise ValueError('transfer_holder_required')
        state = signer.directory.current['state']; manifest = state.get('manifests',{}).get(body['cluster'])
        old = state.get('transfers',{}).get(body['cluster'])
        expected = {'domain':'sfera-mesh-transfer-v1','network':signer.directory.network,'cluster':body['cluster'],
                    'epoch':placement['record']['body']['epoch'],'placement_hash':placement['record_hash'],
                    'manifest_hash':manifest['digest'] if manifest else None,'version':old['record']['body']['version']+1 if old else 1,
                    'previous':old['digest'] if old else ZERO,'issued_at':body.get('issued_at'),'expires_at':body.get('expires_at')}
        if body != expected or type(body.get('issued_at')) is not int or type(body.get('expires_at')) is not int or not 0 < body['issued_at'] <= time.time()+5 or not max(time.time(),body['issued_at']) < body['expires_at'] <= body['issued_at']+30:
            raise ValueError('transfer_proposal_changed_or_expired')
        if not manifest or 'sizes' not in manifest['record']['body']: raise ValueError('sized_transfer_manifest_required')
        index = manifest['record']['body']
        for digest,size in zip(index['digests'],index['sizes']):
            result = store.execute('get',{'digest':digest})
            data = bytes.fromhex(result['ciphertext']) if 'ciphertext' in result else None
            if data is None or len(data) != size or sha256(data).hexdigest() != digest: raise ValueError('transfer_local_copy_mismatch')
        return {'body_hash':sha256(canonical(body)).hexdigest(),'consent':{
            'public_key':signer.key.public_key().public_bytes_raw().hex(),'signature':signer.key.sign(canonical(body)).hex()}}


class TransferCoordinator:
    def __init__(self,path,publication):
        self.publication = publication
        self.lock = threading.RLock()
        self.process_lock = RefreshLock(None if str(path)==':memory:' else str(Path(path).resolve())+'.transfer.lock')
        self.db = sqlite3.connect(path,check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('CREATE TABLE IF NOT EXISTS transfer_pin(singleton INTEGER PRIMARY KEY CHECK(singleton=1),context BLOB NOT NULL); CREATE TABLE IF NOT EXISTS transfer_outbox(cluster TEXT PRIMARY KEY,record BLOB NOT NULL,retry_at REAL NOT NULL DEFAULT 0);')
        context = canonical({'genesis':publication.directory.pin,'node':publication.journal.verifier.recipient,'endpoints':publication.journal.endpoints})
        try:
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                old = self.db.execute('SELECT context FROM transfer_pin').fetchone()
                if old and old[0] != context: raise ValueError('transfer_coordinator_context_changed')
                self.db.execute('INSERT OR IGNORE INTO transfer_pin VALUES(1,?)',(context,))
        except Exception: self.db.close(); raise

    def close(self):
        with self.lock: self.db.close()

    def step(self,cluster):
        if not digest64(cluster): raise ValueError('invalid_transfer_cluster')
        with self.lock:
            if not self.process_lock.acquire(): return {'state':'busy','complete':False}
            try:
                p = self.publication; d,j = p.directory,p.journal
                d.refresh(p.address)
                with d.lock,j.lock:
                    anchor = d.anchor()
                    if j.db.execute('SELECT pin FROM replica_trust').fetchone() != (d.pin,): raise ValueError('placement_trust_changed')
                    placement = d.placement(cluster); manifest = d.current['state'].get('manifests',{}).get(cluster)
                    if not manifest or 'sizes' not in manifest['record']['body']: return {'state':'waiting','complete':False,'error':'sized_transfer_manifest_required'}
                    if j.verifier.recipient not in placement['record']['body']['members']: raise ValueError('transfer_holder_required')
                    old = d.current['state'].get('transfers',{}).get(cluster)
                    now = int(time.time())
                    if old and old['record']['body']['placement_hash']==placement['record_hash'] and old['record']['body']['manifest_hash']==manifest['digest'] and old['record']['body']['expires_at']>max(now,d.current['state']['block_time'])+10:
                        return {'state':'confirmed','complete':True,'record_hash':old['digest'],'expires_at':old['record']['body']['expires_at'],'finality':anchor}
                    body = {'domain':'sfera-mesh-transfer-v1','network':d.network,'cluster':cluster,'epoch':placement['record']['body']['epoch'],
                            'placement_hash':placement['record_hash'],'manifest_hash':manifest['digest'],'version':old['record']['body']['version']+1 if old else 1,
                            'previous':old['digest'] if old else ZERO,'issued_at':now,'expires_at':now+30}
                    members = list(placement['record']['body']['members'])
                row = self.db.execute('SELECT record,retry_at FROM transfer_outbox WHERE cluster=?',(cluster,)).fetchone()
                pending = json.loads(row[0]) if row else None
                context_fields = ('epoch','placement_hash','manifest_hash','version','previous')
                same = pending and all(pending['body'][field]==body[field] for field in context_fields) and pending['body']['expires_at']>now+3
                if same and row[1]>time.time(): return {'state':'waiting','complete':False}
                if not same:
                    consents = []
                    for member in members:
                        response = exchange(j.endpoints[member],j.key,j.verifier,member,'transfer-consent',{'body':body})
                        if response['body_hash']!=sha256(canonical(body)).hexdigest() or node_id(bytes.fromhex(response['consent']['public_key']))!=member: raise ValueError('invalid_transfer_consent')
                        consents.append(response['consent'])
                    pending = {'body':body,'consents':sorted(consents,key=lambda item:item['public_key'])}
                    validate_transfer(pending,d.network,{'record':placement['record'],'digest':placement['record_hash']},now)
                    with self.db:
                        self.db.execute('INSERT INTO transfer_outbox(cluster,record) VALUES(?,?) ON CONFLICT(cluster) DO UPDATE SET record=excluded.record,retry_at=0',(cluster,canonical(pending)))
                result = rpc(p.address,'broadcast_tx_sync',{'tx':base64.b64encode(canonical(pending)).decode()})
                if result.get('code',0): raise ValueError('transfer_transaction_rejected')
                with self.db: self.db.execute('UPDATE transfer_outbox SET retry_at=? WHERE cluster=?',(time.time()+2,cluster))
                return {'state':'submitted','complete':False}
            except (OSError,InvalidSignature,KeyError,TypeError) as exc:
                if isinstance(exc,HTTPError): exc.close()
                return {'state':'waiting','complete':False,'error':'transfer_unavailable'}
            finally: self.process_lock.release()
