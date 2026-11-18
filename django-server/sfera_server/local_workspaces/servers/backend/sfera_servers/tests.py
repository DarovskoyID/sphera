from django.test import TransactionTestCase
from rest_framework.test import APIClient

from sfera_auth.models import User


def app_client(user):
    client = APIClient(HTTP_X_IONIK_CLIENT='1')
    client.force_authenticate(user=user)
    return client


class GuildCreateTests(TransactionTestCase):
    """TransactionTestCase: the guild views run via sync_to_async(thread_sensitive=False)
    and write from another thread, so a wrapping test transaction deadlocks SQLite."""

    def setUp(self):
        self.user = User.objects.create_user(username='alice', password='x')
        self.client = app_client(self.user)

    def test_diaries_are_no_longer_created_as_guilds(self):
        res = self.client.post('/api/guilds/', {'name': 'Дневник', 'is_private': True}, format='json')
        self.assertEqual(res.status_code, 410)

    def test_personal_channels_are_no_longer_created_as_guilds(self):
        res = self.client.post('/api/guilds/', {'name': 'Канал', 'is_personal_channel': True}, format='json')
        self.assertEqual(res.status_code, 410)

    def test_server_create(self):
        self.assertEqual(self.client.post('/api/guilds/', {'name': 'Клуб'}, format='json').status_code, 201)
