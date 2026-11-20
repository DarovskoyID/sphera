"""Resumable, public-key-only registration through verified consensus.

Account/profile/device are separate consensus records. A pending stage never
creates an application user or session and retries submit identical records.
"""
import copy
import json
from hashlib import sha256
from .storage import canonical
from .directory import validate_record,ZERO
from .devices import verify_event
from .application_profiles import verify_record as verify_profile,application_user_id


class ApplicationRegistration:
    def __init__(self,directory,submit):self.directory,self.submit=directory,submit

    def publish(self,bundle):
        if not isinstance(bundle,dict) or set(bundle)!={'account','profile','device'} or len(canonical(bundle))>16384:
            raise ValueError('application_registration_schema')
        bundle=json.loads(canonical(bundle));directory=self.directory
        with directory.lock:
            directory.anchor();state=directory.current['state']
            account=bundle['account'];body=account['body']
            _,account_digest=validate_record(account,directory.network)
            owner=body['user_id']
            if body['version']!=1 or body['previous']!=ZERO:raise ValueError('application_registration_initial_account')
            candidate=copy.deepcopy(state)
            candidate.setdefault('accounts',{})[owner]={'record':account,'digest':account_digest}
            profile=bundle['profile'];p=profile['body']
            profile_digest=verify_profile(profile,candidate,directory.network,directory.pin)
            if p['owner']!=owner or p['control_epoch']!=0 or p['version']!=1 or p['previous']!=ZERO:
                raise ValueError('application_registration_initial_profile')
            event=bundle['device'];e=event['body']
            _,event_digest=verify_event(event,directory.network,body['public_key'],expected_owner=owner)
            if e['version']!=1 or e['previous']!=ZERO or e['operation']!='enroll':
                raise ValueError('application_registration_initial_device')
            profiles=state.get('application_profiles',{})
            if any(head['record']['body']['handle']==p['handle'] for other,history in profiles.items()
                   if other!=owner for head in history):raise ValueError('application_handle_reserved')
            if owner not in profiles and len(profiles)>=256:raise ValueError('application_profile_capacity')
            old=state.get('accounts',{}).get(owner)
            if old is None:stage='account';value=account
            elif old['digest']!=account_digest:raise ValueError('application_registration_account_conflict')
            else:
                history=profiles.get(owner,[])
                if not history:stage='profile';value=profile
                elif history[0]['digest']!=profile_digest:raise ValueError('application_registration_profile_conflict')
                else:
                    events=state.get('devices',{}).get(owner,[])
                    if not events:stage='device';value=event
                    elif events[0]['digest']!=event_digest:raise ValueError('application_registration_device_conflict')
                    else:
                        return {'state':'confirmed','owner':owner,'device':e['device_id'],
                                'application_user':application_user_id(directory.network,owner)}
        self.submit(value)
        return {'state':'pending','stage':stage,'digest':sha256(canonical(value)).hexdigest(),'owner':owner}
