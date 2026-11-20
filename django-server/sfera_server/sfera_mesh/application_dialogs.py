"""Immutable direct-dialog descriptors projected identically at every entry."""
from hashlib import sha256
import re
import uuid
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .storage import canonical
from .directory import digest64


def dialog_id(network, members):
    if (not isinstance(network, str) or not re.fullmatch('[A-Za-z0-9._-]{1,64}', network)
            or not isinstance(members, list) or len(members) != 2
            or not all(digest64(owner) for owner in members) or members[0] >= members[1]):
        raise ValueError('invalid_application_dialog_identity')
    return sha256(('sfera-mesh-application-dialog-v1\0' + network + '\0' + '\0'.join(members)).encode('ascii')).hexdigest()


def conversation_id(identity):
    if not digest64(identity):
        raise ValueError('invalid_application_dialog_identity')
    raw = bytearray.fromhex(identity[:32])
    raw[6] = (raw[6] & 15) | 128
    raw[8] = (raw[8] & 63) | 128
    return str(uuid.UUID(bytes=bytes(raw)))


def verify_record(record, state, network, genesis):
    if not isinstance(record, dict) or set(record) != {'body','signature'} or len(canonical(record)) > 2048:
        raise ValueError('application_dialog_encoding')
    b = record['body']
    if not isinstance(b,dict):raise ValueError('application_dialog_context')
    fields={'domain','network','genesis','creator','control_epoch','members'}
    device_mode=b.get('domain')=='sfera-mesh-application-dialog-device-v1'
    if device_mode:fields.update(('creator_device','devices_version'))
    if (set(b) != fields or b['domain'] not in ('sfera-mesh-application-dialog-v1','sfera-mesh-application-dialog-device-v1') or b['network'] != network
            or b['genesis'] != genesis or not digest64(genesis)
            or type(b['control_epoch']) is not int):
        raise ValueError('application_dialog_context')
    identity = dialog_id(network, b['members'])
    if b['creator'] not in b['members'] or any(not state.get('application_profiles', {}).get(owner) for owner in b['members']):
        raise ValueError('application_dialog_membership')
    history = state.get('account_controls', {}).get(b['creator'], [])
    if not 0 <= b['control_epoch'] <= len(history):
        raise ValueError('application_dialog_control_epoch')
    public = state['accounts'][b['creator']]['record']['body']['public_key']
    if b['control_epoch']:
        public = history[b['control_epoch']-1]['record']['body']['new_public']
    if device_mode:
        devices=state.get('devices',{}).get(b['creator'],[])
        if not digest64(b['creator_device']) or type(b['devices_version']) is not int or not 1<=b['devices_version']<=len(devices):
            raise ValueError('application_dialog_device_history')
        public=None
        for head in devices[:b['devices_version']]:
            event=head['event']['body']
            if event['device_id']==b['creator_device']:
                public=event['device_public'] if event['operation']=='enroll' else None
        if public is None:raise ValueError('application_dialog_inactive_device')
    if not isinstance(record['signature'], str) or not re.fullmatch('[0-9a-f]{128}', record['signature']):
        raise ValueError('application_dialog_signature')
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(public)).verify(bytes.fromhex(record['signature']), canonical(b))
    except InvalidSignature as exc:
        raise ValueError('application_dialog_signature') from exc
    return identity, sha256(canonical(record)).hexdigest()


def validate_dialogs(state, network, genesis):
    dialogs = state.get('application_dialogs', {})
    if not isinstance(dialogs, dict) or len(dialogs) > 1024:
        raise ValueError('application_dialog_capacity')
    counts = {}
    for identity, head in dialogs.items():
        if not isinstance(head, dict) or set(head) != {'record','digest'}:
            raise ValueError('application_dialog_head')
        key, digest = verify_record(head['record'], state, network, genesis)
        if key != identity or digest != head['digest']:
            raise ValueError('application_dialog_head')
        creator = head['record']['body']['creator']
        counts[creator] = counts.get(creator,0)+1
        if counts[creator] > 128:
            raise ValueError('application_dialog_creator_capacity')


def check_progress(previous, current):
    for identity, head in previous.get('application_dialogs', {}).items():
        if current.get('application_dialogs', {}).get(identity) != head:
            raise ValueError('application_dialog_rollback_or_fork')
