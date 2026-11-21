"""Scoped SDK key relay. Stores public documents and Olm ciphertext only.

Every operation, including cached retries and acknowledgements, rechecks the
application ACL and the current admitted device roster. No trust is established
by a key-query response: clients still verify device-signed certificates.
"""
import base64
from hashlib import sha256
import json
import re
import secrets
import time

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .cipher_authority import CipherAuthority
from .storage import canonical


def sdk_user(body):
    return '@' + body['owner'] + ':' + body['genesis'] + '.sphere'


def exact(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields):
        raise ValueError('invalid_cipher_relay_schema')


def public(value, size=32):
    if not isinstance(value, str) or not re.fullmatch('[A-Za-z0-9+/]+', value):
        raise ValueError('invalid_cipher_relay_base64')
    result = base64.b64decode(value + '=' * (-len(value) % 4), validate=True)
    if len(result) != size or base64.b64encode(result).decode().rstrip('=') != value:
        raise ValueError('invalid_cipher_relay_base64')
    return result


def signed(value, peer):
    if not isinstance(value, dict) or len(canonical(value)) > 8192:
        raise ValueError('invalid_cipher_relay_signed_key')
    try:
        signature = value['signatures'][sdk_user(peer)]['ed25519:' + peer['device']]
        # Matrix canonical JSON uses UTF-8. Key documents below contain only
        # explicitly validated ASCII fields and signatures are excluded.
        body = {key: item for key, item in value.items() if key not in ('signatures', 'unsigned')}
        Ed25519PublicKey.from_public_bytes(public(peer['ed25519'])).verify(public(signature, 64), canonical(body))
    except (KeyError, TypeError, InvalidSignature) as exc:
        raise ValueError('invalid_cipher_relay_key_signature') from exc


class CipherRelay:
    MAX_REQUESTS = 32768
    MAX_KEYS = 65536
    MAX_MAIL = 4096
    MAX_BYTES = 64 * 1024 * 1024

    def __init__(self, authority):
        if not isinstance(authority, CipherAuthority):
            raise ValueError('cipher_authority_required')
        self.authority, self.backend = authority, authority.sessions
        with self.backend.lock:
            self.backend.db.executescript('''
                CREATE TABLE IF NOT EXISTS cipher_relay_devices (
                    owner TEXT NOT NULL, device TEXT NOT NULL, body BLOB NOT NULL,
                    PRIMARY KEY(owner,device));
                CREATE TABLE IF NOT EXISTS cipher_relay_keys (
                    owner TEXT NOT NULL, device TEXT NOT NULL, id TEXT NOT NULL,
                    body BLOB NOT NULL, fallback INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(owner,device,id));
                CREATE TABLE IF NOT EXISTS cipher_relay_requests (
                    owner TEXT NOT NULL, device TEXT NOT NULL, id TEXT NOT NULL,
                    digest TEXT NOT NULL, response BLOB NOT NULL, PRIMARY KEY(owner,device,id));
                CREATE TABLE IF NOT EXISTS cipher_relay_mail (
                    id TEXT PRIMARY KEY, source TEXT NOT NULL, scope TEXT NOT NULL, roster TEXT NOT NULL, epoch INTEGER NOT NULL,
                    owner TEXT NOT NULL, device TEXT NOT NULL, sender_owner TEXT NOT NULL,
                    sender_device TEXT NOT NULL, body BLOB NOT NULL);
                CREATE INDEX IF NOT EXISTS cipher_relay_mail_target ON cipher_relay_mail(owner,device,source,scope);
            ''')

    def request(self, user, claim, source, scope, roster, epoch, request, members, *, revalidate, now=None):
        """members/revalidate are supplied by server ACL code, never request JSON."""
        exact(request, ('id', 'type', 'body'))
        if (not isinstance(request['id'], str) or not re.fullmatch('[A-Za-z0-9_.:-]{1,256}', request['id']) or
                type(request['type']) is not int or request['type'] not in (0, 1, 2, 3, 4, 5) or
                not isinstance(request['body'], str) or len(request['body'].encode()) > 262144):
            raise ValueError('invalid_cipher_relay_request')
        body = json.loads(request['body'])
        if not isinstance(body, dict):
            raise ValueError('invalid_cipher_relay_body')
        current = int(time.time()) if now is None else now
        backend = self.backend
        with backend.directory.lock, backend.lock:
            proof = self.authority.attest(user, claim, source, scope, members, secrets.token_hex(32),
                now=current, revalidate=revalidate)['body']
            if proof['roster'] != roster or type(epoch) is not int or proof['epoch'] != epoch:
                raise ValueError('cipher_relay_roster_changed')
            peers = {(sdk_user(item['body']), item['body']['device']): item['body'] for item in proof['certificates']}
            own = next((peer for peer in peers.values() if (peer['owner'], peer['device']) == (claim['owner'], claim['device'])), None)
            if own is None:
                raise ValueError('cipher_relay_device_not_member')
            digest = sha256(canonical([source, scope, roster, epoch, request])).hexdigest()
            identity = (claim['owner'], claim['device'], request['id'])
            with backend.db:
                backend.db.execute('BEGIN IMMEDIATE')
                backend.require(user, claim, now=current)
                if backend.db.execute('SELECT roster,epoch FROM cipher_scopes WHERE source=? AND scope=?',
                        (source, scope)).fetchone() != (roster, epoch):
                    raise ValueError('cipher_relay_roster_changed')
                # An A -> B -> A membership sequence must never resurrect old
                # queued keys. The epoch changes even when the roster hash returns.
                backend.db.execute('DELETE FROM cipher_relay_mail WHERE source=? AND scope=? AND (roster!=? OR epoch!=?)',
                    (source, scope, roster, epoch))
                previous = backend.db.execute('SELECT digest,response FROM cipher_relay_requests WHERE owner=? AND device=? AND id=?', identity).fetchone()
                if previous:
                    if previous[0] != digest:
                        raise ValueError('cipher_relay_request_conflict')
                    result = json.loads(previous[1])
                else:
                    if backend.db.execute('SELECT COUNT(*) FROM cipher_relay_requests').fetchone()[0] >= self.MAX_REQUESTS:
                        raise ValueError('cipher_relay_request_capacity')
                    result = self._perform(request['type'], body, own, peers, source, scope, roster, epoch)
                    raw = canonical(result)
                    if len(raw) > 1048576:
                        raise ValueError('cipher_relay_response_capacity')
                    backend.db.execute('INSERT INTO cipher_relay_requests VALUES(?,?,?,?,?)', (*identity, digest, raw))
                # Both new operations and replayed responses fail closed when
                # application membership changes while verification is running.
                if sorted(revalidate()) != sorted(members):
                    raise ValueError('cipher_relay_acl_changed')
                backend.require(user, claim, now=int(time.time()) if now is None else now)
                backend.directory.anchor()
                if now is None and proof['expires_at'] <= int(time.time()):
                    raise ValueError('cipher_relay_authorization_expired')
                used = sum(backend.db.execute('SELECT COALESCE(SUM(LENGTH(' + column + ')),0) FROM ' + table).fetchone()[0]
                    for table, column in (('cipher_relay_devices', 'body'), ('cipher_relay_keys', 'body'),
                        ('cipher_relay_requests', 'response'), ('cipher_relay_mail', 'body')))
                if used > self.MAX_BYTES:
                    raise ValueError('cipher_relay_byte_capacity')
            return result

    def _perform(self, kind, body, own, peers, source, scope, roster, epoch, *, mail_identity=None):
        db = self.backend.db
        identity = (own['owner'], own['device'])
        if kind == 0:
            if set(body) - {'device_keys', 'one_time_keys', 'fallback_keys'}:
                raise ValueError('invalid_cipher_relay_upload')
            if 'device_keys' in body:
                doc = body['device_keys']
                exact(doc, ('user_id', 'device_id', 'algorithms', 'keys', 'signatures'))
                if (doc['user_id'] != sdk_user(own) or doc['device_id'] != own['device'] or
                        doc['algorithms'] != ['m.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'] or
                        doc['keys'] != {'ed25519:' + own['device']: own['ed25519'], 'curve25519:' + own['device']: own['curve25519']}):
                    raise ValueError('cipher_relay_device_keys_mismatch')
                signed(doc, own)
                raw = canonical(doc)
                old = db.execute('SELECT body FROM cipher_relay_devices WHERE owner=? AND device=?', identity).fetchone()
                if old and bytes(old[0]) != raw:
                    raise ValueError('cipher_relay_device_keys_immutable')
                db.execute('INSERT OR IGNORE INTO cipher_relay_devices VALUES(?,?,?)', (*identity, raw))
            for field, fallback in (('one_time_keys', 0), ('fallback_keys', 1)):
                keys = body.get(field, {})
                if not isinstance(keys, dict) or len(keys) > (1 if fallback else 128):
                    raise ValueError('cipher_relay_key_limit')
                for key, value in keys.items():
                    if not re.fullmatch('signed_curve25519:[A-Za-z0-9+/]{1,128}', key):
                        raise ValueError('invalid_cipher_relay_key_id')
                    exact(value, ('key', 'signatures', 'fallback') if fallback else ('key', 'signatures'))
                    if fallback and value['fallback'] is not True:
                        raise ValueError('invalid_cipher_relay_fallback')
                    public(value['key']); signed(value, own)
                    raw = canonical(value)
                    old = db.execute('SELECT body,fallback,consumed FROM cipher_relay_keys WHERE owner=? AND device=? AND id=?', (*identity, key)).fetchone()
                    if old and (bytes(old[0]), old[1]) != (raw, fallback):
                        raise ValueError('cipher_relay_key_immutable')
                    if old and fallback and old[2]:
                        raise ValueError('cipher_relay_fallback_rollback')
                    if fallback:
                        db.execute('UPDATE cipher_relay_keys SET consumed=1 WHERE owner=? AND device=? AND fallback=1 AND id!=?', (*identity, key))
                    db.execute('INSERT OR IGNORE INTO cipher_relay_keys VALUES(?,?,?,?,?,0)', (*identity, key, raw, fallback))
            if (db.execute('SELECT COUNT(*) FROM cipher_relay_keys').fetchone()[0] > self.MAX_KEYS or
                    db.execute('SELECT COUNT(*) FROM cipher_relay_keys WHERE owner=? AND device=? AND consumed=0', identity).fetchone()[0] > 512):
                raise ValueError('cipher_relay_key_capacity')
            count = db.execute('SELECT COUNT(*) FROM cipher_relay_keys WHERE owner=? AND device=? AND fallback=0 AND consumed=0', identity).fetchone()[0]
            return {'one_time_key_counts': {'signed_curve25519': count}}
        if kind in (1, 2):
            field = 'device_keys' if kind == 1 else 'one_time_keys'
            if set(body) - {field, 'timeout', 'token'} or field not in body or not isinstance(body[field], dict) or len(body[field]) > 64:
                raise ValueError('invalid_cipher_relay_query')
            result = {}
            for user, targets in body[field].items():
                available = {device: peer for (name, device), peer in peers.items() if name == user}
                if not available:
                    raise ValueError('cipher_relay_target_not_member')
                if kind == 1:
                    if not isinstance(targets, list) or len(targets) > 64 or len(set(targets)) != len(targets):
                        raise ValueError('invalid_cipher_relay_targets')
                    targets = targets or sorted(available)
                elif not isinstance(targets, dict) or len(targets) > 64 or any(value != 'signed_curve25519' for value in targets.values()):
                    raise ValueError('invalid_cipher_relay_targets')
                result[user] = {}
                for device in targets:
                    if device not in available:
                        raise ValueError('cipher_relay_target_not_member')
                    target = (available[device]['owner'], device)
                    if kind == 1:
                        row = db.execute('SELECT body FROM cipher_relay_devices WHERE owner=? AND device=?', target).fetchone()
                        if row:
                            result[user][device] = json.loads(row[0])
                    else:
                        row = db.execute('SELECT id,body,fallback FROM cipher_relay_keys WHERE owner=? AND device=? AND consumed=0 ORDER BY fallback,id LIMIT 1', target).fetchone()
                        if row:
                            result[user][device] = {row[0]: json.loads(row[1])}
                            if not row[2]:
                                db.execute('UPDATE cipher_relay_keys SET consumed=1 WHERE owner=? AND device=? AND id=?', (*target, row[0]))
            return {field: result, 'failures': {}}
        if kind == 3:
            exact(body, ('messages',))
            if not isinstance(body['messages'], dict) or len(body['messages']) > 64:
                raise ValueError('invalid_cipher_relay_mail')
            for user, targets in body['messages'].items():
                if not isinstance(targets, dict) or not 1 <= len(targets) <= 64:
                    raise ValueError('invalid_cipher_relay_targets')
                for device, value in targets.items():
                    peer = peers.get((user, device))
                    if peer is None or (peer['owner'], device) == identity:
                        raise ValueError('cipher_relay_target_not_member')
                    fields = ('algorithm', 'sender_key', 'ciphertext')
                    if isinstance(value, dict) and 'key_receipt' in value:
                        fields += ('key_receipt',)
                        receipt = value['key_receipt']
                        exact(receipt, ('room', 'epoch', 'message_id', 'sender_device', 'content'))
                        if (type(receipt['epoch']) is not int or receipt['epoch'] != epoch or receipt['sender_device'] != own['device'] or
                                not isinstance(receipt['room'], str) or not re.fullmatch('![0-9a-f]{64}:' + own['genesis'] + r'\.sphere', receipt['room']) or
                                not isinstance(receipt['message_id'], str) or not re.fullmatch('[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}', receipt['message_id'])):
                            raise ValueError('invalid_cipher_relay_key_receipt')
                        content = receipt['content']
                        exact(content, ('algorithm', 'ciphertext', 'sender_key', 'session_id', 'device_id'))
                        if (content['algorithm'] != 'm.megolm.v1.aes-sha2' or content['sender_key'] != own['curve25519'] or
                                content['device_id'] != own['device'] or not isinstance(content['ciphertext'], str) or
                                not 1 <= len(content['ciphertext']) <= 8192 or not re.fullmatch('[A-Za-z0-9+/]+', content['ciphertext'])):
                            raise ValueError('invalid_cipher_relay_key_receipt')
                        public(content['session_id'])
                    if isinstance(value, dict) and 'org.matrix.msgid' in value:
                        fields += ('org.matrix.msgid',)
                        if not isinstance(value['org.matrix.msgid'], str) or not re.fullmatch('[A-Za-z0-9_-]{1,128}', value['org.matrix.msgid']):
                            raise ValueError('invalid_cipher_relay_message_id')
                    exact(value, fields)
                    if value['algorithm'] != 'm.olm.v1.curve25519-aes-sha2' or value['sender_key'] != own['curve25519']:
                        raise ValueError('cipher_relay_mail_sender_mismatch')
                    exact(value['ciphertext'], (peer['curve25519'],))
                    cipher = value['ciphertext'][peer['curve25519']]
                    exact(cipher, ('type', 'body'))
                    if type(cipher['type']) is not int or cipher['type'] not in (0, 1) or not isinstance(cipher['body'], str) or not 1 <= len(cipher['body']) <= 131000 or not re.fullmatch('[A-Za-z0-9+/]+', cipher['body']):
                        raise ValueError('invalid_cipher_relay_ciphertext')
                    if len(canonical(value)) > 131000:
                        raise ValueError('cipher_relay_packet_capacity')
                    if db.execute('SELECT COUNT(*) FROM cipher_relay_mail WHERE owner=? AND device=?', (peer['owner'], device)).fetchone()[0] >= 64:
                        raise ValueError('cipher_relay_recipient_capacity')
                    mail_id=mail_identity(peer['owner'],device) if mail_identity else secrets.token_hex(32)
                    db.execute('INSERT OR IGNORE INTO cipher_relay_mail VALUES(?,?,?,?,?,?,?,?,?,?)', (mail_id, source, scope, roster, epoch,
                        peer['owner'], device, *identity, canonical(value)))
            if db.execute('SELECT COUNT(*) FROM cipher_relay_mail').fetchone()[0] > self.MAX_MAIL:
                raise ValueError('cipher_relay_mail_capacity')
            return {}
        if kind == 4:
            exact(body, ())
            rows = db.execute('SELECT id,sender_owner,sender_device,body FROM cipher_relay_mail WHERE owner=? AND device=? AND source=? AND scope=? AND roster=? AND epoch=? ORDER BY rowid LIMIT 16', (*identity, source, scope, roster, epoch))
            messages = []
            for row in rows:
                item = {'id': row[0], 'sender': {'owner': row[1], 'device': row[2]}, 'content': json.loads(row[3])}
                if len(canonical({'messages': messages + [item]})) > 1048576:
                    break
                messages.append(item)
            return {'messages': messages}
        exact(body, ('ids',))
        if not isinstance(body['ids'], list) or not 1 <= len(body['ids']) <= 16 or any(not isinstance(key, str) or not re.fullmatch('[0-9a-f]{64}', key) for key in body['ids']):
            raise ValueError('invalid_cipher_relay_ack')
        for key in body['ids']:
            db.execute('DELETE FROM cipher_relay_mail WHERE id=? AND owner=? AND device=? AND source=? AND scope=? AND roster=? AND epoch=?', (key, *identity, source, scope, roster, epoch))
        return {}
