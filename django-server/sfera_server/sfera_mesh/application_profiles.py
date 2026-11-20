"""Owner-signed public names, shared through verified consensus, never SQL authority.

SQL IDs are a deterministic projection of network + owner. A point cannot claim
another account by generating its own UUID or accepting a caller-supplied ID.
"""
from hashlib import sha256
import re
import uuid
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .directory import digest64, ZERO
from .storage import canonical


def application_user_id(network, owner):
    if not isinstance(network, str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,64}', network) or not digest64(owner):
        raise ValueError('invalid_application_identity')
    raw = bytearray(sha256(b'sfera-mesh-application-user-v1\0' + network.encode('ascii') + b'\0' + bytes.fromhex(owner)).digest()[:16])
    raw[6] = (raw[6] & 15) | 128
    raw[8] = (raw[8] & 63) | 128
    return str(uuid.UUID(bytes=bytes(raw)))


def verify_record(record, state, network, genesis):
    if not isinstance(record, dict) or set(record) != {'body', 'signature'} or len(canonical(record)) > 2048:
        raise ValueError('application_profile_encoding')
    b = record['body']
    fields = {'domain', 'network', 'genesis', 'owner', 'control_epoch', 'version', 'previous', 'handle', 'nickname_utf8'}
    if (not isinstance(b, dict) or set(b) != fields or b['domain'] != 'sfera-mesh-application-profile-v1'
            or b['network'] != network or b['genesis'] != genesis or not digest64(genesis)
            or not digest64(b['owner']) or b['owner'] not in state.get('accounts', {})
            or type(b['version']) is not int or not 1 <= b['version'] <= 64 or not digest64(b['previous'])
            or not isinstance(b['handle'], str) or not re.fullmatch('[a-z][a-z0-9_]{2,31}', b['handle'])
            or type(b['control_epoch']) is not int):
        raise ValueError('application_profile_context')
    history = state.get('account_controls', {}).get(b['owner'], [])
    if not 0 <= b['control_epoch'] <= len(history):
        raise ValueError('application_profile_control_epoch')
    name = b['nickname_utf8']
    if not isinstance(name, str) or not 2 <= len(name) <= 320 or len(name) % 2 or not re.fullmatch('[0-9a-f]+', name):
        raise ValueError('application_profile_nickname')
    try:
        nickname = bytes.fromhex(name).decode('utf-8')
    except UnicodeError as exc:
        raise ValueError('application_profile_nickname') from exc
    if len(nickname) > 50 or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in nickname):
        raise ValueError('application_profile_control_character')
    public = state['accounts'][b['owner']]['record']['body']['public_key']
    if b['control_epoch']:
        public = history[b['control_epoch'] - 1]['record']['body']['new_public']
    if not isinstance(record['signature'], str) or not re.fullmatch('[0-9a-f]{128}', record['signature']):
        raise ValueError('application_profile_signature')
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(public)).verify(bytes.fromhex(record['signature']), canonical(b))
    except InvalidSignature as exc:
        raise ValueError('application_profile_signature') from exc
    return sha256(canonical(record)).hexdigest()


def validate_profiles(state, network, genesis):
    profiles = state.get('application_profiles', {})
    if not isinstance(profiles, dict) or len(profiles) > 256:
        raise ValueError('application_profile_capacity')
    reserved, total = {}, 0
    for owner, history in profiles.items():
        if not isinstance(history, list) or not 1 <= len(history) <= 64:
            raise ValueError('application_profile_history')
        previous, epoch = ZERO, 0
        for version, head in enumerate(history, 1):
            if not isinstance(head, dict) or set(head) != {'record', 'digest'}:
                raise ValueError('application_profile_head')
            digest = verify_record(head['record'], state, network, genesis)
            b = head['record']['body']
            if (digest != head['digest'] or b['owner'] != owner or b['version'] != version
                    or b['previous'] != previous or b['control_epoch'] < epoch):
                raise ValueError('application_profile_history_fork')
            if b['handle'] in reserved and reserved[b['handle']] != owner:
                raise ValueError('application_handle_reserved')
            reserved[b['handle']] = owner
            previous, epoch = digest, b['control_epoch']
            total += 1
    if total > 1024:
        raise ValueError('application_profile_capacity')


def check_progress(previous, current):
    for owner, history in previous.get('application_profiles', {}).items():
        new = current.get('application_profiles', {}).get(owner)
        if new is None or len(new) < len(history) or new[:len(history)] != history:
            raise ValueError('application_profile_rollback_or_fork')


def public_profiles(state, network, genesis):
    validate_profiles(state, network, genesis)
    return [{'id': application_user_id(network, owner), 'owner': owner,
             'username': heads[-1]['record']['body']['handle'],
             'nickname': bytes.fromhex(heads[-1]['record']['body']['nickname_utf8']).decode('utf-8'),
             'devices_version':len(state.get('devices',{}).get(owner,[])),
             'control_epoch':len(state.get('account_controls',{}).get(owner,[])),
             'version': heads[-1]['record']['body']['version'], 'digest': heads[-1]['digest']}
            for owner, heads in sorted(state.get('application_profiles', {}).items())]
