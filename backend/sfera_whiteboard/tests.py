from django.test import TestCase
from rest_framework.test import APIClient

from sfera_auth.models import User

from .models import Board
from .ops import OpError, apply_ops


def app_client(user):
    client = APIClient(HTTP_X_IONIK_CLIENT='1')
    client.force_authenticate(user=user)
    return client


def rect(sid, **kw):
    return {'id': sid, 'type': 'rect', 'x': 0, 'y': 0, 'w': 100, 'h': 60, **kw}


class OpsTests(TestCase):
    def test_put_del_order(self):
        doc = apply_ops({'shapes': {}, 'order': []}, [
            {'op': 'put', 'shape': rect('a')}, {'op': 'put', 'shape': rect('b')}, {'op': 'put', 'shape': rect('c')},
        ])
        self.assertEqual(doc['order'], ['a', 'b', 'c'])
        doc = apply_ops(doc, [{'op': 'order', 'order': ['c', 'a', 'zzz']}, {'op': 'del', 'id': 'b'}])
        self.assertEqual(doc['order'], ['c', 'a'])
        self.assertEqual(set(doc['shapes']), {'a', 'c'})
        # Replacing keeps the z-position.
        doc = apply_ops(doc, [{'op': 'put', 'shape': rect('c', x=5)}])
        self.assertEqual(doc['order'], ['c', 'a'])
        self.assertEqual(doc['shapes']['c']['x'], 5)

    def test_rejects_garbage(self):
        for ops in ([], [{'op': 'put', 'shape': {'id': 'x', 'type': 'script'}}], [{'op': 'put', 'shape': rect('../x')}], [{'op': 'boom'}]):
            with self.assertRaises(OpError):
                apply_ops({'shapes': {}, 'order': []}, ops)


class BoardApiTests(TestCase):
    def setUp(self):
        self.alice = User.objects.create_user(username='alice', password='x')
        self.bob = User.objects.create_user(username='bob', password='x')
        self.a = app_client(self.alice)
        self.b = app_client(self.bob)
        self.board = self.a.post('/api/whiteboard/boards/', {'name': 'Архитектура'}, format='json').json()
        self.url = f"/api/whiteboard/boards/{self.board['id']}/"

    def test_ops_versioning_and_access(self):
        r = self.a.post(self.url + 'ops/', {'ops': [{'op': 'put', 'shape': rect('a')}]}, format='json')
        self.assertEqual(r.json()['version'], 1)
        self.assertEqual(self.b.get(self.url).status_code, 404)
        self.a.post(self.url + 'members/', {'user_id': str(self.bob.id), 'role': 'viewer'}, format='json')
        self.assertEqual(self.b.get(self.url).json()['doc']['order'], ['a'])
        self.assertEqual(self.b.post(self.url + 'ops/', {'ops': [{'op': 'del', 'id': 'a'}]}, format='json').status_code, 403)
        self.assertEqual(self.b.delete(self.url).status_code, 403)
        self.assertEqual(self.a.post(self.url + 'ops/', {'ops': 'nope'}, format='json').status_code, 400)

    def test_import_doc_is_validated(self):
        ok = self.a.post('/api/whiteboard/boards/', {'name': 'copy', 'doc': {'shapes': {'a': rect('a')}, 'order': ['a']}}, format='json')
        self.assertEqual(ok.status_code, 201)
        self.assertEqual(ok.json()['doc']['order'], ['a'])
        bad = self.a.post('/api/whiteboard/boards/', {'name': 'bad', 'doc': {'shapes': {'a': {'id': 'a', 'type': 'evil'}}}}, format='json')
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(Board.objects.count(), 2)
