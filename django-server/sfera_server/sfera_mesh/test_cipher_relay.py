import base64
import copy
import json
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
import subprocess
import sys
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from . import test_cipher_authority as fixture
from .application_sessions import ApplicationSessions
from .cipher_authority import CipherAuthority
from .cipher_relay import CipherRelay, sdk_user
from .consensus_directory import ConsensusUnavailable
from .storage import canonical


def isolated_process_request():
    """Disposable test-only roots arrive over stdin, never command arguments."""
    data = json.load(sys.stdin)
    directory = fixture.Directory()
    directory.owners = data['owners']
    backend = ApplicationSessions(data['path'], directory, data['entry'],
        entry_key=Ed25519PrivateKey.from_private_bytes(bytes.fromhex(data['test_entry_key'])))
    try:
        result = CipherRelay(CipherAuthority(backend)).request(data['user'], data['claim'], 'dm',
            data['scope'], data['roster'], data['epoch'], data['request'], data['members'],
            revalidate=lambda: data['members'], now=103)
        print(json.dumps(result))
    finally:
        backend.close()


class RelayTests(unittest.TestCase):
    person = fixture.CipherAuthorityTests.person
    event = fixture.CipherAuthorityTests.event

    def setUp(self):
        fixture.CipherAuthorityTests.setUp(self)
        self.relay = CipherRelay(self.authority)
        self.members = [self.alice['user'], self.bob['user']]

    def request(self, person, kind, body, *, id=None, relay=None, roster=None, revalidate=None):
        proof = self.authority.attest(person['user'], person['claim'], 'dm', self.scope,
            self.members, 'f'*64, now=103)['body']
        return (relay or self.relay).request(person['user'], person['claim'], 'dm', self.scope, roster or proof['roster'], proof['epoch'],
            {'id': id or str(uuid.uuid4()), 'type': kind, 'body': json.dumps(body)}, self.members,
            revalidate=revalidate or (lambda: self.members), now=103)

    def sign(self, person, value):
        peer = person['certificate']['body']
        result = copy.deepcopy(value)
        signature = person['sdk_signing'].sign(canonical(value))
        result['signatures'] = {sdk_user(peer): {'ed25519:' + peer['device']: base64.b64encode(signature).decode().rstrip('=')}}
        return result

    def upload(self, person, count=2):
        peer = person['certificate']['body']
        device = self.sign(person, {'user_id': sdk_user(peer), 'device_id': peer['device'],
            'algorithms': ['m.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'],
            'keys': {'ed25519:' + peer['device']: peer['ed25519'], 'curve25519:' + peer['device']: peer['curve25519']}})
        keys = {'signed_curve25519:' + chr(65+i): self.sign(person, {'key': peer['curve25519']}) for i in range(count)}
        body = {'device_keys': device, 'one_time_keys': keys}
        self.request(person, 0, body)
        return body

    def claim(self, person=None, **kwargs):
        peer = self.bob['certificate']['body']
        return self.request(person or self.alice, 2, {'one_time_keys': {sdk_user(peer): {peer['device']: 'signed_curve25519'}}}, **kwargs)

    def mail(self):
        alice, bob = [item['certificate']['body'] for item in (self.alice, self.bob)]
        return {'messages': {sdk_user(bob): {bob['device']: {'algorithm': 'm.olm.v1.curve25519-aes-sha2',
            'sender_key': alice['curve25519'], 'ciphertext': {bob['curve25519']: {'type': 0, 'body': 'QUJD'}}}}}}

    def test_signed_upload_query_and_atomic_claim_retry_survive_connection_restart(self):
        body = self.upload(self.bob)
        peer = self.bob['certificate']['body']
        queried = self.request(self.alice, 1, {'device_keys': {sdk_user(peer): []}})
        self.assertEqual(queried['device_keys'][sdk_user(peer)][peer['device']], body['device_keys'])
        first = self.claim(id='retry')
        second = ApplicationSessions(self.path, self.directory, self.entry, entry_key=self.key)
        self.addCleanup(second.close)
        relay = CipherRelay(CipherAuthority(second))
        self.assertEqual(self.claim(id='retry', relay=relay), first)
        self.assertNotEqual(self.claim(), first)
        self.assertEqual(self.claim()['one_time_keys'][sdk_user(peer)], {})
        # Re-uploading consumed IDs cannot resurrect a one-time key.
        self.request(self.bob, 0, body)
        self.assertEqual(self.claim()['one_time_keys'][sdk_user(peer)], {})

    def test_device_and_one_time_key_signatures_and_binding(self):
        body = self.upload(self.bob)
        for change in ('signature', 'pin', 'owner'):
            bad = copy.deepcopy(body)
            if change == 'signature':
                signatures = bad['device_keys']['signatures']
                signatures[next(iter(signatures))][next(iter(next(iter(signatures.values()))))] = 'A'*86
            elif change == 'pin':
                bad['device_keys']['keys']['ed25519:' + self.bob['device']] = 'A'*43
            else:
                bad['device_keys']['user_id'] = sdk_user(self.alice['certificate']['body'])
            with self.assertRaises(ValueError):
                self.request(self.bob, 0, bad)
        bad = copy.deepcopy(body)
        key = next(iter(bad['one_time_keys'].values())); key['key'] = 'A'*43
        with self.assertRaises(ValueError):
            self.request(self.bob, 0, bad)

    def test_mail_retry_poll_and_recipient_scoped_ack(self):
        self.request(self.alice, 3, self.mail(), id='mail')
        self.request(self.alice, 3, self.mail(), id='mail')
        pending = self.request(self.bob, 4, {})['messages']
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]['sender'], {'owner': self.alice['owner'], 'device': self.alice['device']})
        self.assertEqual(self.request(self.alice, 4, {})['messages'], [])
        self.request(self.alice, 5, {'ids': [pending[0]['id']]})
        self.assertEqual(len(self.request(self.bob, 4, {})['messages']), 1)
        self.request(self.bob, 5, {'ids': [pending[0]['id']]})
        self.assertEqual(self.request(self.bob, 4, {})['messages'], [])

    def test_key_receipt_headers_are_bounded_and_bound_to_context(self):
        peer = self.bob['certificate']['body']
        mail = self.mail()
        content = mail['messages'][sdk_user(peer)][peer['device']]
        receipt = {'room': '!' + 'f'*64 + ':' + self.directory.pin + '.sphere', 'epoch': 1,
            'message_id': str(uuid.uuid4()), 'sender_device': self.alice['device'],
            'content': {'algorithm': 'm.megolm.v1.aes-sha2', 'ciphertext': 'QUJD', 'session_id': 'A'*43,
                'sender_key': self.alice['certificate']['body']['curve25519'], 'device_id': self.alice['device']}}
        content['key_receipt'] = receipt
        for field, value in (('epoch', 0), ('sender_device', self.bob['device']), ('message_id', 'bad'), ('room', '!other')):
            bad = copy.deepcopy(mail)
            bad['messages'][sdk_user(peer)][peer['device']]['key_receipt'][field] = value
            with self.assertRaises(ValueError):
                self.request(self.alice, 3, bad)
        for field, value in (('session_id', 'bad'), ('ciphertext', 'A'*8193), ('device_id', self.bob['device'])):
            bad = copy.deepcopy(mail)
            bad['messages'][sdk_user(peer)][peer['device']]['key_receipt']['content'][field] = value
            with self.assertRaises(ValueError):
                self.request(self.alice, 3, bad)
        self.assertEqual(self.backend.db.execute('SELECT COUNT(*) FROM cipher_relay_mail').fetchone()[0], 0)
        self.request(self.alice, 3, mail)
        self.assertEqual(len(self.request(self.bob, 4, {})['messages']), 1)

    def test_nonmember_targets_plaintext_and_conflicting_retry_rejected(self):
        peer = self.bob['certificate']['body']
        with self.assertRaisesRegex(ValueError, 'target_not_member'):
            self.request(self.alice, 1, {'device_keys': {'@outsider': []}})
        bad = self.mail(); bad['messages'][sdk_user(peer)][peer['device']]['text'] = 'leak'
        with self.assertRaises(ValueError):
            self.request(self.alice, 3, bad)
        self.request(self.alice, 4, {}, id='same')
        with self.assertRaisesRegex(ValueError, 'request_conflict'):
            self.request(self.alice, 1, {'device_keys': {sdk_user(peer): []}}, id='same')

    def test_stale_roster_revocation_and_outage_block_cached_responses(self):
        self.request(self.alice, 4, {}, id='cached')
        with self.assertRaisesRegex(ValueError, 'roster_changed'):
            self.request(self.alice, 4, {}, roster='0'*64)
        self.directory.available = False
        with self.assertRaises(ConsensusUnavailable):
            self.request(self.alice, 4, {}, id='cached')
        self.directory.available = True
        self.event(self.bob, 'revoke')
        with self.assertRaises(ValueError):
            self.request(self.alice, 4, {}, id='cached')

    def test_atomic_rollback_on_acl_race_and_capacity(self):
        calls = []
        def changed():
            calls.append(1)
            return self.members if len(calls) == 1 else [self.alice['user']]
        with self.assertRaisesRegex(ValueError, 'acl_changed'):
            self.request(self.alice, 3, self.mail(), revalidate=changed)
        self.assertEqual(self.backend.db.execute('SELECT COUNT(*) FROM cipher_relay_mail').fetchone()[0], 0)
        self.relay.MAX_BYTES = 1
        with self.assertRaisesRegex(ValueError, 'byte_capacity'):
            self.request(self.alice, 3, self.mail())
        self.assertEqual(self.backend.db.execute('SELECT COUNT(*) FROM cipher_relay_requests').fetchone()[0], 0)
        self.assertEqual(self.backend.db.execute('SELECT COUNT(*) FROM cipher_relay_mail').fetchone()[0], 0)

    def test_membership_round_trip_cannot_resurrect_old_mail_or_poll_cache(self):
        self.request(self.alice, 3, self.mail())
        self.request(self.bob, 4, {}, id='old-poll')
        old = self.authority.attest(self.alice['user'], self.alice['claim'], 'dm', self.scope,
            self.members, 'f'*64, now=103)['body']
        carol = self.person()
        self.members.append(carol['user'])
        self.authority.attest(self.alice['user'], self.alice['claim'], 'dm', self.scope,
            self.members, 'f'*64, now=103)
        self.members.remove(carol['user'])
        new = self.authority.attest(self.alice['user'], self.alice['claim'], 'dm', self.scope,
            self.members, 'f'*64, now=103)['body']
        self.assertEqual(old['roster'], new['roster'])
        self.assertGreater(new['epoch'], old['epoch'])
        with self.assertRaisesRegex(ValueError, 'request_conflict'):
            self.request(self.bob, 4, {}, id='old-poll')
        self.assertEqual(self.request(self.bob, 4, {})['messages'], [])

    def test_independent_connections_cannot_claim_the_same_one_time_key(self):
        self.upload(self.bob, count=1)
        directory = fixture.Directory()
        directory.owners = copy.deepcopy(self.directory.owners)
        second = ApplicationSessions(self.path, directory, self.entry, entry_key=self.key)
        self.addCleanup(second.close)
        relay = CipherRelay(CipherAuthority(second))
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda item: self.claim(relay=item), (self.relay, relay)))
        peer = self.bob['certificate']['body']
        self.assertEqual(sum(len(result['one_time_keys'][sdk_user(peer)]) for result in results), 1)

    def test_new_process_replays_committed_claim_and_reads_unacknowledged_mail(self):
        self.upload(self.bob, count=1)
        first = self.claim(id='process-retry')
        self.request(self.alice, 3, self.mail())
        peer = self.bob['certificate']['body']
        for person, request in ((self.alice, {'id': 'process-retry', 'type': 2,
                'body': json.dumps({'one_time_keys': {sdk_user(peer): {peer['device']: 'signed_curve25519'}}})}),
                (self.bob, {'id': 'process-poll', 'type': 4, 'body': '{}'})):
            proof = self.authority.attest(person['user'], person['claim'], 'dm', self.scope,
                self.members, 'f'*64, now=103)['body']
            data = {'path': self.path, 'entry': self.entry, 'owners': self.directory.owners,
                'test_entry_key': self.key.private_bytes_raw().hex(), 'user': person['user'], 'claim': person['claim'],
                'scope': self.scope, 'members': self.members, 'roster': proof['roster'], 'epoch': proof['epoch'], 'request': request}
            result = subprocess.run([sys.executable, '-c',
                'from sfera_mesh.test_cipher_relay import isolated_process_request; isolated_process_request()'],
                input=json.dumps(data), text=True, capture_output=True, timeout=30,
                cwd=str(Path(__file__).resolve().parents[1]))
            self.assertEqual(result.returncode, 0, result.stderr)
            decoded = json.loads(result.stdout)
            if person is self.alice:
                self.assertEqual(decoded, first)
            else:
                self.assertEqual(len(decoded['messages']), 1)

    def test_large_mail_poll_is_bounded_and_can_be_drained(self):
        peer = self.bob['certificate']['body']
        body = self.mail()
        body['messages'][sdk_user(peer)][peer['device']]['ciphertext'][peer['curve25519']]['body'] = 'A'*130000
        for _ in range(12):
            self.request(self.alice, 3, body)
        first = self.request(self.bob, 4, {})
        self.assertLessEqual(len(canonical(first)), 1048576)
        self.assertGreater(len(first['messages']), 0)
        self.assertLess(len(first['messages']), 12)
        self.request(self.bob, 5, {'ids': [item['id'] for item in first['messages']]})
        self.assertEqual(len(self.request(self.bob, 4, {})['messages']), 12-len(first['messages']))

    def test_fallback_rotation_rejects_rollback_and_one_time_key_takes_priority(self):
        peer = self.bob['certificate']['body']
        def fallback(name):
            return {'fallback_keys': {'signed_curve25519:' + name: self.sign(self.bob,
                {'key': peer['curve25519'], 'fallback': True})}}
        self.request(self.bob, 0, fallback('Y'))
        first = self.claim()
        self.assertEqual(self.claim(), first, 'fallback is reusable')
        self.request(self.bob, 0, fallback('Z'))
        with self.assertRaisesRegex(ValueError, 'fallback_rollback'):
            self.request(self.bob, 0, fallback('Y'))
        self.upload(self.bob, count=1)
        claimed = self.claim()['one_time_keys'][sdk_user(peer)][peer['device']]
        self.assertNotIn('fallback', next(iter(claimed.values())))


if __name__ == '__main__':
    unittest.main()
