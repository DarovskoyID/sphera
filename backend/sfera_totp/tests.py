import time

from django.core.cache import cache
from django.test import TestCase
from rest_framework.test import APIClient

from sfera_auth.models import User

from . import guard, totp
from .models import BackupCode, TotpDevice, TotpSettings


def app_client(user=None):
    c = APIClient(HTTP_X_IONIK_CLIENT='1')
    if user:
        c.force_authenticate(user=user)
    return c


class CodeTests(TestCase):
    """The algorithm itself, against the vectors every authenticator agrees on."""

    def test_rfc6238_sha1_vectors(self):
        # RFC 6238 test secret "12345678901234567890" in base32.
        secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
        for at, expected in ((59, '287082'), (1111111109, '081804'), (1234567890, '005924')):
            self.assertEqual(totp.code_at(secret, totp.counter_now(at)), expected)

    def test_a_code_is_accepted_once_and_then_spent(self):
        secret = totp.new_secret()
        now = time.time()
        code = totp.code_at(secret, totp.counter_now(now))
        counter = totp.verify(secret, code, 0, at=now)
        self.assertIsNotNone(counter)
        # Same code again, with the counter remembered: refused.
        self.assertIsNone(totp.verify(secret, code, counter, at=now))

    def test_a_clock_off_by_half_a_minute_still_works(self):
        secret = totp.new_secret()
        now = time.time()
        self.assertIsNotNone(totp.verify(secret, totp.code_at(secret, totp.counter_now(now) + 1), 0, at=now))
        self.assertIsNotNone(totp.verify(secret, totp.code_at(secret, totp.counter_now(now) - 1), 0, at=now))
        # Two minutes out is not drift any more.
        self.assertIsNone(totp.verify(secret, totp.code_at(secret, totp.counter_now(now) + 4), 0, at=now))

    def test_garbage_is_not_a_code(self):
        secret = totp.new_secret()
        for value in ('', '12345', 'abcdef', '1234567', None):
            self.assertIsNone(totp.verify(secret, value))

    def test_backup_codes_are_unique_and_stored_hashed(self):
        codes = totp.new_backup_codes()
        self.assertEqual(len(set(codes)), totp.BACKUP_CODES)
        self.assertEqual(totp.hash_backup(codes[0]), totp.hash_backup(codes[0].lower().replace('-', '')))
        self.assertNotEqual(totp.hash_backup(codes[0]), totp.hash_backup(codes[1]))


class SetupTests(TestCase):
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        self.user = User.objects.create_user(username='alice', password='Old-Pass-12345')
        self.c = app_client(self.user)

    def enable(self, client=None, user=None):
        client = client or self.c
        setup = client.post('/api/totp/setup/').json()
        code = totp.code_at(setup['secret'], totp.counter_now())
        r = client.post('/api/totp/confirm/', {'code': code}, format='json')
        self.assertEqual(r.status_code, 201, r.content)
        return setup['secret'], r.json()['backup_codes']

    def test_setup_confirm_and_backup_codes(self):
        secret, codes = self.enable()
        self.assertEqual(len(codes), totp.BACKUP_CODES)
        self.assertEqual(BackupCode.objects.filter(user=self.user).count(), totp.BACKUP_CODES)
        status = self.c.get('/api/totp/status/').json()
        self.assertTrue(status['enabled'])
        self.assertEqual(status['backup_codes_left'], totp.BACKUP_CODES)
        self.assertTrue(TotpDevice.objects.get(user=self.user).confirmed)
        self.assertNotIn(secret, TotpDevice.objects.get(user=self.user).encrypted_content)

    def test_a_wrong_code_does_not_confirm(self):
        self.c.post('/api/totp/setup/')
        r = self.c.post('/api/totp/confirm/', {'code': '000000'}, format='json')
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()['error'], 'bad_code')
        self.assertFalse(self.c.get('/api/totp/status/').json()['enabled'])

    def test_guessing_the_code_runs_out_of_attempts(self):
        self.c.post('/api/totp/setup/')
        seen = {self.c.post('/api/totp/confirm/', {'code': '000000'}, format='json').status_code
                for _ in range(guard.MAX_ATTEMPTS + 2)}
        self.assertIn(429, seen)

    def test_disable_needs_a_current_code(self):
        secret, _ = self.enable()
        self.assertEqual(self.c.post('/api/totp/disable/', {'code': '000000'}, format='json').status_code, 400)
        code = totp.code_at(secret, totp.counter_now() + 1)
        r = self.c.post('/api/totp/disable/', {'code': code}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(TotpDevice.objects.filter(user=self.user).exists())
        self.assertFalse(BackupCode.objects.filter(user=self.user).exists())

    def test_a_confirmed_authenticator_is_not_silently_replaced(self):
        self.enable()
        self.assertEqual(self.c.post('/api/totp/setup/').status_code, 409)


class LoginTests(TestCase):
    """The password alone must stop opening the account."""

    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        self.user = User.objects.create_user(username='alice', password='Old-Pass-12345')
        self.c = app_client(self.user)
        setup = self.c.post('/api/totp/setup/').json()
        self.secret = setup['secret']
        self.codes = self.c.post(
            '/api/totp/confirm/', {'code': totp.code_at(self.secret, totp.counter_now())}, format='json',
        ).json()['backup_codes']
        self.anon = app_client()

    def login(self):
        return self.anon.post('/api/auth/login/', {'username': 'alice', 'password': 'Old-Pass-12345'}, format='json')

    def test_password_alone_yields_no_token(self):
        r = self.login()
        self.assertEqual(r.status_code, 409)
        body = r.json()
        self.assertEqual(body['error'], 'second_factor_required')
        self.assertNotIn('access', body)
        self.assertTrue(body['challenge'])

    def test_the_code_finishes_the_sign_in(self):
        challenge = self.login().json()['challenge']
        code = totp.code_at(self.secret, totp.counter_now() + 1)
        r = self.anon.post('/api/auth/login/2fa/', {'challenge': challenge, 'code': code}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn('access', r.json())

    def test_a_backup_code_works_once(self):
        challenge = self.login().json()['challenge']
        code = self.codes[0]
        self.assertEqual(
            self.anon.post('/api/auth/login/2fa/', {'challenge': challenge, 'code': code}, format='json').status_code,
            200,
        )
        challenge = self.login().json()['challenge']
        self.assertEqual(
            self.anon.post('/api/auth/login/2fa/', {'challenge': challenge, 'code': code}, format='json').status_code,
            401,
        )

    def test_a_made_up_challenge_is_worthless(self):
        code = totp.code_at(self.secret, totp.counter_now() + 1)
        for challenge in ('', 'nonsense', f'{self.user.id}:1:forged'):
            r = self.anon.post('/api/auth/login/2fa/', {'challenge': challenge, 'code': code}, format='json')
            self.assertIn(r.status_code, (400, 401))

    def test_a_wrong_code_is_refused(self):
        challenge = self.login().json()['challenge']
        r = self.anon.post('/api/auth/login/2fa/', {'challenge': challenge, 'code': '000000'}, format='json')
        self.assertEqual(r.status_code, 401)

    def test_guessing_runs_out_of_attempts_even_with_the_right_code(self):
        # Through the guard rather than HTTP: the endpoint's own IP throttle
        # would answer first and hide what is being tested here.
        challenge = guard.issue_challenge(self.user.id)
        for _ in range(guard.MAX_ATTEMPTS):
            self.assertIsNone(guard.second_factor(challenge, '000000'))
        code = totp.code_at(self.secret, totp.counter_now() + 1)
        self.assertIsNone(guard.second_factor(challenge, code))
        # A pause (here: clearing the window) puts the account back in business.
        cache.delete(f'totp:attempts:{self.user.id}')
        self.assertIsNotNone(guard.second_factor(challenge, code))


class RequirementTests(TestCase):
    """What the superuser's switch does to accounts without an authenticator."""

    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        self.root = User.objects.create_superuser(username='root', email='r@x.ru', password='Root-Pass-12345')
        self.user = User.objects.create_user(username='alice', password='Old-Pass-12345')
        self.c = app_client(self.user)
        self.admin = app_client(self.root)

    def require(self, on=True):
        r = self.admin.put('/api/totp/settings/', {'required_for_all': on}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        cache.clear()

    def test_only_the_superuser_flips_the_switch(self):
        self.assertEqual(self.c.get('/api/totp/settings/').status_code, 403)
        self.assertEqual(self.c.put('/api/totp/settings/', {'required_for_all': True}, format='json').status_code, 403)
        self.assertFalse(TotpSettings.load().required_for_all)
        self.require()
        self.assertTrue(TotpSettings.load().required_for_all)

    def test_an_account_without_totp_is_blocked_everywhere(self):
        self.require()
        block = guard.access_guard(self.user.id)
        self.assertEqual(block['error'], 'totp_required')
        # Set-up stays reachable — that is the only way out of the block.
        self.assertTrue(any('/api/totp/'.startswith(p) or p == '/api/totp/' for p in block['allow']))

    def test_the_block_lifts_as_soon_as_the_authenticator_is_confirmed(self):
        self.require()
        self.assertIsNotNone(guard.access_guard(self.user.id))
        setup = self.c.post('/api/totp/setup/').json()
        # A started but unconfirmed set-up is not an authenticator.
        cache.clear()
        self.assertIsNotNone(guard.access_guard(self.user.id))
        self.c.post('/api/totp/confirm/', {'code': totp.code_at(setup['secret'], totp.counter_now())}, format='json')
        self.assertIsNone(guard.access_guard(self.user.id))

    def test_the_requirement_covers_the_superuser_too(self):
        self.require()
        self.assertIsNotNone(guard.access_guard(self.root.id))

    def test_nobody_is_blocked_while_the_switch_is_off(self):
        self.assertIsNone(guard.access_guard(self.user.id))
        self.require()
        self.assertIsNotNone(guard.access_guard(self.user.id))
        self.require(False)
        self.assertIsNone(guard.access_guard(self.user.id))

    def test_the_admin_can_clear_a_lost_authenticator(self):
        setup = self.c.post('/api/totp/setup/').json()
        self.c.post('/api/totp/confirm/', {'code': totp.code_at(setup['secret'], totp.counter_now())}, format='json')
        people = self.admin.get('/api/totp/people/').json()
        self.assertTrue(next(p for p in people if p['username'] == 'alice')['totp'])
        self.assertEqual(self.c.post(f'/api/totp/people/{self.user.id}/reset/').status_code, 403)
        self.assertEqual(self.admin.post(f'/api/totp/people/{self.user.id}/reset/').status_code, 200)
        self.assertFalse(TotpDevice.objects.filter(user=self.user).exists())


class GateTests(TestCase):
    """The block is the server's, not the interface's."""

    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        self.root = User.objects.create_superuser(username='root', email='r@x.ru', password='Root-Pass-12345')
        self.user = User.objects.create_user(username='alice', password='Old-Pass-12345')
        app_client(self.root).put('/api/totp/settings/', {'required_for_all': True}, format='json')
        cache.clear()
        self.token = str(__import__('rest_framework_simplejwt.tokens', fromlist=['AccessToken'])
                         .AccessToken.for_user(self.user))
        self.c = APIClient(HTTP_X_IONIK_CLIENT='1', HTTP_AUTHORIZATION=f'Bearer {self.token}')

    def test_direct_requests_with_a_valid_token_are_refused(self):
        # A token issued before the switch; the browser is not involved at all.
        for path in ('/api/auth/friends/', '/api/auth/users/', '/api/auth/settings/'):
            r = self.c.get(path)
            self.assertEqual(r.status_code, 403, f'{path} → {r.status_code}')
            self.assertEqual(r.json()['error'], 'totp_required')
        self.assertEqual(self.c.post('/api/auth/me/update/', {'nickname': 'x'}, format='json').status_code, 403)

    def test_what_stays_open_is_only_the_way_out_of_the_block(self):
        self.assertEqual(self.c.get('/api/totp/status/').status_code, 200)
        self.assertEqual(self.c.post('/api/totp/setup/').status_code, 200)
        self.assertEqual(self.c.get('/api/auth/me/').status_code, 200)

    def test_the_gate_opens_right_after_the_set_up(self):
        secret = self.c.post('/api/totp/setup/').json()['secret']
        self.c.post('/api/totp/confirm/', {'code': totp.code_at(secret, totp.counter_now())}, format='json')
        self.assertEqual(self.c.get('/api/auth/friends/').status_code, 200)

    def test_a_blocked_account_gets_no_websocket(self):
        from asgiref.sync import async_to_sync
        from sfera_server.middleware import get_user_from_token

        user = async_to_sync(get_user_from_token)(self.token)
        self.assertTrue(user.is_anonymous)
