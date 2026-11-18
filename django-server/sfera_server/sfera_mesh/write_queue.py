"""Fixed-committee consensus work queue; ciphertext stays on storage holders."""
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
from .directory import digest64
from .identity import node_id
from .refresh_lock import RefreshLock
from .storage import canonical
from .transport import exchange
from .write_capacity import check_write_capacity


def request_id(network, cluster, origin, block_token):
    return sha256(canonical({'domain': 'sfera-mesh-write-id-v1', 'network': network,
                             'cluster': cluster, 'origin': origin, 'block_token': block_token})).hexdigest()


def content_request_id(network, cluster, origin, block_token, digest, size):
    return sha256(canonical({'domain': 'sfera-mesh-write-id-v2', 'network': network,
        'cluster': cluster, 'origin': origin, 'block_token': block_token,
        'digest': digest, 'size': size})).hexdigest()


def validate_write_body(body, network, placement):
    if not isinstance(body, dict) or set(body) != {'domain','network','cluster','epoch','placement_hash','origin','block_token','request_id','digest','size'}:
        raise ValueError('invalid_write_schema')
    head = placement['record']['body']
    if body['domain'] not in ('sfera-mesh-write-v1', 'sfera-mesh-write-v2') or body['network'] != network or body['cluster'] != head['cluster'] or type(body['epoch']) is not int or body['epoch'] != head['epoch'] or body['placement_hash'] != placement['digest']:
        raise ValueError('invalid_write_context')
    if any(not digest64(body[field]) for field in ('origin','block_token','request_id','digest','placement_hash')) or type(body['size']) is not int or not 1 <= body['size'] <= 262144 or body['origin'] not in head['members']:
        raise ValueError('invalid_write_origin_or_size')
    expected = (content_request_id(network, body['cluster'], body['origin'], body['block_token'], body['digest'], body['size'])
                if body['domain'] == 'sfera-mesh-write-v2' else
                request_id(network, body['cluster'], body['origin'], body['block_token']))
    if body['request_id'] != expected:
        raise ValueError('invalid_write_request_id')


def validate_write(record, network, placement):
    if not isinstance(record,dict) or set(record) != {'body','consents'}:
        raise ValueError('invalid_write_record')
    validate_write_body(record['body'],network,placement)
    consents = record['consents']
    if not isinstance(consents,list) or len(consents) != 3:
        raise ValueError('three_write_holders_required')
    previous = ''
    for consent in consents:
        if not isinstance(consent,dict) or set(consent) != {'public_key','signature'} or not digest64(consent['public_key']) or consent['public_key'] <= previous:
            raise ValueError('distinct_sorted_write_signers_required')
        public = bytes.fromhex(consent['public_key'])
        signature = bytes.fromhex(consent['signature'])
        if node_id(public) not in placement['record']['body']['members'] or len(signature) != 64 or signature.hex() != consent['signature']:
            raise ValueError('invalid_write_signature')
        Ed25519PublicKey.from_public_bytes(public).verify(signature,canonical(record['body']))
        previous = consent['public_key']


def validate_write_queue(state, network):
    queue = state.get('write_queue',{})
    if not isinstance(queue,dict) or len(queue) > 128:
        raise ValueError('invalid_write_queue')
    for identity, head in queue.items():
        if not isinstance(head,dict) or set(head) != {'record','digest','accepted_at'}:
            raise ValueError('invalid_write_queue_head')
        body = head['record']['body']
        history = state.get('placement_history',{}).get(body['cluster'],[])
        epoch = body['epoch']
        if type(epoch) is not int or not 1 <= epoch <= len(history) or identity != body['request_id'] or type(head['accepted_at']) is not int or not 0 < head['accepted_at'] <= state.get('block_time',0):
            raise ValueError('invalid_write_queue_history')
        validate_write(head['record'],network,history[epoch-1])
        if sha256(canonical(head['record'])).hexdigest() != head['digest']:
            raise ValueError('write_queue_digest_mismatch')
    for cluster in {head['record']['body']['cluster'] for head in queue.values()}:
        check_write_capacity(state, cluster)


def write_consent(signer, payload, store, sender):
    if not isinstance(payload,dict) or set(payload) != {'body'}:
        raise ValueError('invalid_write_consent_request')
    body = payload['body']
    with signer.directory.lock:
        signer.directory.anchor()
        placement = signer.directory.placement(body['cluster'])
        placement = {'record':placement['record'],'digest':placement['record_hash']}
        validate_write_body(body,signer.directory.network,placement)
        identity = node_id(signer.key.public_key().public_bytes_raw())
        if sender != body['origin'] or identity not in placement['record']['body']['members']:
            raise ValueError('write_consent_holder_required')
        old = signer.directory.current['state'].get('write_queue',{}).get(body['request_id'])
        if old is not None and canonical(old['record']['body']) != canonical(body):
            raise ValueError('immutable_write_request_conflict')
        check_write_capacity(signer.directory.current['state'], body['cluster'], {body['digest']: body['size']})
        result = store.execute('get',{'digest':body['digest']})
        data = bytes.fromhex(result['ciphertext']) if 'ciphertext' in result else None
        if data is None or len(data) != body['size'] or sha256(data).hexdigest() != body['digest']:
            raise ValueError('write_local_copy_mismatch')
        return {'body_hash':sha256(canonical(body)).hexdigest(),
                'consent':{'public_key':signer.key.public_key().public_bytes_raw().hex(),
                           'signature':signer.key.sign(canonical(body)).hex()}}


class ConsensusWriteQueue:
    def __init__(self, path, publication, *, content_bound=False):
        if type(content_bound) is not bool: raise ValueError("invalid_write_queue_version")
        self.content_bound = content_bound
        self.publication = publication
        self.lock = threading.RLock()
        self.process_lock = RefreshLock(None if str(path)==':memory:' else str(Path(path).resolve())+'.write-queue.lock')
        self.db = sqlite3.connect(path,check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('CREATE TABLE IF NOT EXISTS write_queue_pin(singleton INTEGER PRIMARY KEY CHECK(singleton=1),context BLOB NOT NULL); CREATE TABLE IF NOT EXISTS write_outbox(id TEXT PRIMARY KEY,body BLOB NOT NULL,record BLOB,retry_at REAL NOT NULL DEFAULT 0);')
        self.db.execute('CREATE TABLE IF NOT EXISTS write_batch_outbox(id TEXT PRIMARY KEY,requests BLOB NOT NULL,record BLOB NOT NULL,retry_at REAL NOT NULL DEFAULT 0)')
        journal, directory = publication.journal, publication.directory
        context = canonical({'genesis':directory.pin,'node':journal.verifier.recipient,'endpoints':journal.endpoints})
        try:
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                old = self.db.execute('SELECT context FROM write_queue_pin').fetchone()
                if old and old[0] != context: raise ValueError('write_queue_context_changed')
                if not self.content_bound and self.db.execute('SELECT 1 FROM write_batch_outbox LIMIT 1').fetchone():
                    raise ValueError('pending_write_batch_requires_v2')
                self.db.execute('INSERT OR IGNORE INTO write_queue_pin VALUES(1,?)',(context,))
        except Exception:
            self.db.close(); raise

    def close(self):
        with self.lock: self.db.close()

    def reserve_many(self, requests):
        from .write_batch import reserve_many
        return reserve_many(self, requests)

    def ready_many(self, requests):
        """One fresh proof for already admitted immutable storage requests."""
        if not isinstance(requests, list) or not 1 <= len(requests) <= 64:
            raise ValueError('invalid_write_ready_batch')
        for item in requests:
            if (not isinstance(item, dict) or set(item) != {'cluster', 'block_token', 'digest', 'size'} or
                    any(not digest64(item[field]) for field in ('cluster', 'block_token', 'digest')) or
                    type(item['size']) is not int or not 1 <= item['size'] <= 262144):
                raise ValueError('invalid_write_ready_batch')
        with self.lock:
            directory, journal = self.publication.directory, self.publication.journal
            directory.refresh(self.publication.address)
            with directory.lock, journal.lock:
                directory.anchor()
                if journal.db.execute('SELECT pin FROM replica_trust').fetchone() != (directory.pin,):
                    raise ValueError('placement_trust_changed')
                state, origin = directory.current['state'], journal.verifier.recipient
                result = []
                from .write_batch import committed
                for item in requests:
                    legacy_id = request_id(directory.network, item['cluster'], origin, item['block_token'])
                    legacy = state.get('write_queue', {}).get(legacy_id)
                    row = self.db.execute('SELECT body FROM write_outbox WHERE id=?', (legacy_id,)).fetchone()
                    if legacy or row:
                        body = legacy['record']['body'] if legacy else json.loads(row[0])
                        if (body['digest'], body['size']) != (item['digest'], item['size']):
                            raise ValueError('immutable_write_request_conflict')
                        result.append(bool(legacy))
                        continue
                    identity = content_request_id(directory.network, item['cluster'], origin,
                        item['block_token'], item['digest'], item['size']) if self.content_bound else legacy_id
                    accepted = state.get('write_queue', {}).get(identity)
                    if accepted:
                        body = accepted['record']['body']
                        if (body['digest'], body['size']) != (item['digest'], item['size']):
                            raise ValueError('immutable_write_request_conflict')
                    result.append(bool(accepted) or (self.content_bound and committed(state, item)))
                return result

    def submit(self, cluster, block_token, digest, size):
        if any(not digest64(value) for value in (cluster,block_token,digest)) or type(size) is not int or not 1 <= size <= 262144:
            raise ValueError('invalid_write_request')
        with self.lock:
            if not self.process_lock.acquire(): return {'state':'busy','error':None}
            try:
                publication = self.publication
                directory, journal = publication.directory, publication.journal
                directory.refresh(publication.address)
                with directory.lock, journal.lock:
                    directory.anchor()
                    if journal.db.execute('SELECT pin FROM replica_trust').fetchone() != (directory.pin,):
                        raise ValueError('placement_trust_changed')
                    origin = journal.verifier.recipient
                    state = directory.current['state']
                    # Only authenticated sized manifests authorize removal. Legacy
                    # identities are retained because they do not bind content.
                    def committed(candidate):
                        manifest = state.get('manifests', {}).get(candidate['cluster'], {}).get('record', {}).get('body', {})
                        values, sizes = manifest.get('digests', []), manifest.get('sizes')
                        return (sizes is not None and candidate['digest'] in values and
                                sizes[values.index(candidate['digest'])] == candidate['size'])
                    with self.db:
                        for old_id, raw in self.db.execute('SELECT id,body FROM write_outbox').fetchall():
                            candidate = json.loads(raw)
                            if candidate['domain'] == 'sfera-mesh-write-v2' and committed(candidate):
                                self.db.execute('DELETE FROM write_outbox WHERE id=?', (old_id,))
                    legacy_id = request_id(directory.network,cluster,origin,block_token)
                    legacy_row = self.db.execute('SELECT body FROM write_outbox WHERE id=?', (legacy_id,)).fetchone()
                    legacy = state.get('write_queue', {}).get(legacy_id)
                    if legacy or legacy_row:
                        previous = legacy['record']['body'] if legacy else json.loads(legacy_row[0])
                        if previous['digest'] != digest or previous['size'] != size:
                            raise ValueError('immutable_write_request_conflict')
                    use_v2 = self.content_bound and not (legacy or legacy_row)
                    identity = (content_request_id(directory.network,cluster,origin,block_token,digest,size)
                                if use_v2 else legacy_id)
                    if use_v2 and committed({'cluster':cluster, 'digest':digest, 'size':size}):
                        return {'state':'queued','error':None,'request_id':identity}
                    accepted = directory.current['state'].get('write_queue',{}).get(identity)
                    if accepted:
                        body = accepted['record']['body']
                        if body['digest'] != digest or body['size'] != size: raise ValueError('immutable_write_request_conflict')
                        return {'state':'queued','error':None,'request_id':identity}
                    head = directory.placement(cluster)
                    placement = {'record':head['record'],'digest':head['record_hash']}
                    body = {'domain':('sfera-mesh-write-v2' if use_v2 else 'sfera-mesh-write-v1'),'network':directory.network,'cluster':cluster,
                            'epoch':head['record']['body']['epoch'],'placement_hash':head['record_hash'],
                            'origin':origin,'block_token':block_token,'request_id':identity,'digest':digest,'size':size}
                    validate_write_body(body,directory.network,placement)
                    check_write_capacity(directory.current['state'], cluster, {digest: size})
                row = self.db.execute('SELECT body,record,retry_at FROM write_outbox WHERE id=?',(identity,)).fetchone()
                if row:
                    previous = json.loads(row[0])
                    if previous['digest'] != digest or previous['size'] != size: raise ValueError('immutable_write_request_conflict')
                    if previous['domain'] == 'sfera-mesh-write-v2':
                        body = previous
                    if row[2] > time.time(): return {'state':'waiting','error':None,'request_id':identity}
                elif self.db.execute('SELECT COUNT(*) FROM write_outbox').fetchone()[0] >= 128:
                    raise ValueError('write_outbox_laboratory_limit')
                record = json.loads(row[1]) if row and row[1] and row[0] == canonical(body) else None
                if record is None:
                    consents = []
                    for member in placement['record']['body']['members']:
                        result = exchange(journal.endpoints[member],journal.key,journal.verifier,member,'write-consent',{'body':body})
                        if result['body_hash'] != sha256(canonical(body)).hexdigest() or node_id(bytes.fromhex(result['consent']['public_key'])) != member:
                            raise ValueError('write_consent_response_mismatch')
                        consents.append(result['consent'])
                    record = {'body':body,'consents':sorted(consents,key=lambda item:item['public_key'])}
                    validate_write(record,directory.network,placement)
                    with self.db:
                        self.db.execute('INSERT INTO write_outbox(id,body,record) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,record=excluded.record,retry_at=0',
                                        (identity,canonical(body),canonical(record)))
                result = rpc(publication.address,'broadcast_tx_sync',{'tx':base64.b64encode(canonical(record)).decode()})
                if result.get('code',0): raise ValueError('write_transaction_rejected')
                with self.db: self.db.execute('UPDATE write_outbox SET retry_at=? WHERE id=?',(time.time()+2,identity))
                return {'state':'submitted','error':None,'request_id':identity}
            except (OSError,InvalidSignature,KeyError,TypeError) as exc:
                if isinstance(exc,HTTPError): exc.close()
                return {'state':'waiting','error':'write_queue_unavailable'}
            finally: self.process_lock.release()

    def step(self, cluster, *, limit=64):
        publication = self.publication
        directory = publication.directory
        directory.refresh(publication.address)
        with directory.lock:
            directory.anchor()
            sizes = {}
            for head in directory.current['state'].get('write_queue',{}).values():
                body = head['record']['body']
                if body['cluster'] == cluster:
                    if body['digest'] in sizes and sizes[body['digest']] != body['size']: raise ValueError('queued_ciphertext_size_conflict')
                    sizes[body['digest']] = body['size']
        if not sizes: return {'state':'idle','error':None}
        for digest in sizes: publication.journal._stage_digest(cluster,digest,None)
        return publication.step(cluster,expected_sizes=sizes,limit=limit)
