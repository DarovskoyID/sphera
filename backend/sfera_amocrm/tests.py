from unittest import mock

from django.test import TestCase
from rest_framework.test import APIClient

from sfera_auth.models import User

from . import client as amo
from .models import Connection, Event


def app_client(user=None):
    c = APIClient(HTTP_X_IONIK_CLIENT='1')
    if user:
        c.force_authenticate(user=user)
    return c


class FakeAmo:
    """Records calls to the amoCRM API and answers like it."""

    def __init__(self):
        self.calls = []

    def __call__(self, method, url, token=None, body=None, timeout=None):
        self.calls.append((method, url, token, body))
        if url.endswith('/api/v4/account'):
            return {'name': 'ООО Ромашка'}
        if url.endswith('/api/v4/leads/complex'):
            return [{'id': 101, 'contact_id': 55}]
        if '/api/v4/leads?' in url:
            return {'_embedded': {'leads': [{'id': 101, 'name': 'Окна', 'price': 5000}]}}
        if '/api/v4/contacts?' in url:
            return {'_embedded': {'contacts': [{'id': 55, 'name': 'Иван', 'custom_fields_values': [{'field_code': 'PHONE', 'values': [{'value': '+7900'}]}]}]}}
        return {}


class AmoCrmTests(TestCase):
    def setUp(self):
        User.objects.create_superuser(username='root', email='r@x.ru', password='x')
        self.root = User.objects.get(username='root')
        self.user = User.objects.create_user(username='manager', password='x')
        self.fake = FakeAmo()
        patcher = mock.patch.object(amo, '_request', self.fake)
        patcher.start()
        self.addCleanup(patcher.stop)

    def configure(self):
        r = app_client(self.root).put('/api/amocrm/settings/', {'domain': 'romashka', 'access_token': 'long-lived'}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_only_superuser_configures_and_token_is_never_returned(self):
        self.assertEqual(app_client(self.user).get('/api/amocrm/settings/').status_code, 403)
        data = self.configure()
        self.assertEqual(data['domain'], 'romashka.amocrm.ru')
        self.assertEqual(data['account_name'], 'ООО Ромашка')
        self.assertNotIn('long-lived', str(data))
        self.assertEqual(Connection.load().access_token, 'long-lived')
        self.assertEqual(app_client(self.root).put('/api/amocrm/settings/', {'domain': 'evil.example.com'}, format='json').status_code, 400)

    def test_create_lead_with_contact_and_note(self):
        self.configure()
        r = app_client(self.user).post('/api/amocrm/leads/', {
            'name': 'Окна в офис', 'price': '12000', 'contact_name': 'Иван', 'phone': '+7 900', 'note': 'Из чата',
        }, format='json')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()['url'], 'https://romashka.amocrm.ru/leads/detail/101')
        complex_call = next(c for c in self.fake.calls if c[1].endswith('/leads/complex'))
        lead = complex_call[3][0]
        self.assertEqual(lead['price'], 12000)
        self.assertEqual(lead['_embedded']['contacts'][0]['custom_fields_values'][0]['field_code'], 'PHONE')
        self.assertTrue(any(c[1].endswith('/leads/101/notes') for c in self.fake.calls))
        self.assertEqual(complex_call[2], 'long-lived')
        self.assertTrue(Event.objects.filter(direction='out', entity_id='101').exists())

    def test_allowed_users_limit_actions(self):
        self.configure()
        other = User.objects.create_user(username='other', password='x')
        app_client(self.root).put('/api/amocrm/settings/', {'allowed_user_ids': [str(self.user.id)]}, format='json')
        self.assertEqual(app_client(other).post('/api/amocrm/leads/', {'name': 'x'}, format='json').status_code, 403)
        self.assertEqual(app_client(self.user).get('/api/amocrm/search/?q=Окна').json()['leads'][0]['id'], 101)

    def test_webhook_requires_secret_and_notifies(self):
        data = self.configure()
        app_client(self.root).put('/api/amocrm/settings/', {'notify_user_ids': [str(self.user.id)]}, format='json')
        anon = APIClient()
        self.assertEqual(anon.post('/api/amocrm/webhook/wrong/', {'leads[add][0][id]': '7'}).status_code, 404)
        with mock.patch('sfera_amocrm.views.push_to_user') as push:
            r = anon.post(data['webhook_path'], {'leads[status][0][id]': '7', 'leads[status][0][name]': 'Окна', 'account[subdomain]': 'romashka'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['received'], 1)
        push.assert_called_once()
        self.assertIn('Окна', push.call_args[0][2]['summary'])

    def test_parse_webhook(self):
        from django.http import QueryDict
        q = QueryDict('leads[add][0][id]=1&leads[add][0][name]=A&contacts[update][0][id]=2')
        items = sorted(amo.parse_webhook(q), key=lambda x: x['entity'])
        self.assertEqual(items, [{'entity': 'contacts', 'action': 'update', 'id': '2'}, {'entity': 'leads', 'action': 'add', 'id': '1', 'name': 'A'}])
