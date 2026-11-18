"""Terminal laboratory document revocation, not a CometBFT membership update."""
from hashlib import sha256
import time
from .admission import verify_approval,_signature
from .directory import digest64
from .identity import node_id
from .storage import canonical


def revocation(head,network,genesis,policy,committee,keys,reason,*,now=None,ttl=300):
    now=int(time.time()) if now is None else now
    if type(ttl) is not int or not 1<=ttl<=300: raise ValueError('invalid_admission_revocation_ttl')
    prior=head['approval']['body']; request=head['application']['body']
    body={'domain':'sfera-mesh-admission-revocation-lab-v1','network':network,'genesis':genesis,'policy':policy,'committee':sha256(canonical(committee)).hexdigest(),'node_id':request['node_id'],'operator':request['operator'],'revokes':head['digest'],'version':prior['version']+1,'previous':head['digest'],'reason':reason,'issued_at':now,'expires_at':now+ttl}
    votes=[{'public_key':key.public_key().public_bytes_raw().hex(),'signature':key.sign(canonical(body)).hex()} for key in keys]
    record={'body':body,'votes':sorted(votes,key=lambda vote:vote['public_key'])}
    verify_revocation(record,head,network,genesis,policy,committee,now=now)
    return record


def verify_revocation(record,head,network,genesis,policy,committee,*,now=None):
    now=int(time.time()) if now is None else now
    prior=head['approval']['body']; request=head['application']['body']
    digest=verify_approval(head['approval'],head['application'],network,genesis,policy,committee,now=prior['issued_at'],expected_version=prior['version'],expected_previous=prior['previous'])
    if digest!=head['digest']: raise ValueError('admission_revocation_anchor_mismatch')
    if not isinstance(record,dict) or set(record)!={'body','votes'} or len(canonical(record))>16384: raise ValueError('invalid_admission_revocation')
    b=record['body']; fields={'domain','network','genesis','policy','committee','node_id','operator','revokes','version','previous','reason','issued_at','expires_at'}
    if not isinstance(b,dict) or set(b)!=fields or b['domain']!='sfera-mesh-admission-revocation-lab-v1' or (b['network'],b['genesis'],b['policy'],b['committee'],b['node_id'],b['operator'],b['revokes'],b['previous'])!=(network,genesis,policy,sha256(canonical(committee)).hexdigest(),request['node_id'],request['operator'],digest,digest) or type(b['version']) is not int or b['version']!=prior['version']+1 or b['version']>2**63-1 or not digest64(b['reason']):
        raise ValueError('admission_revocation_context_mismatch')
    if type(now) is not int or type(b['issued_at']) is not int or type(b['expires_at']) is not int or not prior['issued_at']<=b['issued_at']<=now<b['expires_at']<=b['issued_at']+300:
        raise ValueError('admission_revocation_expired')
    votes=record['votes']
    if not isinstance(votes,list) or not (2*len(committee))//3+1<=len(votes)<=len(committee): raise ValueError('admission_revocation_quorum_required')
    previous=''
    for vote in votes:
        if not isinstance(vote,dict) or set(vote)!={'public_key','signature'} or not digest64(vote['public_key']) or vote['public_key']<=previous or committee.get(node_id(bytes.fromhex(vote['public_key'])))!=vote['public_key']:
            raise ValueError('distinct_pinned_admission_votes_required')
        _signature(vote['public_key'],vote['signature'],b); previous=vote['public_key']
    return sha256(canonical(record)).hexdigest()
