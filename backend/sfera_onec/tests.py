import urllib.parse
from unittest import mock

from django.test import TestCase
from rest_framework.test import APIClient

from sfera_auth.models import User

from . import client as onec
from .models import Connection, Event

KEY = '5f7c2e1a-1111-2222-3333-444455556666'


def app_client(user=None):
    c = APIClient(HTTP_X_IONIK_CLIENT='1')
    if user:
        c.force_authenticate(user=user)
    return c


class Fake1C:
    def __init__(self):
        self.calls = []

    def __call__(self, method, url, username='', password='', body=None, timeout=None):
        path = urllib.parse.unquote(urllib.parse.urlsplit(url).path)
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        self.calls.append((method, path, query, username, password, body))
        if path.endswith('standard.odata/'):
            return {'value': [{'name': 'Catalog_Контрагенты'}, {'name': 'Document_ЗаказКлиента'}]}
        if method == 'POST':
            return {'Ref_Key': KEY, 'Description': body['Description'], 'Code': '000123'}
        if 'Document_ЗаказКлиента' in path:
            return {'value': [{'Ref_Key': KEY, 'Number': 'ЗК-1', 'Date': '2026-09-01T10:00:00', 'СуммаДокумента': 1500, 'Posted': True}]}
        if f"(guid'{KEY}')" in path:
            return {'Ref_Key': KEY, 'Description': 'Ромашка', 'ИНН': '7701234567', 'Parent_Key': onec.EMPTY_GUID, 'odata.metadata': 'x'}
        return {'value': [{'Ref_Key': KEY, 'Description': 'ООО Ромашка', 'Code': '000123'}]}


class OneCTests(TestCase):
    def setUp(self):
        self.root = User.objects.create_superuser(username='root', email='r@x.ru', password='x')
        self.user = User.objects.create_user(username='buh', email='buh@x.ru', password='x')
        self.fake = Fake1C()
        patcher = mock.patch.object(onec, '_request', self.fake)
        patcher.start()
        self.addCleanup(patcher.stop)

    def configure(self):
        r = app_client(self.root).put('/api/onec/settings/', {
            'base_url': 'https://1c.example.ru/trade', 'username': 'odata', 'password': 's3cret',
        }, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_settings_normalize_url_and_hide_password(self):
        data = self.configure()
        self.assertEqual(data['base_url'], 'https://1c.example.ru/trade/odata/standard.odata/')
        self.assertEqual(data['entity_sets'], ['Catalog_Контрагенты', 'Document_ЗаказКлиента'])
        self.assertNotIn('s3cret', str(data))
        self.assertEqual(self.fake.calls[0][3:5], ('odata', 's3cret'))
        bad = app_client(self.root).put('/api/onec/settings/', {'counterparty_entity': "Catalog_X'); drop"}, format='json')
        self.assertEqual(bad.status_code, 400)

    def test_search_escapes_query_and_hides_deleted(self):
        self.configure()
        r = app_client(self.user).get('/api/onec/search/', {'q': "O'Neil"})
        self.assertEqual(r.json()[0]['title'], 'ООО Ромашка')
        flt = self.fake.calls[-1][2]['$filter'][0]
        self.assertIn("substringof('O''Neil', Description)", flt)
        self.assertIn('DeletionMark eq false', flt)

    def test_record_with_documents_and_create(self):
        self.configure()
        c = app_client(self.user)
        r = c.get(f'/api/onec/records/Catalog_Контрагенты/{KEY}/').json()
        self.assertEqual(r['brief']['title'], 'Ромашка')
        self.assertEqual([f['name'] for f in r['fields']], ['Ref_Key', 'Description', 'ИНН'])
        self.assertEqual(r['documents'][0]['subtitle'], '№ ЗК-1 · 2026-09-01 · 1500 · проведён')
        self.assertEqual(c.get('/api/onec/records/Catalog_Контрагенты/not-a-guid/').status_code, 400)
        created = c.post('/api/onec/counterparties/', {'name': 'ИП Иванов', 'inn': '77-01 234567'}, format='json')
        self.assertEqual(created.status_code, 201)
        self.assertEqual(self.fake.calls[-1][5]['ИНН'], '7701234567')

    def test_inbound_notification_to_named_users(self):
        data = self.configure()
        anon = APIClient()
        self.assertEqual(anon.post('/api/onec/webhook/wrong/', {'text': 'x'}, format='json').status_code, 404)
        with mock.patch('sfera_onec.views.push_to_user') as push:
            r = anon.post(data['inbound_path'], {'title': 'Оплата', 'text': 'Счёт №5 оплачен', 'to': ['buh@x.ru', 'nobody']}, format='json')
        self.assertEqual(r.json(), {'ok': True, 'delivered': 1})
        self.assertEqual(push.call_args[0][0], self.user.id)
        self.assertTrue(Event.objects.filter(direction='in').exists())
        self.assertTrue(Connection.load().configured)
