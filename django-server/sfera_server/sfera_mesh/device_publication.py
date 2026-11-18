"""Durable owner-approved enrollment/revocation for an already bound account."""
import json
from hashlib import sha256
from .storage import canonical
from .account_publication import AccountPublication
from .devices import verify_event, validate_device_state
from .account_controls import controller_public


class DevicePublication:
    def __init__(self, sessions):
        self.sessions = sessions
        with sessions.lock:
            sessions.db.execute('''CREATE TABLE IF NOT EXISTS device_candidates (
                owner TEXT NOT NULL, digest TEXT NOT NULL, event BLOB NOT NULL,
                PRIMARY KEY(owner,digest))''')
            sessions.db.commit()

    def head(self, user, claim, nonce):
        s = self.sessions
        with s.directory.lock, s.lock:
            account = AccountPublication(s).head(user, claim, nonce, controlled=True)
            devices = s.directory.device_history(claim['owner'])
            if devices['finality'] != account['body']['finality']:
                raise ValueError('device_head_changed')
            return {'account': account, 'events': devices['events']}

    def publish(self, user, claim, event, submit):
        s = self.sessions
        event = json.loads(canonical(event))
        if not isinstance(event, dict) or len(canonical(event)) > 2048:
            raise ValueError('invalid_device_candidate')
        digest, raw = sha256(canonical(event)).hexdigest(), canonical(event)
        with s.directory.lock, s.lock, s.db:
            s.require(str(user), claim)
            state = s.directory.current['state']
            history = state.get('devices', {}).get(claim['owner'], [])
            if any(head['digest'] == digest and head['event'] == event for head in history):
                return {'state': 'confirmed', 'digest': digest}
            body, checked = verify_event(event, s.directory.network, controller_public(state, claim['owner']), expected_owner=claim['owner'])
            if checked != digest or body['version'] != len(history)+1 or body['previous'] != (history[-1]['digest'] if history else '0'*64):
                raise ValueError('device_candidate_conflict')
            if body['operation'] == 'revoke' and body['device_id'] == claim['device']:
                raise ValueError('revoke_from_other_device_required')
            controllers = {head['record']['body']['public_key'] for head in state['accounts'].values()}
            controllers.update(head['record']['body']['new_public'] for chain in state.get('account_controls', {}).values() for head in chain)
            if body['device_public'] in controllers:
                raise ValueError('device_controller_key_reuse')
            staged = json.loads(canonical(state))
            staged.setdefault('devices', {})[claim['owner']] = history + [{'event':event,'digest':digest}]
            validate_device_state(staged, s.directory.network)
            s.db.execute('BEGIN IMMEDIATE')
            # Committed events already have their durable receipt in consensus.
            # Keep the bounded SQL queue for unconfirmed intents, so normal
            # enroll/revoke cycles do not exhaust it over the account lifetime.
            s.db.executemany('DELETE FROM device_candidates WHERE owner=? AND digest=?',
                [(claim['owner'], head['digest']) for head in history])
            old = s.db.execute('SELECT event FROM device_candidates WHERE owner=? AND digest=?', (claim['owner'],digest)).fetchone()
            if old is not None and bytes(old[0]) != raw:
                raise ValueError('device_candidate_fork')
            if old is None:
                count = s.db.execute('SELECT COUNT(*) FROM device_candidates WHERE owner=?', (claim['owner'],)).fetchone()[0]
                total = s.db.execute('SELECT COUNT(*) FROM device_candidates').fetchone()[0]
                if count >= 64 or total >= 4096:
                    raise ValueError('device_candidate_capacity')
                s.db.execute('INSERT INTO device_candidates VALUES(?,?,?)', (claim['owner'],digest,raw))
        submit(event)
        return {'state':'pending','digest':digest}
