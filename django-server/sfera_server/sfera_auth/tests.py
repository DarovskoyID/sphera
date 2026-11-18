from django.core import mail
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.test import TestCase
from rest_framework.test import APIClient

from .models import PasswordResetCode, User


def app_client():
    return APIClient(HTTP_X_IONIK_CLIENT='1')


class PasswordResetTests(TestCase):
    """Forgotten password: a code to the mailbox, then a new password."""

    def setUp(self):
        # The 'auth' throttle is IP-keyed and its bucket outlives a test: clear it
        # so neither these tests nor the ones after them hit a stale 429.
        cache.clear()
        self.addCleanup(cache.clear)
        self.user = User.objects.create_user(username='alice', email='alice@x.ru', password='Old-Pass-12345')
        self.c = app_client()

    def ask(self, email='alice@x.ru'):
        return self.c.post('/api/auth/password-reset/send-code/', {'email': email}, format='json')

    def code(self):
        return PasswordResetCode.objects.get(user=self.user).code

    def test_code_arrives_and_sets_a_new_password(self):
        self.assertEqual(self.ask().status_code, 200)
        self.assertEqual(len(mail.outbox), 1)
        code = self.code()
        self.assertIn(code, mail.outbox[0].body)
        r = self.c.post('/api/auth/password-reset/',
                        {'email': 'ALICE@x.ru', 'code': code, 'password': 'Brand-New-Pass-99'}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password('Brand-New-Pass-99'))
        # The code is single-use and the old password is gone.
        self.assertFalse(PasswordResetCode.objects.exists())
        self.assertFalse(self.user.check_password('Old-Pass-12345'))
        self.assertEqual(
            self.c.post('/api/auth/login/', {'username': 'alice', 'password': 'Brand-New-Pass-99'}, format='json').status_code,
            200,
        )

    def test_an_unknown_address_looks_exactly_the_same(self):
        r = self.ask('nobody@x.ru')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), self.ask().json())
        self.assertEqual(len(mail.outbox), 1)  # only the real account got mail

    def test_a_wrong_code_is_counted_and_runs_out(self):
        self.ask()
        for _ in range(5):
            r = self.c.post('/api/auth/password-reset/',
                            {'email': 'alice@x.ru', 'code': 'ZZZZZZ', 'password': 'Brand-New-Pass-99'}, format='json')
            self.assertEqual(r.status_code, 400)
        r = self.c.post('/api/auth/password-reset/',
                        {'email': 'alice@x.ru', 'code': self.code() if PasswordResetCode.objects.exists() else 'ZZZZZZ',
                         'password': 'Brand-New-Pass-99'}, format='json')
        self.assertEqual(r.status_code, 429)
        self.assertFalse(PasswordResetCode.objects.exists())
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password('Old-Pass-12345'))

    def test_an_expired_code_does_not_work(self):
        from datetime import timedelta

        from django.utils import timezone

        self.ask()
        code = self.code()
        PasswordResetCode.objects.update(expires_at=timezone.now() - timedelta(minutes=1))
        r = self.c.post('/api/auth/password-reset/',
                        {'email': 'alice@x.ru', 'code': code, 'password': 'Brand-New-Pass-99'}, format='json')
        self.assertEqual(r.status_code, 400)
        self.assertFalse(PasswordResetCode.objects.exists())

    def test_a_weak_password_is_refused_and_the_code_survives(self):
        self.ask()
        r = self.c.post('/api/auth/password-reset/',
                        {'email': 'alice@x.ru', 'code': self.code(), 'password': '12345'}, format='json')
        self.assertEqual(r.status_code, 400)
        self.assertTrue(PasswordResetCode.objects.exists())
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password('Old-Pass-12345'))

    def test_asking_again_at_once_is_throttled_but_later_replaces_the_code(self):
        self.ask()
        first = self.code()
        self.assertEqual(self.ask().status_code, 429)
        from datetime import timedelta

        from django.utils import timezone

        PasswordResetCode.objects.update(updated_at=timezone.now() - timedelta(minutes=5))
        self.assertEqual(self.ask().status_code, 200)
        self.assertNotEqual(self.code(), first)
        self.assertEqual(len(mail.outbox), 2)


class OneAccountPerEmailTests(TestCase):
    """An address identifies an account: recovery codes are sent to it."""

    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        self.alice = User.objects.create_user(username='alice', email='alice@x.ru', password='Old-Pass-12345')

    def test_the_database_refuses_a_second_account_with_the_same_address(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            User.objects.create_user(username='mallory', email='alice@x.ru', password='Old-Pass-12345')

    def test_capitalisation_is_not_a_different_address(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            User.objects.create_user(username='mallory', email='Alice@X.RU', password='Old-Pass-12345')

    def test_accounts_without_an_address_do_not_collide(self):
        User.objects.create_user(username='bob', password='Old-Pass-12345')
        User.objects.create_user(username='carol', password='Old-Pass-12345')
        self.assertEqual(User.objects.filter(email='').count(), 2)

    def test_a_profile_cannot_take_over_someone_elses_address(self):
        bob = User.objects.create_user(username='bob', email='bob@x.ru', password='Old-Pass-12345')
        c = app_client()
        c.force_authenticate(user=bob)

        r = c.patch('/api/auth/me/update/', {'email': 'ALICE@x.ru'}, format='json')

        self.assertEqual(r.status_code, 400, r.content)
        bob.refresh_from_db()
        self.assertEqual(bob.email, 'bob@x.ru')
        # Its own address, re-saved, is not a collision with itself.
        self.assertEqual(c.patch('/api/auth/me/update/', {'email': 'bob@x.ru'}, format='json').status_code, 200)

    def test_sign_up_refuses_an_address_that_is_taken(self):
        from .models import EmailVerificationCode
        from django.utils import timezone
        from datetime import timedelta

        EmailVerificationCode.objects.create(
            email='alice@x.ru', code='ABC123', expires_at=timezone.now() + timedelta(minutes=10))
        r = app_client().post('/api/auth/register/', {
            'username': 'mallory', 'email': 'alice@x.ru', 'code': 'ABC123', 'password': 'Brand-New-Pass-99',
        }, format='json')
        self.assertEqual(r.status_code, 400)
        self.assertFalse(User.objects.filter(username='mallory').exists())

    def test_recovery_still_points_at_exactly_one_account(self):
        self.assertEqual(
            app_client().post('/api/auth/password-reset/send-code/', {'email': 'ALICE@x.ru'}, format='json').status_code,
            200,
        )
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, ['alice@x.ru'])
