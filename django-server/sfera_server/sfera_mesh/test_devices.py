import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .devices import DeviceRegistry, device_id, verify_event, validate_device_state, DOMAIN
from .directory import user_id, ZERO
from .storage import canonical


class DeviceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'devices.sqlite3'
        self.owner = Ed25519PrivateKey.generate()
        self.public = self.owner.public_key().public_bytes_raw().hex()
        self.device = Ed25519PrivateKey.generate()
        self.registry = DeviceRegistry(self.path, 'lab', self.public)
        self.addCleanup(self.registry.close)

    def event(self, operation='enroll', key=None, head=None):
        key = key or self.device
        state = self.registry.snapshot()
        version, previous = head or (state['version'], state['digest'])
        public = key.public_key().public_bytes_raw()
        body = {'domain': DOMAIN, 'network': 'lab', 'user_id': user_id(bytes.fromhex(self.public)),
                'version': version + 1, 'previous': previous, 'operation': operation,
                'device_id': device_id(public), 'device_public': public.hex()}
        return {'body': body, 'owner_signature': self.owner.sign(canonical(body)).hex(),
                'device_signature': key.sign(canonical(body)).hex() if operation == 'enroll' else ''}

    def test_enroll_revoke_restart_exact_retry_and_checkpoint(self):
        first = self.event()
        head = self.registry.apply(first)
        identity = first['body']['device_id']
        self.assertEqual(self.registry.require_active(identity, (head['version'], head['digest'])), first['body']['device_public'])
        revoke = self.event('revoke')
        head = self.registry.apply(revoke)
        self.registry.apply(first)
        self.assertFalse(self.registry.snapshot()['devices'][identity]['active'])
        with self.assertRaises(ValueError):
            self.registry.require_active(identity, (head['version'], head['digest']))
        self.registry.close()
        self.registry = DeviceRegistry(self.path, 'lab', self.public, (head['version'], head['digest']))
        self.addCleanup(self.registry.close)
        with self.assertRaises(ValueError):
            self.registry.apply(self.event())  # Cannot re-enroll same key after revocation.
        with self.assertRaises(ValueError):
            DeviceRegistry(self.path, 'other', self.public)
        with self.assertRaises(ValueError):
            DeviceRegistry(self.path, 'lab', self.public, (2, ZERO))
        with self.assertRaises(ValueError):
            self.registry.require_active(identity, (1, first['body']['previous']))

    def test_rotation_batch_rolls_back_and_two_connections_conflict(self):
        self.registry.apply(self.event())
        before = self.registry.snapshot()
        revoke = self.event('revoke')
        revoke_hash = verify_event(revoke, 'lab', self.public)[1]
        replacement = Ed25519PrivateKey.generate()
        enroll = self.event(key=replacement, head=(2, revoke_hash))
        broken = json.loads(canonical(enroll))
        broken['device_signature'] = '00' * 64
        with self.assertRaises(ValueError):
            self.registry.apply_batch([revoke, broken])
        self.assertEqual(before, self.registry.snapshot())
        # Failure after the revoke INSERT must also roll it back.
        invalid_transition = self.event(head=(2, revoke_hash))
        with self.assertRaises(ValueError):
            self.registry.apply_batch([revoke, invalid_transition])
        self.assertEqual(before, self.registry.snapshot())
        other = DeviceRegistry(self.path, 'lab', self.public)
        self.addCleanup(other.close)
        alternative = self.event(key=Ed25519PrivateKey.generate())
        head = self.registry.apply_batch([revoke, enroll])
        with self.assertRaises(ValueError):
            other.apply(alternative)
        self.assertEqual(head['digest'], other.snapshot()['digest'])

    def test_tampered_history_and_missing_possession_rejected(self):
        first = self.event()
        changed = json.loads(canonical(first))
        changed['device_signature'] = ''
        with self.assertRaises(ValueError):
            self.registry.apply(changed)
        changed = json.loads(canonical(first))
        changed['body']['network'] = 'foreign'
        with self.assertRaises(ValueError):
            self.registry.apply(changed)
        self.registry.apply(first)
        self.registry.close()
        db = sqlite3.connect(self.path)
        db.execute('UPDATE device_events SET digest=?', (ZERO,))
        db.commit()
        db.close()
        with self.assertRaises(ValueError):
            DeviceRegistry(self.path, 'lab', self.public)

    def test_public_cross_language_fixture(self):
        fixture = json.loads((Path(__file__).resolve().parents[3] / 'scripts' / 'fixtures' / 'mesh-devices.json').read_text())
        for event in fixture['events']:
            verify_event(event, fixture['network'], fixture['owner_public'])
        db = DeviceRegistry(Path(self.temp.name) / 'fixture.sqlite3', fixture['network'], fixture['owner_public'])
        try:
            for event in fixture['events']:
                db.apply(event)
            self.assertEqual(db.snapshot()['digest'], fixture['digest'])
        finally:
            db.close()

    def test_consensus_snapshot_rejects_duplicate_versions_and_unknown_owners(self):
        events = [self.event()]
        first_hash = verify_event(events[0], 'lab', self.public)[1]
        events.append(self.event('revoke', head=(1, first_hash)))
        identity = events[0]['body']['user_id']
        heads = [{'event': event, 'digest': verify_event(event, 'lab', self.public)[1]} for event in events]
        state = {'accounts': {identity: {'record': {'body': {'public_key': self.public}}}}, 'devices': {identity: heads}}
        summary = validate_device_state(state, 'lab')[identity]
        self.assertFalse(summary['devices'][events[0]['body']['device_id']]['active'])
        corrupted = json.loads(canonical(state))
        corrupted['devices'][identity].append(heads[-1])
        with self.assertRaises(ValueError):
            validate_device_state(corrupted, 'lab')
        state['accounts'] = {}
        with self.assertRaises(ValueError):
            validate_device_state(state, 'lab')


if __name__ == '__main__':
    unittest.main()
