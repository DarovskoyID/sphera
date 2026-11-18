"""Consensus checkpoints for whole SDK snapshots, with mutation reservations."""
from hashlib import sha256
import re
import time
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature
from .storage import canonical
from .directory import digest64, ZERO


def verify_record(record, state, network, genesis):
    if not isinstance(record, dict) or set(record) != {'body', 'signature'} or len(canonical(record)) > 4096:
        raise ValueError('invalid_cipher_profile')
    b = record['body']
    if (not isinstance(b, dict) or set(b) != {'domain','network','genesis','owner','device','version','previous','profile_digest'}
            or b['domain'] != 'sfera-mesh-cipher-profile-v1' or b['network'] != network or b['genesis'] != genesis
            or not all(digest64(b[k]) for k in ('owner','device','previous','profile_digest')) or b['profile_digest'] == ZERO
            or type(b['version']) is not int or not 1 <= b['version'] <= 9007199254740991
            or b['version'] == 1 and b['previous'] != ZERO):
        raise ValueError('invalid_cipher_profile')
    pin = state.get('cipher_devices', {}).get(b['owner'] + ':' + b['device'])
    if pin is None or not isinstance(record['signature'], str) or not re.fullmatch('[0-9a-f]{128}', record['signature']):
        raise ValueError('cipher_profile_pin_required')
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(pin['certificate']['body']['device_public'])).verify(bytes.fromhex(record['signature']), canonical(b))
    except InvalidSignature as exc:
        raise ValueError('invalid_cipher_profile_signature') from exc
    return sha256(canonical(record)).hexdigest()


def validate_profiles(state, network, genesis):
    profiles = state.get('cipher_profiles', {})
    if not isinstance(profiles, dict) or len(profiles) > 512:
        raise ValueError('invalid_cipher_profiles')
    for key, head in profiles.items():
        if not isinstance(head, dict) or set(head) != {'record','digest'} or verify_record(head['record'], state, network, genesis) != head['digest']:
            raise ValueError('invalid_cipher_profile_head')
        if key != head['record']['body']['owner'] + ':' + head['record']['body']['device']:
            raise ValueError('invalid_cipher_profile_owner')


def check_progress(previous, current):
    for key, head in previous.get('cipher_profiles', {}).items():
        new = current.get('cipher_profiles', {}).get(key)
        if new is None or new['record']['body']['version'] < head['record']['body']['version'] or new['record']['body']['version'] == head['record']['body']['version'] and new != head:
            raise ValueError('cipher_profile_rollback_or_fork')


class CipherProfiles:
    def __init__(self, sessions): self.sessions = sessions

    def head(self, user, claim, nonce):
        s = self.sessions
        if not digest64(nonce) or s.entry_key is None: raise ValueError('invalid_cipher_profile_nonce')
        with s.directory.lock, s.lock:
            s.require(user, claim)
            anchor = s.directory.anchor()
            head = s.directory.current['state'].get('cipher_profiles', {}).get(claim['owner'] + ':' + claim['device'])
            now = int(time.time())
            body = {'domain':'sfera-mesh-cipher-profile-head-v1','network':s.directory.network,'genesis':s.directory.pin,
                'entry':s.entry,'owner':claim['owner'],'device':claim['device'],'nonce':nonce,'head':head,
                'issued_at':now,'expires_at':min(now+15,int(anchor['expires_at'])),'finality':anchor}
            return {'body':body,'signature':s.entry_key.sign(canonical(body)).hex()}

    def publish(self, user, claim, record, submit):
        s = self.sessions
        with s.directory.lock, s.lock:
            s.require(user, claim)
            state = s.directory.current['state']
            digest = verify_record(record, state, s.directory.network, s.directory.pin)
            b = record['body']
            if (b['owner'],b['device']) != (claim['owner'],claim['device']): raise ValueError('cipher_profile_claim_mismatch')
            old = state.get('cipher_profiles', {}).get(b['owner']+':'+b['device'])
            if old is not None and old['digest'] == digest: return {'digest':digest,'state':'confirmed'}
            if (old is None and b['version'] != 1 or old is not None and
                    (b['version'] != old['record']['body']['version']+1 or b['previous'] != old['digest'] or
                     b['version']%2 == 0 and b['profile_digest'] != old['record']['body']['profile_digest'])):
                raise ValueError('cipher_profile_conflict')
        submit(record)
        return {'digest':digest,'state':'pending'}
