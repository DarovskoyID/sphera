"""Durable encrypted account candidates; only a verified directory confirms them."""
from hashlib import sha256
import json
import re
import time

from .directory import digest64, validate_record
from .storage import canonical
from .account_controls import account_signer, validate_controls


class AccountPublication:
    def __init__(self, sessions):
        self.sessions = sessions
        with sessions.lock:
            sessions.db.execute('''CREATE TABLE IF NOT EXISTS account_candidates (
                owner TEXT NOT NULL, digest TEXT NOT NULL, record BLOB NOT NULL,
                vault BLOB NOT NULL, PRIMARY KEY(owner,digest))''')
            sessions.db.commit()

    def publish_control(self, user, claim, update, vault, submit):
        """Persist the exact atomic transition before broadcasting it."""
        backend = self.sessions
        update, vault = json.loads(canonical(update)), json.loads(canonical(vault))
        if (not isinstance(update, dict) or set(update) != {'body', 'control', 'account'}
                or update['body'] != {'domain': 'sfera-mesh-account-control-update-v1',
                    'network': backend.directory.network, 'genesis': backend.directory.pin}
                or len(canonical(update)) > 16384):
            raise ValueError('invalid_account_control_update')
        control, record = update['control'], update['account']
        if not isinstance(control, dict) or not isinstance(control.get('body'), dict):
            raise ValueError('invalid_account_control_update')
        b = control['body']
        body, digest = validate_record(record, backend.directory.network, claim['owner'], controller_public=b.get('new_public'))
        self._vault(vault, claim['owner'], body['vault_digest'])
        raw_update, raw_vault = canonical(update), canonical(vault)
        with backend.directory.lock, backend.lock, backend.db:
            backend.require(str(user), claim)
            head = backend.directory.get(claim['owner'])
            history = head.get('control_history', [])
            control_digest = sha256(canonical(control)).hexdigest()
            # A committed historical transition is an exact retry, never a new
            # transition from an obsolete controller. Match the bound account.
            committed = next((item for item in history if item['digest'] == control_digest), None)
            if committed is not None:
                if committed['record'] != control or b.get('replacement_digest') != digest:
                    raise ValueError('account_control_retry_conflict')
                return {'state': 'confirmed', 'digest': digest}
            devices = backend.directory.device_history(claim['owner'])
            previous = head['record']['body']
            if (b.get('account_version') != previous['version'] or b.get('account_digest') != head['record_hash']
                    or b.get('devices_version') != devices['version'] or b.get('devices_digest') != devices['digest']
                    or b.get('replacement_digest') != digest or body['previous'] != head['record_hash']
                    or body['version'] != previous['version'] + 1 or body['public_key'] != previous['public_key']
                    or body['dialogs_digest'] != previous['dialogs_digest']):
                raise ValueError('account_control_checkpoint_conflict')
            # Validate against the full checked state, including all other owners
            # and device keys, so global key reuse is rejected before broadcast.
            staged = json.loads(canonical(backend.directory.current['state']))
            staged['accounts'][claim['owner']] = {'record': record, 'digest': digest}
            staged.setdefault('account_controls', {})[claim['owner']] = history + [{'record': control, 'digest': control_digest}]
            validate_controls(staged, backend.directory.network, backend.directory.pin)
            backend.db.execute('BEGIN IMMEDIATE')
            old = backend.db.execute('SELECT record,vault FROM account_candidates WHERE owner=? AND digest=?', (claim['owner'], digest)).fetchone()
            if old is not None and (bytes(old[0]), bytes(old[1])) != (raw_update, raw_vault):
                raise ValueError('account_candidate_fork')
            if old is None:
                count = backend.db.execute('SELECT COUNT(*) FROM account_candidates WHERE owner=?', (claim['owner'],)).fetchone()[0]
                total = backend.db.execute('SELECT COUNT(*) FROM account_candidates').fetchone()[0]
                if count >= 8 or total >= 4096:
                    raise ValueError('account_candidate_capacity')
                backend.db.execute('INSERT INTO account_candidates VALUES(?,?,?,?)', (claim['owner'], digest, raw_update, raw_vault))
        submit(update)
        return {'state': 'pending', 'digest': digest}

    @staticmethod
    def _vault(vault, owner, digest):
        if (not isinstance(vault, dict) or set(vault) != {'version', 'profile', 'userId', 'salt', 'nonce', 'wrappedRoot'}
                or type(vault['version']) is not int or vault['version'] != 1 or vault['profile'] != 'argon2id-64m-t3-p1'
                or vault['userId'] != owner):
            raise ValueError('invalid_account_candidate_vault')
        for field, length in [('salt', 32), ('nonce', 24), ('wrappedRoot', 96)]:
            if not isinstance(vault[field], str) or re.fullmatch('[0-9a-f]{%d}' % length, vault[field]) is None:
                raise ValueError('invalid_account_candidate_vault')
        if sha256(canonical(vault)).hexdigest() != digest:
            raise ValueError('account_candidate_vault_mismatch')

    def head(self, user, claim, nonce, *, now=None, controlled=False):
        backend = self.sessions
        current = int(time.time()) if now is None else now
        if not digest64(nonce) or type(current) is not int or backend.entry_key is None:
            raise ValueError('invalid_account_head_request')
        with backend.directory.lock, backend.lock:
            backend.require(str(user), claim, now=current)
            result = backend.directory.get(claim['owner'])
            if 'record' not in result:
                raise ValueError('account_head_missing')
            record = json.loads(canonical(result['record']))
            _, digest = validate_record(record, backend.directory.network, claim['owner'], controller_public=account_signer(result))
            if digest != result['record_hash']:
                raise ValueError('account_head_corrupt')
            anchor = backend.directory.anchor()
            if anchor != result['finality']:
                raise ValueError('account_head_changed')
            expires = min(current + 15, int(anchor['expires_at']))
            if expires <= current:
                raise ValueError('account_head_expired')
            body = {'domain': 'sfera-mesh-application-account-head-v1',
                'network': backend.directory.network, 'genesis': backend.directory.pin,
                'entry': backend.entry, 'owner': claim['owner'], 'device': claim['device'],
                'nonce': nonce, 'record': record, 'digest': digest, 'finality': anchor,
                'issued_at': current, 'expires_at': expires,
                'authority': 'selected_entry_verified_directory'}
            if controlled:
                devices = backend.directory.device_history(claim['owner'])
                if devices['finality'] != anchor:
                    raise ValueError('account_head_changed')
                body.update(domain='sfera-mesh-application-account-head-v2',
                    control_history=result.get('control_history', []),
                    devices_version=devices['version'], devices_digest=devices['digest'])
            return {'body': body, 'signature': backend.entry_key.sign(canonical(body)).hex()}

    def publish(self, user, claim, record, vault, submit):
        backend = self.sessions
        record, vault = json.loads(canonical(record)), json.loads(canonical(vault))
        with backend.directory.lock, backend.lock:
            backend.require(str(user), claim)
            checked_head = backend.directory.get(claim['owner'])
            body, digest = validate_record(record, backend.directory.network, claim['owner'], controller_public=checked_head.get('controller_public'))
        if (not isinstance(vault, dict) or set(vault) != {'version', 'profile', 'userId', 'salt', 'nonce', 'wrappedRoot'}
                or type(vault['version']) is not int or vault['version'] != 1 or vault['profile'] != 'argon2id-64m-t3-p1'
                or vault['userId'] != claim['owner']):
            raise ValueError('invalid_account_candidate_vault')
        for field, length in [('salt', 32), ('nonce', 24), ('wrappedRoot', 96)]:
            if not isinstance(vault[field], str) or re.fullmatch('[0-9a-f]{%d}' % length, vault[field]) is None:
                raise ValueError('invalid_account_candidate_vault')
        raw_vault = canonical(vault)
        if sha256(raw_vault).hexdigest() != body['vault_digest']:
            raise ValueError('account_candidate_vault_mismatch')
        with backend.directory.lock, backend.lock, backend.db:
            backend.require(str(user), claim)
            head = backend.directory.get(claim['owner'])
            validate_record(record, backend.directory.network, claim['owner'], controller_public=head.get('controller_public'))
            if 'record' not in head:
                raise ValueError('account_head_missing')
            if head['record_hash'] == digest:
                return {'state': 'confirmed', 'digest': digest}
            previous = head['record']['body']
            if (body['version'] != previous['version'] + 1 or body['previous'] != head['record_hash']
                    or body['public_key'] != previous['public_key'] or body['dialogs_digest'] != previous['dialogs_digest']):
                raise ValueError('account_candidate_conflict')
            backend.db.execute('BEGIN IMMEDIATE')
            old = backend.db.execute('SELECT record,vault FROM account_candidates WHERE owner=? AND digest=?', (claim['owner'], digest)).fetchone()
            raw_record = canonical(record)
            if old is not None and (bytes(old[0]), bytes(old[1])) != (raw_record, raw_vault):
                raise ValueError('account_candidate_fork')
            if old is None:
                count = backend.db.execute('SELECT COUNT(*) FROM account_candidates WHERE owner=?', (claim['owner'],)).fetchone()[0]
                total = backend.db.execute('SELECT COUNT(*) FROM account_candidates').fetchone()[0]
                if count >= 8 or total >= 4096:
                    raise ValueError('account_candidate_capacity')
                backend.db.execute('INSERT INTO account_candidates VALUES(?,?,?,?)', (claim['owner'], digest, raw_record, raw_vault))
        # Intent is durable before network I/O. A lost response permits the same
        # exact signed transaction; a competing update is rejected by consensus.
        submit(record)
        return {'state': 'pending', 'digest': digest}
