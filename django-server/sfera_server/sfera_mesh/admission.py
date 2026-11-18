"""Laboratory approval documents only; never change active voting membership."""
from hashlib import sha256
import re
import time
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .directory import ZERO,digest64
from .identity import node_id
from .storage import canonical


def _context(network,genesis,policy):
    if not isinstance(network,str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,128}',network) or not digest64(genesis) or not digest64(policy):
        raise ValueError('invalid_admission_context')


def _signature(public,signature,body):
    if not digest64(public) or not isinstance(signature,str) or len(signature)!=128:
        raise ValueError('invalid_admission_signature')
    try:
        raw=bytes.fromhex(signature)
        if raw.hex()!=signature: raise ValueError('noncanonical_admission_signature')
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(public)).verify(raw,canonical(body))
    except (ValueError,InvalidSignature) as exc: raise ValueError('invalid_admission_signature') from exc


def application(key,network,genesis,policy,operator,evidence,*,now=None,ttl=300):
    now=int(time.time()) if now is None else now
    if type(ttl) is not int or not 1<=ttl<=300: raise ValueError('invalid_admission_ttl')
    public=key.public_key().public_bytes_raw().hex()
    body={'domain':'sfera-mesh-admission-application-lab-v1','network':network,'genesis':genesis,'policy':policy,'operator':operator,'evidence':evidence,'node_id':node_id(bytes.fromhex(public)),'public_key':public,'role':'validator','issued_at':now,'expires_at':now+ttl}
    record={'body':body,'signature':key.sign(canonical(body)).hex()}
    verify_application(record,network,genesis,policy,now=now)
    return record


def verify_application(record,network,genesis,policy,*,now=None):
    _context(network,genesis,policy)
    now=int(time.time()) if now is None else now
    if not isinstance(record,dict) or set(record)!={'body','signature'} or len(canonical(record))>4096: raise ValueError('invalid_admission_application')
    b=record['body']
    fields={'domain','network','genesis','policy','operator','evidence','node_id','public_key','role','issued_at','expires_at'}
    if not isinstance(b,dict) or set(b)!=fields or b['domain']!='sfera-mesh-admission-application-lab-v1' or (b['network'],b['genesis'],b['policy'])!=(network,genesis,policy) or b['role']!='validator' or any(not digest64(b[field]) for field in ('operator','evidence','node_id','public_key')):
        raise ValueError('invalid_admission_application')
    if type(now) is not int or type(b['issued_at']) is not int or type(b['expires_at']) is not int or not b['issued_at']<=now<b['expires_at']<=b['issued_at']+300:
        raise ValueError('admission_application_expired')
    if node_id(bytes.fromhex(b['public_key']))!=b['node_id']: raise ValueError('admission_key_mismatch')
    _signature(b['public_key'],record['signature'],b)
    return sha256(canonical(record)).hexdigest()


def approval(application_record,network,genesis,policy,committee,keys,*,now=None,version=1,previous=ZERO):
    now=int(time.time()) if now is None else now
    request=verify_application(application_record,network,genesis,policy,now=now)
    body={'domain':'sfera-mesh-admission-approval-lab-v1','network':network,'genesis':genesis,'policy':policy,'committee':sha256(canonical(committee)).hexdigest(),'application':request,'version':version,'previous':previous,'issued_at':now,'expires_at':application_record['body']['expires_at']}
    votes=[{'public_key':key.public_key().public_bytes_raw().hex(),'signature':key.sign(canonical(body)).hex()} for key in keys]
    record={'body':body,'votes':sorted(votes,key=lambda vote:vote['public_key'])}
    verify_approval(record,application_record,network,genesis,policy,committee,now=now,expected_version=version,expected_previous=previous)
    return record


def verify_approval(record,application_record,network,genesis,policy,committee,*,now=None,expected_version=1,expected_previous=ZERO):
    now=int(time.time()) if now is None else now
    request=verify_application(application_record,network,genesis,policy,now=now)
    if not isinstance(committee,dict) or not 3<=len(committee)<=16 or any(not digest64(identity) or not digest64(public) or node_id(bytes.fromhex(public))!=identity for identity,public in committee.items()):
        raise ValueError('pinned_admission_committee_required')
    if type(expected_version) is not int or not 1<=expected_version<=2**63-1 or not digest64(expected_previous) or (expected_version==1)!=(expected_previous==ZERO): raise ValueError('invalid_admission_history_anchor')
    if not isinstance(record,dict) or set(record)!={'body','votes'} or len(canonical(record))>16384: raise ValueError('invalid_admission_approval')
    b=record['body']; fields={'domain','network','genesis','policy','committee','application','version','previous','issued_at','expires_at'}
    if not isinstance(b,dict) or set(b)!=fields or b['domain']!='sfera-mesh-admission-approval-lab-v1' or (b['network'],b['genesis'],b['policy'],b['committee'],b['application'])!=(network,genesis,policy,sha256(canonical(committee)).hexdigest(),request) or type(b['version']) is not int or b['version']!=expected_version or b['previous']!=expected_previous or (b['version']==1 and b['previous']!=ZERO):
        raise ValueError('admission_approval_context_mismatch')
    if type(b['issued_at']) is not int or type(b['expires_at']) is not int or not application_record['body']['issued_at']<=b['issued_at']<=now<b['expires_at']<=application_record['body']['expires_at']:
        raise ValueError('admission_approval_expired')
    votes=record['votes']
    if not isinstance(votes,list) or not (2*len(committee))//3+1<=len(votes)<=len(committee): raise ValueError('admission_approval_quorum_required')
    prior=''
    for vote in votes:
        if not isinstance(vote,dict) or set(vote)!={'public_key','signature'} or not digest64(vote['public_key']) or vote['public_key']<=prior or committee.get(node_id(bytes.fromhex(vote['public_key'])))!=vote['public_key']:
            raise ValueError('distinct_pinned_admission_votes_required')
        _signature(vote['public_key'],vote['signature'],b); prior=vote['public_key']
    return sha256(canonical(record)).hexdigest()
