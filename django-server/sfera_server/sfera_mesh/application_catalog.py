"""Publish owner-authorized application metadata through verified quorum state.

The submit callback broadcasts a transaction; it never makes a record confirmed.
Only a subsequent fresh verified snapshot can do that.
"""
from .application_profiles import verify_record as verify_profile, public_profiles
from .application_dialogs import verify_record as verify_dialog, conversation_id
from .directory import ZERO


class ApplicationCatalog:
    def __init__(self, directory, submit):
        self.directory, self.submit = directory, submit

    def public(self):
        d = self.directory
        with d.lock:
            anchor = d.anchor()
            state = d.current['state']
            from .application_dialogs import validate_dialogs
            validate_dialogs(state,d.network,d.pin)
            profiles=public_profiles(state,d.network,d.pin)
            for profile in profiles:profile['record']=state['application_profiles'][profile['owner']][-1]['record']
            return {'network':d.network,'genesis':d.pin,'height':state['height'],
                    'profiles':profiles,
                    'dialogs':[{'identity':identity,'id':conversation_id(identity),
                                'members':list(head['record']['body']['members']), 'digest':head['digest']}
                               for identity,head in sorted(state.get('application_dialogs',{}).items())],
                    'finality':anchor}

    def profile(self, record):
        d = self.directory
        with d.lock:
            d.anchor()
            state = d.current['state']
            digest = verify_profile(record,state,d.network,d.pin)
            b = record['body']
            history = state.get('application_profiles',{}).get(b['owner'],[])
            if history and history[-1]['digest'] == digest:
                return {'state':'confirmed','digest':digest,'owner':b['owner']}
            previous = history[-1]['digest'] if history else ZERO
            if (b['control_epoch'] != len(state.get('account_controls',{}).get(b['owner'],[]))
                    or b['version'] != len(history)+1 or b['previous'] != previous):
                raise ValueError('application_profile_conflict')
            profiles = state.get('application_profiles',{})
            if sum(map(len,profiles.values())) >= 1024 or not history and len(profiles) >= 256:
                raise ValueError('application_profile_capacity')
            if any(head['record']['body']['handle'] == b['handle'] for owner,heads in profiles.items()
                   if owner != b['owner'] for head in heads):
                raise ValueError('application_handle_reserved')
        self.submit(record)
        return {'state':'pending','digest':digest,'owner':b['owner']}

    def dialog(self, record):
        d = self.directory
        with d.lock:
            d.anchor()
            state = d.current['state']
            identity, digest = verify_dialog(record,state,d.network,d.pin)
            dialogs = state.get('application_dialogs',{})
            old = dialogs.get(identity)
            if old is not None:
                return {'state':'confirmed','identity':identity,'id':conversation_id(identity),'digest':old['digest']}
            b = record['body']
            if b['control_epoch'] != len(state.get('account_controls',{}).get(b['creator'],[])):
                raise ValueError('application_dialog_retired_owner_key')
            if b['domain']=='sfera-mesh-application-dialog-device-v1' and b['devices_version']!=len(state.get('devices',{}).get(b['creator'],[])):
                raise ValueError('application_dialog_stale_device_history')
            if len(dialogs) >= 1024 or sum(h['record']['body']['creator']==b['creator'] for h in dialogs.values()) >= 128:
                raise ValueError('application_dialog_capacity')
        self.submit(record)
        return {'state':'pending','identity':identity,'id':conversation_id(identity),'digest':digest}
