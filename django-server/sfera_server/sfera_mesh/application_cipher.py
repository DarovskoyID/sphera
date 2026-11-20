"""Entry-independent DM membership derived from committed application state."""
from hashlib import sha256
from .storage import canonical
from .application_profiles import application_user_id
from .application_dialogs import conversation_id


def scope_for(state,network,genesis,scope):
    matches=[(identity,head) for identity,head in state.get('application_dialogs',{}).items() if conversation_id(identity)==scope]
    if len(matches)!=1:raise ValueError('distributed_cipher_dialog_not_confirmed')
    identity,head=matches[0]
    mapping={application_user_id(network,owner):owner for owner in head['record']['body']['members']}
    members=sorted(mapping);owners=[{'user':user,'owner':mapping[user]} for user in members]
    certificates=[];versions=[]
    from .cipher_authority import verify_certificate
    for owner in sorted(mapping.values()):
        history=state.get('devices',{}).get(owner,[]);active={}
        versions.append({'owner':owner,'version':len(history)})
        for item in history:
            event=item['event']['body']
            active[event['device_id']]=event['device_public'] if event['operation']=='enroll' else None
        before=len(certificates)
        for device,public in sorted(active.items()):
            if public is None:continue
            pinned=state.get('cipher_devices',{}).get(owner+':'+device)
            if pinned is None:raise ValueError('distributed_cipher_device_pin_pending')
            certificate=pinned['certificate'];body=verify_certificate(certificate,network,genesis)
            if (body['owner'],body['device'],body['device_public'])!=(owner,device,public):
                raise ValueError('distributed_cipher_device_pin_conflict')
            certificates.append(certificate)
        if len(certificates)==before:raise ValueError('distributed_cipher_member_has_no_device')
    certificates.sort(key=lambda certificate:(certificate['body']['owner'],certificate['body']['device']))
    if not 2<=len(certificates)<=64:raise ValueError('distributed_cipher_device_capacity')
    for field in ('ed25519','curve25519'):
        if len({certificate['body'][field] for certificate in certificates})!=len(certificates):
            raise ValueError('distributed_cipher_duplicate_sdk_key')
    roster=sha256(canonical({'members':members,'owners':owners,'certificates':certificates})).hexdigest()
    return {'dialog':identity,'members':members,'owners':owners,'certificates':certificates,
            'device_versions':versions,'epoch':1+sum(item['version'] for item in versions),'roster':roster}


def namespace(network,genesis,dialog):
    digest=sha256(canonical(['sfera-mesh-distributed-cipher-scope-id-v1',network,genesis,'dm',dialog])).hexdigest()
    return '-'.join((digest[:8],digest[8:12],digest[12:16],digest[16:20],digest[20:32]))
