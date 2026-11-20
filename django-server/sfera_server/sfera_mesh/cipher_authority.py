"""Device-signed SDK pins and short-lived scope attestations.

Legacy scopes use the selected application's ACL. Explicit distributed scopes
derive membership, device roster and epoch from the confirmed global dialog.
"""
import base64
from hashlib import sha256
import json
import re
import time
import uuid

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .directory import digest64
from .devices import device_id
from .storage import canonical

DOMAIN = 'sfera-mesh-cipher-device-v1'


def verify_certificate(value, network, genesis):
    if not isinstance(value, dict) or set(value) != {'body', 'signature'} or len(canonical(value)) > 4096:
        raise ValueError('invalid_cipher_certificate')
    body = value['body']
    if (not isinstance(body, dict) or set(body) != {'domain', 'network', 'genesis', 'owner', 'device',
            'device_public', 'ed25519', 'curve25519'} or body['domain'] != DOMAIN or
            (body['network'], body['genesis']) != (network, genesis) or
            not all(digest64(body[field]) for field in ('genesis', 'owner', 'device', 'device_public'))):
        raise ValueError('invalid_cipher_certificate_context')
    for field in ('ed25519', 'curve25519'):
        public = body[field]
        if (not isinstance(public, str) or not re.fullmatch('[A-Za-z0-9+/]{43}', public) or
                base64.b64encode(base64.b64decode(public + '=', validate=True)).decode().rstrip('=') != public):
            raise ValueError('invalid_cipher_public_key')
    if device_id(bytes.fromhex(body['device_public'])) != body['device']:
        raise ValueError('cipher_device_key_mismatch')
    try:
        signature = value['signature']
        if not isinstance(signature, str) or not re.fullmatch('[0-9a-f]{128}', signature):
            raise ValueError('invalid_cipher_signature')
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(body['device_public'])).verify(bytes.fromhex(signature), canonical(body))
    except InvalidSignature as exc:
        raise ValueError('invalid_cipher_signature') from exc
    return body


class CipherAuthority:
    def archive_device(self, user, claim, device, public, nonce, *, now=None):
        now = int(time.time()) if now is None else now
        if not all(digest64(value) for value in (device, public, nonce)) or device_id(bytes.fromhex(public)) != device:
            raise ValueError('invalid_archive_device')
        sessions = self.sessions
        if sessions.entry_key is None:
            raise ValueError('archive_device_signer_missing')
        with sessions.directory.lock, sessions.lock:
            sessions.require(user, claim, now=now)
            # require() verifies the full current controlled device history.
            history = sessions.directory.device_history(claim['owner'])
            if not any(event['body']['operation'] == 'enroll' and event['body']['device_id'] == device and
                       event['body']['device_public'] == public for event in history['events']):
                raise ValueError('archive_device_not_admitted')
            body = {'domain': 'sfera-mesh-archive-device-v1', 'authority': 'selected_entry_verified_directory',
                'network': sessions.directory.network, 'genesis': sessions.directory.pin, 'entry': sessions.entry,
                'owner': claim['owner'], 'device': claim['device'], 'user': user, 'archive_device': device,
                'archive_device_public': public, 'nonce': nonce, 'issued_at': now, 'expires_at': now + 15}
            return {'body': body, 'signature': sessions.entry_key.sign(canonical(body)).hex()}

    def __init__(self, sessions):
        self.sessions = sessions
        self.global_pins = getattr(sessions, 'require_consensus_cipher_pins', False)
        with sessions.lock:
            sessions.db.executescript('''
                CREATE TABLE IF NOT EXISTS cipher_devices (owner TEXT NOT NULL, device TEXT NOT NULL,
                    certificate BLOB NOT NULL, PRIMARY KEY(owner,device));
                CREATE TABLE IF NOT EXISTS cipher_scopes (source TEXT NOT NULL, scope TEXT NOT NULL,
                    epoch INTEGER NOT NULL, roster TEXT NOT NULL, PRIMARY KEY(source,scope));
            ''')

    def publish(self, user, claim, certificate, *, now=None):
        certificate = json.loads(canonical(certificate))
        backend = self.sessions
        body = verify_certificate(certificate, backend.directory.network, backend.directory.pin)
        with backend.directory.lock, backend.lock, backend.db:
            backend.require(str(user), claim, now=now)
            if (body['owner'], body['device']) != (claim['owner'], claim['device']):
                raise ValueError('cipher_certificate_session_mismatch')
            _, public = backend._device(body['owner'], body['device'])
            if public != body['device_public']:
                raise ValueError('cipher_certificate_admission_mismatch')
            if self.global_pins:
                confirmed = backend.directory.cipher_device(body['owner'], body['device'])['head']
                if confirmed is None:
                    raise ValueError('cipher_global_pin_pending')
                if confirmed['certificate'] != certificate:
                    raise ValueError('cipher_global_pin_conflict')
            backend.db.execute('BEGIN IMMEDIATE')
            old = backend.db.execute('SELECT certificate FROM cipher_devices WHERE owner=? AND device=?',
                (body['owner'], body['device'])).fetchone()
            raw = canonical(certificate)
            if old is not None and bytes(old[0]) != raw:
                raise ValueError('cipher_device_keys_are_immutable')
            backend.db.execute('INSERT OR IGNORE INTO cipher_devices VALUES(?,?,?)',
                (body['owner'], body['device'], raw))
        return {'digest': sha256(raw).hexdigest()}

    def attest(self, user, claim, source, scope, members, nonce, *, now=None, revalidate=None):
        """members are current authorized application users, supplied only by server ACL code."""
        backend = self.sessions
        if getattr(backend,'identity_policy','explicit-binding-v1')=='consensus-profile-v1':
            return self._attest_distributed(user,claim,source,scope,members,nonce,now=now,revalidate=revalidate)
        current = int(time.time()) if now is None else now
        if (source not in ('dm', 'guild') or not isinstance(scope, str) or
                str(uuid.UUID(scope)) != scope or not digest64(nonce) or type(current) is not int or current < 0 or
                not isinstance(members, list) or not 1 <= len(members) <= 64 or
                len(set(members)) != len(members) or str(user) not in members or backend.entry_key is None):
            raise ValueError('invalid_cipher_scope_request')
        certificates, owners = [], []
        with backend.directory.lock, backend.lock, backend.db:
            backend.require(str(user), claim, now=current)
            for member in sorted(members):
                if not isinstance(member, str) or str(uuid.UUID(member)) != member:
                    raise ValueError('invalid_cipher_scope_member')
                owner = backend.db.execute('SELECT owner FROM app_identities WHERE user=?', (member,)).fetchone()
                if owner is None:
                    raise ValueError('cipher_scope_member_not_bound')
                owners.append({'user': member, 'owner': owner[0]})
                history = backend.directory.device_history(owner[0])
                # Replay the entire checked chain instead of trusting a list of
                # caller-selected active devices. Missing SDK pins fail closed.
                from .devices import DeviceRegistry, verify_event
                from .directory import ZERO
                active, previous = {}, ZERO
                for version, event in enumerate(history['events'], 1):
                    from .account_controls import history_signer
                    body, digest = verify_event(event, backend.directory.network, history_signer(history, version), expected_owner=owner[0])
                    if body['version'] != version or body['previous'] != previous or body['user_id'] != owner[0]:
                        raise ValueError('cipher_device_history_conflict')
                    DeviceRegistry._transition(active, body); previous = digest
                if history['version'] != len(history['events']) or history['digest'] != previous:
                    raise ValueError('cipher_device_history_conflict')
                before = len(certificates)
                for device, state in sorted(active.items()):
                    if not state['active']:
                        continue
                    row = backend.db.execute('SELECT certificate FROM cipher_devices WHERE owner=? AND device=?', (owner[0], device)).fetchone()
                    if self.global_pins:
                        confirmed = backend.directory.cipher_device(owner[0], device)['head']
                        if confirmed is None:
                            raise ValueError('cipher_scope_device_not_globally_bound')
                        raw = canonical(confirmed['certificate'])
                        if row is not None and bytes(row[0]) != raw:
                            raise ValueError('cipher_global_pin_cache_conflict')
                        row = (raw,)
                    if row is None:
                        raise ValueError('cipher_scope_device_not_bound')
                    certificate = json.loads(row[0])
                    body = verify_certificate(certificate, backend.directory.network, backend.directory.pin)
                    if (body['owner'], body['device'], body['device_public']) != (owner[0], device, state['public_key']):
                        raise ValueError('cipher_scope_certificate_corrupt')
                    certificates.append(certificate)
                    if len(certificates) > 64:
                        raise ValueError('cipher_scope_device_limit')
                if len(certificates) == before:
                    raise ValueError('cipher_scope_member_has_no_active_device')
            certificates.sort(key=lambda item: (item['body']['owner'], item['body']['device']))
            if not 2 <= len(certificates) <= 64:
                raise ValueError('cipher_scope_device_limit')
            for key in ('ed25519', 'curve25519'):
                if len({item['body'][key] for item in certificates}) != len(certificates):
                    raise ValueError('cipher_scope_duplicate_sdk_key')
            roster = sha256(canonical({'members': sorted(members), 'owners': owners, 'certificates': certificates})).hexdigest()
            backend.db.execute('BEGIN IMMEDIATE')
            old = backend.db.execute('SELECT epoch,roster FROM cipher_scopes WHERE source=? AND scope=?', (source, scope)).fetchone()
            if old is not None and (type(old[0]) is not int or not 1 <= old[0] <= 2147483647 or not digest64(old[1])):
                raise ValueError('cipher_scope_checkpoint_corrupt')
            if old is None and backend.db.execute('SELECT COUNT(*) FROM cipher_scopes').fetchone()[0] >= 4096:
                raise ValueError('cipher_scope_capacity')
            epoch = 1 if old is None else old[0] + (old[1] != roster)
            if epoch > 2147483647:
                raise ValueError('cipher_scope_epoch_limit')
            if revalidate is not None and sorted(revalidate()) != sorted(members):
                raise ValueError('cipher_scope_acl_changed')
            backend.directory.anchor()
            body = {'domain': 'sfera-mesh-cipher-scope-v1', 'network': backend.directory.network,
                'genesis': backend.directory.pin, 'entry': backend.entry, 'source': source, 'scope': scope,
                'epoch': epoch, 'roster': roster, 'members': sorted(members), 'owners': owners, 'certificates': certificates,
                'nonce': nonce, 'issued_at': current, 'expires_at': current + 15,
                'membership_authority': 'selected_application'}
            result = {'body': body, 'signature': backend.entry_key.sign(canonical(body)).hex()}
            backend.db.execute('INSERT OR REPLACE INTO cipher_scopes VALUES(?,?,?,?)', (source, scope, epoch, roster))
            return result

    def _attest_distributed(self,user,claim,source,scope,members,nonce,*,now=None,revalidate=None):
        backend=self.sessions
        current=int(time.time()) if now is None else now
        if (source!='dm' or not isinstance(scope,str) or str(uuid.UUID(scope))!=scope or not digest64(nonce)
                or not isinstance(members,list) or str(user) not in members or backend.entry_key is None
                or not self.global_pins or type(current) is not int or current<0):
            raise ValueError('invalid_distributed_cipher_scope')
        with backend.directory.lock,backend.lock,backend.db:
            backend.require(str(user),claim,now=current)
            from .application_cipher import scope_for
            shared=scope_for(backend.directory.current['state'],backend.directory.network,backend.directory.pin,scope)
            if sorted(members)!=shared['members'] or revalidate is not None and sorted(revalidate())!=shared['members']:
                raise ValueError('distributed_cipher_acl_mismatch')
            if not any(binding['user']==str(user) and binding['owner']==claim['owner'] for binding in shared['owners']):
                raise ValueError('distributed_cipher_actor_mismatch')
            backend.db.execute('BEGIN IMMEDIATE')
            old=backend.db.execute('SELECT epoch,roster FROM cipher_scopes WHERE source=? AND scope=?',(source,scope)).fetchone()
            if old is not None and (old[0]>shared['epoch'] or old[0]==shared['epoch'] and old[1]!=shared['roster']):
                raise ValueError('distributed_cipher_scope_rollback_or_fork')
            backend.directory.anchor()
            # Refresh can advance the verified snapshot even while its lock is
            # held. Never sign a roster computed before a newly observed revoke.
            if scope_for(backend.directory.current['state'],backend.directory.network,backend.directory.pin,scope)!=shared:
                raise ValueError('distributed_cipher_scope_changed')
            if revalidate is not None and sorted(revalidate())!=shared['members']:
                raise ValueError('distributed_cipher_acl_mismatch')
            body={'domain':'sfera-mesh-cipher-scope-v2','network':backend.directory.network,'genesis':backend.directory.pin,
                'entry':backend.entry,'source':source,'scope':scope,**shared,'nonce':nonce,'issued_at':current,'expires_at':current+15,
                'membership_authority':'consensus_dialog'}
            result={'body':body,'signature':backend.entry_key.sign(canonical(body)).hex()}
            backend.db.execute('INSERT OR REPLACE INTO cipher_scopes VALUES(?,?,?,?)',(source,scope,shared['epoch'],shared['roster']))
            return result
