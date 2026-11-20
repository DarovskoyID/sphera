"""Short-lived device-signed WebRTC signaling, independent of the entry point.

SDP/ICE is never persisted in consensus or in the replay journal. Transport node
signatures are not accepted as a substitute for the caller's device signature.
"""
import json
import re
import sqlite3
import threading
import time
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .application_profiles import application_user_id
from .application_dialogs import dialog_id
from .directory import digest64
from .storage import canonical

TYPES = frozenset(('offer','answer','candidate','call-end','call-rejected','call-resume','call-resumed','video-toggle','demo-toggle'))


def _unique(pairs):
    value = {}
    for key,item in pairs:
        if key in value:raise ValueError('duplicate_signal_field')
        value[key] = item
    return value


def verify_signal(packet, directory, *, now=None):
    now = int(time.time() if now is None else now)
    if not isinstance(packet,dict) or set(packet) != {'body','signature'}:
        raise ValueError('invalid_application_signal')
    b = packet['body']
    if (not isinstance(b,dict) or set(b) != {'domain','network','genesis','sender','device','recipient','issued_at','expires_at','nonce','signal_utf8'}
            or b['domain'] != 'sfera-mesh-application-signal-v1' or b['network'] != directory.network
            or b['genesis'] != directory.pin or not all(digest64(b[k]) for k in ('sender','device','recipient','nonce'))
            or b['sender'] == b['recipient'] or type(b['issued_at']) is not int or type(b['expires_at']) is not int
            or b['issued_at'] > now+5 or b['expires_at'] != b['issued_at']+30 or b['expires_at'] <= now
            or not isinstance(b['signal_utf8'],str) or not 2 <= len(b['signal_utf8']) <= 131072
            or len(b['signal_utf8'])%2 or not re.fullmatch('[0-9a-f]+',b['signal_utf8'])
            or not isinstance(packet['signature'],str) or not re.fullmatch('[0-9a-f]{128}',packet['signature'])):
        raise ValueError('application_signal_context')
    if len(canonical(packet)) > 140000:raise ValueError('application_signal_capacity')
    with directory.lock:
        directory.anchor()
        state = directory.current['state']
        members = sorted([b['sender'],b['recipient']])
        if dialog_id(directory.network,members) not in state.get('application_dialogs',{}):
            raise ValueError('application_signal_dialog_not_confirmed')
        active = None
        for head in state.get('devices',{}).get(b['sender'],[]):
            event = head['event']['body']
            if event['device_id'] == b['device']:
                active = event['device_public'] if event['operation'] == 'enroll' else None
        if active is None:raise ValueError('application_signal_device_not_active')
        try:
            Ed25519PublicKey.from_public_bytes(bytes.fromhex(active)).verify(bytes.fromhex(packet['signature']),canonical(b))
        except InvalidSignature as exc:
            raise ValueError('application_signal_signature') from exc
    try:
        signal = json.loads(bytes.fromhex(b['signal_utf8']).decode('utf-8'),object_pairs_hook=_unique,
            parse_constant=lambda value:(_ for _ in ()).throw(ValueError('nonfinite_signal_number')))
    except (UnicodeError,RecursionError) as exc:
        raise ValueError('application_signal_encoding') from exc
    sender,recipient = application_user_id(directory.network,b['sender']),application_user_id(directory.network,b['recipient'])
    if (not isinstance(signal,dict) or not isinstance(signal.get('type'),str) or signal['type'] not in TYPES or signal.get('to') != recipient
            or signal.get('from',sender) != sender):
        raise ValueError('application_signal_identity_mismatch')
    if signal['type'] in ('offer','answer'):
        sdp = signal.get('sdp')
        if not isinstance(sdp,dict) or sdp.get('type') != signal['type'] or not isinstance(sdp.get('sdp'),str):
            raise ValueError('application_signal_sdp')
    if signal['type'] == 'candidate' and not isinstance(signal.get('candidate'),dict):
        raise ValueError('application_signal_candidate')
    return {'sender_owner':b['sender'],'recipient_owner':b['recipient'],'device':b['device'],
            'nonce':b['nonce'],'expires_at':b['expires_at'],'signal':{**signal,'from':sender,'to':recipient}}


class SignalReplayJournal:
    def __init__(self,path):
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path,check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS application_signals (owner TEXT, device TEXT, nonce TEXT, expires INTEGER NOT NULL, PRIMARY KEY(owner,device,nonce))')

    def close(self):self.db.close()

    def accept(self,packet,directory,*,now=None):
        now = int(time.time() if now is None else now)
        checked = verify_signal(packet,directory,now=now)
        with self.lock,self.db:
            self.db.execute('BEGIN IMMEDIATE')
            self.db.execute('DELETE FROM application_signals WHERE expires<=?',(now,))
            if self.db.execute('SELECT COUNT(*) FROM application_signals').fetchone()[0] >= 16384:
                raise ValueError('application_signal_replay_capacity')
            try:
                self.db.execute('INSERT INTO application_signals VALUES(?,?,?,?)',
                    (checked['sender_owner'],checked['device'],checked['nonce'],checked['expires_at']))
            except sqlite3.IntegrityError as exc:
                raise ValueError('application_signal_replayed') from exc
        return checked
