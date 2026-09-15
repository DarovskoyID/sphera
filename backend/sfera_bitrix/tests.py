from unittest import mock

from django.test import TestCase
from rest_framework.test import APIClient

from sfera_auth.models import User

from . import client as bx
from .models import Connection, Event

HOOK = 'https://romashka.bitrix24.ru/rest/1/abc123secret/'


def app_client(user=None):
    c = APIClient(HTTP_X_IONIK_CLIENT='1')
    if user:
        c.force_authenticate(user=user)
    return c


class FakeBitrix:
    def __init__(self):
        self.calls = []

    def __call__(self, url, body, timeout=None):
        method = url.rsplit('/', 1)[-1].removesuffix('.json')
        self.calls.append((method, url, body))
        results = {
            'scope': ['crm', 'task', 'user'],
            'crm.lead.add': 17,
            'crm.deal.add': 21,
            'tasks.task.add': {'task': {'id': 99}},
            'crm.lead.list': [{'ID': '17', 'TITLE': 'Окна', 'OPPORTUNITY': '5000', 'CURRENCY_ID': 'RUB'}],
            'crm.deal.list': [],
            'crm.contact.list': [{'ID': '3', 'NAME': 'Иван', 'LAST_NAME': 'Петров', 'PHONE': [{'VALUE': '+7900'}]}],
            'crm.timeline.comment.add': 5,
        }
        return {'result': results.get(method)}


class BitrixTests(TestCase):
    def setUp(self):
        self.root = User.objects.create_superuser(username='root', email='r@x.ru', password='x')
        self.user = User.objects.create_user(username='manager', password='x')
        self.fake = FakeBitrix()
        patcher = mock.patch.object(bx, '_post', self.fake)
        patcher.start()
        self.addCleanup(patcher.stop)

    def configure(self, **extra):
        r = app_client(self.root).put('/api/bitrix/settings/', {'webhook_url': HOOK, **extra}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_webhook_url_is_validated_and_kept_secret(self):
        self.assertEqual(app_client(self.root).put('/api/bitrix/settings/', {'webhook_url': 'http://evil/rest/1/x/'}, format='json').status_code, 400)
        data = self.configure()
        self.assertEqual(data['portal'], 'romashka.bitrix24.ru')
        self.assertEqual(data['scopes'], ['crm', 'task', 'user'])
        self.assertNotIn('abc123secret', str(data))
        self.assertEqual(app_client(self.user).get('/api/bitrix/settings/').status_code, 403)

    def test_create_lead_deal_task_and_comment(self):
        self.configure(default_responsible_id=7)
        c = app_client(self.user)
        r = c.post('/api/bitrix/create/lead/', {'title': 'Окна', 'name': 'Иван', 'phone': '+7900', 'comment': 'Из чата', 'amount': '5000'}, format='json')
        self.assertEqual(r.json(), {'id': 17, 'url': 'https://romashka.bitrix24.ru/crm/lead/details/17/'})
        lead = next(b for m, _, b in self.fake.calls if m == 'crm.lead.add')['fields']
        self.assertEqual((lead['ASSIGNED_BY_ID'], lead['PHONE'][0]['VALUE'], lead['OPPORTUNITY']), (7, '+7900', 5000.0))
        self.assertIn('manager, Сфера', lead['COMMENTS'])
        self.assertEqual(c.post('/api/bitrix/create/deal/', {'title': 'Сделка'}, format='json').json()['id'], 21)
        self.assertEqual(c.post('/api/bitrix/create/task/', {'title': 'Позвонить'}, format='json').json()['id'], 99)
        self.assertEqual(c.post('/api/bitrix/create/evil/', {'title': 'x'}, format='json').status_code, 404)
        self.assertEqual(c.post('/api/bitrix/comment/lead/17/', {'text': 'Перезвонить'}, format='json').status_code, 201)
        self.assertEqual(Event.objects.filter(direction='out').count(), 4)

    def test_search(self):
        self.configure()
        r = app_client(self.user).get('/api/bitrix/search/?q=Окна').json()
        self.assertEqual(r['leads'][0]['amount'], '5,000 RUB')
        self.assertEqual(r['contacts'][0]['title'], 'Иван Петров')

    def test_inbound_events_check_secret_and_token(self):
        data = self.configure(application_token='app-token', notify_user_ids=[str(self.user.id)])
        anon = APIClient()
        body = {'event': 'ONCRMDEALADD', 'data[FIELDS][ID]': '21', 'auth[application_token]': 'app-token', 'auth[domain]': 'romashka.bitrix24.ru'}
        self.assertEqual(anon.post('/api/bitrix/webhook/nope/', body).status_code, 404)
        self.assertEqual(anon.post(data['inbound_path'], {**body, 'auth[application_token]': 'forged'}).status_code, 403)
        with mock.patch('sfera_bitrix.views.push_to_user') as push:
            self.assertEqual(anon.post(data['inbound_path'], body).status_code, 200)
        payload = push.call_args[0][2]
        self.assertEqual(payload['summary'], 'Новая сделка #21')
        self.assertEqual(payload['url'], 'https://romashka.bitrix24.ru/crm/deal/details/21/')
        self.assertTrue(Connection.load().configured)
