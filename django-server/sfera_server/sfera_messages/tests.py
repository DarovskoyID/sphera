from django.test import TransactionTestCase
from rest_framework.test import APIClient

from sfera_auth.models import User

from .models import Guild
from .views import MAX_PRIVATE_NOTES


def app_client(user):
    client = APIClient(HTTP_X_IONIK_CLIENT='1')
    client.force_authenticate(user=user)
    return client


class PrivateDiaryLimitTests(TransactionTestCase):
    """A user may keep several diaries, but not without end.

    TransactionTestCase rather than TestCase: the guild views are dispatched
    through `sync_to_async(..., thread_sensitive=False)`, so they write from a
    different thread and a wrapping test transaction deadlocks SQLite.
    """

    def setUp(self):
        self.user = User.objects.create_user(username='alice', password='x')
        self.client = app_client(self.user)

    def _create(self, name):
        return self.client.post('/api/guilds/', {'name': name, 'is_private': True}, format='json')

    def test_up_to_the_cap_is_allowed_and_the_next_one_is_refused(self):
        for i in range(MAX_PRIVATE_NOTES):
            self.assertEqual(self._create(f'Дневник {i}').status_code, 201)

        refused = self._create('Лишний')
        self.assertEqual(refused.status_code, 409)
        self.assertEqual(refused.json()['error'], 'limit reached')
        self.assertEqual(
            Guild.objects.filter(owner=self.user, is_private=True).count(),
            MAX_PRIVATE_NOTES,
        )

    def test_deleting_one_frees_a_slot(self):
        ids = [self._create(f'Дневник {i}').json()['id'] for i in range(MAX_PRIVATE_NOTES)]
        self.assertEqual(self._create('Лишний').status_code, 409)

        # Deleting a guild is password-confirmed.
        removed = self.client.delete(
            f'/api/guilds/{ids[0]}/', {'password': 'x'}, format='json',
        )
        self.assertEqual(removed.status_code, 204)
        self.assertEqual(self._create('Взамен удалённого').status_code, 201)

    def test_the_cap_is_counted_per_user(self):
        for i in range(MAX_PRIVATE_NOTES):
            self._create(f'Дневник {i}')
        bob = User.objects.create_user(username='bob', password='x')
        res = app_client(bob).post(
            '/api/guilds/', {'name': 'Свой дневник', 'is_private': True}, format='json',
        )
        self.assertEqual(res.status_code, 201)

    def test_diaries_do_not_eat_into_the_personal_channel_or_server_budget(self):
        for i in range(MAX_PRIVATE_NOTES):
            self._create(f'Дневник {i}')
        # A plain server and a personal channel are separate allowances.
        self.assertEqual(
            self.client.post('/api/guilds/', {'name': 'Клуб'}, format='json').status_code, 201,
        )
        self.assertEqual(
            self.client.post(
                '/api/guilds/', {'name': 'Канал', 'is_personal_channel': True}, format='json',
            ).status_code, 201,
        )
