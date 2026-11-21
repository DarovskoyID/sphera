"""Verify the bounded consensus one-time-key journal; never consume SQL keys.

Only SDK-signed public signed_curve25519 documents are accepted. Fallback keys
and encrypted key mailboxes use separate formats and are not inferred here.
"""
import base64
from hashlib import sha256
import json
import re
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature
from .storage import canonical

FIELDS={'domain','network','genesis','owner','device','devices_version','request','kind','dialog','target_owner','target_device','keys_utf8'}


def signed(key,signature,body):
    try:key.verify(public(signature,64),canonical(body))
    except InvalidSignature as exc:raise ValueError('application_key_signature') from exc


def public(value,size):
    if not isinstance(value,str):raise ValueError('application_sdk_key_encoding')
    raw=base64.b64decode(value+'='*((-len(value))%4),validate=True)
    if len(raw)!=size or base64.b64encode(raw).decode().rstrip('=')!=value:raise ValueError('application_sdk_key_encoding')
    return raw


def record(value,state,network,genesis,*,current=False):
    if not isinstance(value,dict) or set(value)!={'body','signature'} or len(canonical(value))>65536:
        raise ValueError('application_key_encoding')
    body=value['body']
    if not isinstance(body,dict) or set(body)!=FIELDS:raise ValueError('application_key_schema')
    history=state.get('devices',{}).get(body['owner'],[])
    version=body['devices_version']
    if (body['domain']!='sfera-mesh-application-key-v1' or body['network']!=network or body['genesis']!=genesis
            or type(version) is not int or not 1<=version<=len(history)
            or current and version!=len(history) or not isinstance(body['request'],str)
            or re.fullmatch(r'[A-Za-z0-9._:+/-]{1,128}',body['request']) is None):
        raise ValueError('application_key_context')
    active=False
    for head in history[:version]:
        event=head['event']['body']
        if event['device_id']==body['device']:active=event['operation']=='enroll'
    pin=state.get('cipher_devices',{}).get(body['owner']+':'+body['device'])
    if not active or pin is None:raise ValueError('application_key_device_not_admitted')
    signed(Ed25519PublicKey.from_public_bytes(public(pin['certificate']['body']['ed25519'],32)),value['signature'],body)
    if body['kind'] in ('upload','fallback'):
        if body['dialog']!='' or body['target_owner']!='' or body['target_device']!='' or body['keys_utf8']=='':
            raise ValueError('application_key_upload_context')
    elif body['kind']=='claim':
        dialog=state.get('application_dialogs',{}).get(body['dialog'])
        if (dialog is None or body['keys_utf8']!=''
                or (body['owner'],body['device'])==(body['target_owner'],body['target_device'])):
            raise ValueError('application_key_claim_context')
        members=dialog['record']['body']['members']
        if len(members)!=2 or body['owner'] not in members or body['target_owner'] not in members:
            raise ValueError('application_key_target_not_member')
        if body['target_owner']+':'+body['target_device'] not in state.get('cipher_devices',{}):
            raise ValueError('application_key_target_not_pinned')
        if current:
            enabled=False
            for head in state.get('devices',{}).get(body['target_owner'],[]):
                event=head['event']['body']
                if event['device_id']==body['target_device']:enabled=event['operation']=='enroll'
            if not enabled:raise ValueError('application_key_target_revoked')
    else:raise ValueError('application_key_kind')
    return body


def documents(value,state,genesis):
    body=value['body'];raw=bytes.fromhex(body['keys_utf8'])
    if raw.hex()!=body['keys_utf8'] or len(raw)>30000 or any(c<32 or c>126 or c in b'<>&' for c in raw):
        raise ValueError('application_key_documents_encoding')
    docs=json.loads(raw)
    if not isinstance(docs,dict) or not 1<=len(docs)<=128 or raw!=canonical(docs) or body['kind']=='fallback' and len(docs)!=1:raise ValueError('application_key_documents_schema')
    cert=state['cipher_devices'][body['owner']+':'+body['device']]['certificate']['body']
    key=Ed25519PublicKey.from_public_bytes(public(cert['ed25519'],32))
    user='@'+body['owner']+':'+genesis+'.sphere';result={}
    for identity,doc in docs.items():
        if re.fullmatch(r'signed_curve25519:[A-Za-z0-9+/]{1,128}',identity) is None or not isinstance(doc,dict) or set(doc)!=({'key','signatures','fallback'} if body['kind']=='fallback' else {'key','signatures'}):
            raise ValueError('application_one_time_key_schema')
        public(doc['key'],32)
        if body['kind']=='fallback' and doc['fallback'] is not True:raise ValueError('application_fallback_schema')
        signatures=doc['signatures']
        if (not isinstance(signatures,dict) or any(not isinstance(values,dict) or any(not isinstance(value,str) for value in values.values())
                                                 for values in signatures.values())):
            raise ValueError('application_key_signature_schema')
        signed(key,signatures[user]['ed25519:'+body['device']],{k:v for k,v in doc.items() if k!='signatures'})
        result[identity]={'document':canonical(doc).hex(),'public':doc['key'],'consumed':False,'fallback':body['kind']=='fallback'}
    return result


def perform(value,state,pool,genesis):
    body=value['body'];identity=body['owner']+':'+body['device']
    if body['kind'] in ('upload','fallback'):
        docs=documents(value,state,genesis);existing=pool.get(identity,{})
        if len(set(existing)|set(docs))>512:raise ValueError('application_device_key_capacity')
        all_docs={**existing,**docs}
        if len({doc['public'] for doc in all_docs.values()})!=len(all_docs):raise ValueError('application_key_alias')
        for name,doc in docs.items():
            if name in existing and (existing[name]['document']!=doc['document'] or doc['fallback'] and existing[name]['consumed']):raise ValueError('application_key_id_immutable')
        if body['kind']=='fallback':
            for name,doc in existing.items():
                if doc['fallback'] and name not in docs:doc['consumed']=True
        for name,doc in docs.items():existing.setdefault(name,doc)
        pool[identity]=existing;return '',''
    target=pool.get(body['target_owner']+':'+body['target_device'],{})
    available=sorted((name for name,doc in target.items() if not doc['consumed']),key=lambda name:(target[name]['fallback'],name))
    if not available:return '',''
    name=available[0]
    if not target[name]['fallback']:target[name]['consumed']=True
    return name,target[name]['document']


def replay(state,network,genesis):
    receipts=state.get('application_keys',[]);pool={};seen=set()
    if not isinstance(receipts,list) or len(receipts)>512 or len(canonical(receipts))>524288:
        raise ValueError('application_key_journal_capacity')
    for receipt in receipts:
        if not isinstance(receipt,dict) or set(receipt)!={'record','digest','key_id','key_utf8'}:raise ValueError('application_key_receipt_schema')
        value=receipt['record'];body=record(value,state,network,genesis)
        identity=(body['owner'],body['device'],body['request'])
        if identity in seen or receipt['digest']!=sha256(canonical(value)).hexdigest():raise ValueError('application_key_receipt_identity')
        seen.add(identity)
        if perform(value,state,pool,genesis)!=(receipt['key_id'],receipt['key_utf8']):raise ValueError('application_key_receipt_result')
    return pool


def check_progress(previous,current):
    old=previous.get('application_keys',[]);new=current.get('application_keys',[])
    if new[:len(old)]!=old:raise ValueError('application_key_journal_rollback_or_fork')


class ApplicationKeyCatalog:
    def __init__(self,directory,submit):self.directory,self.submit=directory,submit

    def publish(self,value):
        # Freeze before the broadcast callback; only a later verified snapshot
        # can provide a key receipt. Pending is never interpreted as a claim.
        value=json.loads(canonical(value));directory=self.directory
        with directory.lock:
            directory.anchor();state=directory.current['state']
            body=record(value,state,directory.network,directory.pin,current=True)
            digest=sha256(canonical(value)).hexdigest()
            for receipt in state.get('application_keys',[]):
                previous=receipt['record']['body']
                if (previous['owner'],previous['device'],previous['request'])==(body['owner'],body['device'],body['request']):
                    if receipt['digest']!=digest:raise ValueError('application_key_request_conflict')
                    return {'state':'confirmed','receipt':json.loads(canonical(receipt))}
            # Validate semantics on an ephemeral pool, never consume a local
            # persistent cache in anticipation of a consensus result.
            pool=replay(state,directory.network,directory.pin)
            identity,document=perform(value,state,pool,directory.pin)
            next_receipt={'record':value,'digest':digest,'key_id':identity,'key_utf8':document}
            journal=[*state.get('application_keys',[]),next_receipt]
            if len(journal)>512 or len(canonical(journal))>524288 or len(canonical({**state,'application_keys':journal}))>950000:
                raise ValueError('application_key_journal_capacity')
        self.submit(value)
        return {'state':'pending','digest':digest}
