"""Laboratory key handover: dual possession plus committee approval."""
from hashlib import sha256
from .admission import verify_approval, _signature
from .storage import canonical


def rotation(head, request, approved, network, genesis, policy, committee, old_key, new_key, *, now):
    body={'domain':'sfera-mesh-admission-rotation-lab-v1','previous':head['digest'],
          'application':sha256(canonical(request)).hexdigest(),
          'approval':sha256(canonical(approved)).hexdigest(),'issued_at':now}
    record={'body':body,'old_signature':old_key.sign(canonical(body)).hex(),
            'new_signature':new_key.sign(canonical(body)).hex()}
    verify_rotation(record,head,request,approved,network,genesis,policy,committee,now=now)
    return record


def verify_rotation(record,head,request,approved,network,genesis,policy,committee,*,now):
    prior=head['approval']['body']
    digest=verify_approval(head['approval'],head['application'],network,genesis,policy,committee,
        now=prior['issued_at'],expected_version=prior['version'],expected_previous=prior['previous'])
    target=verify_approval(approved,request,network,genesis,policy,committee,now=now)
    if not isinstance(record,dict) or set(record)!={'body','old_signature','new_signature'} or len(canonical(record))>4096:
        raise ValueError('invalid_admission_rotation')
    b=record['body']; old=head['application']['body']; new=request['body']
    if digest!=head['digest'] or not isinstance(b,dict) or set(b)!={'domain','previous','application','approval','issued_at'} or b['domain']!='sfera-mesh-admission-rotation-lab-v1' or b['previous']!=digest or b['application']!=sha256(canonical(request)).hexdigest() or b['approval']!=target or old['operator']!=new['operator'] or old['node_id']==new['node_id']:
        raise ValueError('admission_rotation_context_mismatch')
    if type(now) is not int or type(b['issued_at']) is not int or not max(prior['issued_at'],approved['body']['issued_at'])<=b['issued_at']<=now<min(b['issued_at']+300,approved['body']['expires_at']):
        raise ValueError('admission_rotation_expired')
    _signature(old['public_key'],record['old_signature'],b)
    _signature(new['public_key'],record['new_signature'],b)
    return sha256(canonical(record)).hexdigest()
