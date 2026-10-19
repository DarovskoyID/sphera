from django.test import TestCase
from rest_framework.test import APIClient

from sfera_auth.models import User

from . import formulas
from .models import Doc, DocComment, DocMember, DocRevision
from .ops import OpError, apply_ops


def app_client(user=None):
    c = APIClient(HTTP_X_IONIK_CLIENT='1')
    if user:
        c.force_authenticate(user=user)
    return c


class FormulaTests(TestCase):
    def calc(self, cells, ref='A1'):
        return formulas.evaluate({k: {'v': v} for k, v in cells.items()}, ref)

    def test_arithmetic_and_precedence(self):
        self.assertEqual(self.calc({'A1': '=2+3*4'}), 14)
        self.assertEqual(self.calc({'A1': '=(2+3)*4'}), 20)
        self.assertEqual(self.calc({'A1': '=2^3^2'}), 512)
        self.assertEqual(self.calc({'A1': '=-3+1'}), -2)
        self.assertEqual(self.calc({'A1': '=50%'}), 0.5)

    def test_refs_and_ranges(self):
        cells = {'A1': '=SUM(B1:B3)', 'B1': '1', 'B2': '2', 'B3': '4'}
        self.assertEqual(self.calc(cells), 7)
        self.assertEqual(self.calc({**cells, 'A1': '=AVERAGE(B1:B3)'}), 7 / 3)
        self.assertEqual(self.calc({**cells, 'A1': '=MAX(B1:B3)+MIN(B1:B3)'}), 5)
        self.assertEqual(self.calc({**cells, 'A1': '=COUNT(B1:B9)'}), 3)

    def test_text_and_conditions(self):
        self.assertEqual(self.calc({'A1': '=IF(B1>10,"много","мало")', 'B1': '11'}), 'много')
        self.assertEqual(self.calc({'A1': '=CONCAT("нет",": ",B1)', 'B1': 'итог'}), 'нет: итог')
        self.assertEqual(self.calc({'A1': '="a"&"b"'}), 'ab')
        self.assertEqual(self.calc({'A1': '=ROUND(B1,2)', 'B1': '3,14159'}), 3.14)

    def test_errors_do_not_escape(self):
        self.assertEqual(self.calc({'A1': '=1/0'}), formulas.DIV0)
        self.assertEqual(self.calc({'A1': '=NOPE(1)'}), formulas.ERROR)
        self.assertEqual(self.calc({'A1': '=A1+1'}), formulas.CYCLE)
        self.assertEqual(self.calc({'A1': '=A2+1', 'A2': '=A1'}), formulas.CYCLE)

    def test_column_names_round_trip(self):
        for index in (0, 1, 25, 26, 27, 51, 52, 701, 702):
            self.assertEqual(formulas.col_index(formulas.col_name(index)), index)


class OpsTests(TestCase):
    def test_blocks_keep_their_order(self):
        data = apply_ops('doc', {}, [
            {'op': 'block.put', 'block': {'id': 'a', 'type': 'h1', 'text': 'Заголовок'}},
            {'op': 'block.put', 'block': {'id': 'b', 'type': 'p', 'text': 'Текст'}},
            {'op': 'block.put', 'block': {'id': 'c', 'type': 'p', 'text': 'Вставка'}, 'at': 1},
        ])
        self.assertEqual(data['order'], ['a', 'c', 'b'])
        data = apply_ops('doc', data, [{'op': 'order', 'order': ['b', 'a']}])
        self.assertEqual(data['order'], ['b', 'a', 'c'])
        data = apply_ops('doc', data, [{'op': 'block.del', 'id': 'a'}])
        self.assertEqual(data['order'], ['b', 'c'])
        self.assertNotIn('a', data['blocks'])

    def test_bad_input_is_refused(self):
        for ops in (
            [{'op': 'block.put', 'block': {'id': 'a', 'type': 'nope'}}],
            [{'op': 'block.put', 'block': {'id': 'плохой id', 'type': 'p'}}],
            [{'op': 'block.put', 'block': {'id': 'a', 'type': 'p', 'text': 'x' * 30_000}}],
            [{'op': 'nope'}],
            [],
        ):
            with self.assertRaises(OpError):
                apply_ops('doc', {}, ops)

    def test_empty_cell_is_removed_not_stored(self):
        data = apply_ops('sheet', {}, [{'op': 'cell.set', 'ref': 'B2', 'cell': {'v': '5'}}])
        self.assertEqual(data['cells'], {'B2': {'v': '5'}})
        data = apply_ops('sheet', data, [{'op': 'cell.set', 'ref': 'B2', 'cell': {'v': ''}}])
        self.assertEqual(data['cells'], {})
        with self.assertRaises(OpError):
            apply_ops('sheet', data, [{'op': 'cell.set', 'ref': 'b2', 'cell': {'v': '1'}}])

    def test_slides_and_theme(self):
        data = apply_ops('deck', {}, [
            {'op': 'slide.put', 'slide': {'id': 's1', 'layout': 'title', 'title': 'Сфера'}},
            {'op': 'theme', 'theme': 'ink'},
        ])
        self.assertEqual(data['order'], ['s1'])
        self.assertEqual(data['theme'], 'ink')
        with self.assertRaises(OpError):
            apply_ops('deck', data, [{'op': 'theme', 'theme': 'neon'}])


class ApiTests(TestCase):
    def setUp(self):
        self.alice = User.objects.create_user(username='alice', password='x')
        self.bob = User.objects.create_user(username='bob', password='x')
        self.eve = User.objects.create_user(username='eve', password='x')
        self.a, self.b, self.e = app_client(self.alice), app_client(self.bob), app_client(self.eve)

    def create(self, kind='doc', title='Договор'):
        r = self.a.post('/api/office/docs/', {'kind': kind, 'title': title}, format='json')
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def share(self, doc_id, user, role='editor'):
        return self.a.post(f'/api/office/docs/{doc_id}/members/', {'user_id': str(user.id), 'role': role}, format='json')

    def test_create_edit_and_see_it_as_a_co_author(self):
        d = self.create()
        self.assertEqual(self.share(d['id'], self.bob).status_code, 201)
        ops = [{'op': 'block.put', 'block': {'id': 'b1', 'type': 'p', 'text': 'Правка Боба'}}]
        r = self.b.post(f"/api/office/docs/{d['id']}/ops/", {'ops': ops}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['version'], 1)
        seen = self.a.get(f"/api/office/docs/{d['id']}/").json()
        self.assertEqual(seen['data']['blocks']['b1']['text'], 'Правка Боба')
        self.assertEqual(seen['size'], 1)

    def test_a_viewer_can_read_but_not_write(self):
        d = self.create()
        self.share(d['id'], self.bob, 'viewer')
        self.assertEqual(self.b.get(f"/api/office/docs/{d['id']}/").status_code, 200)
        r = self.b.post(f"/api/office/docs/{d['id']}/ops/",
                        {'ops': [{'op': 'block.put', 'block': {'id': 'x', 'type': 'p', 'text': 'нет'}}]}, format='json')
        self.assertEqual(r.status_code, 403)

    def test_a_stranger_sees_nothing(self):
        d = self.create()
        self.assertEqual(self.e.get(f"/api/office/docs/{d['id']}/").status_code, 404)
        self.assertEqual(self.e.get('/api/office/docs/').json(), [])
        self.assertEqual(self.e.delete(f"/api/office/docs/{d['id']}/").status_code, 404)

    def test_invalid_edits_are_rejected_with_their_reason(self):
        d = self.create()
        r = self.a.post(f"/api/office/docs/{d['id']}/ops/",
                        {'ops': [{'op': 'block.put', 'block': {'id': 'b1', 'type': 'bogus'}}]}, format='json')
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()['error'], 'bad_type')
        self.assertEqual(Doc.objects.get(id=d['id']).version, 0)

    def test_spreadsheet_exports_computed_values(self):
        d = self.create('sheet', 'Смета')
        ops = [
            {'op': 'cell.set', 'ref': 'A1', 'cell': {'v': 'Позиция'}},
            {'op': 'cell.set', 'ref': 'B1', 'cell': {'v': 'Цена'}},
            {'op': 'cell.set', 'ref': 'A2', 'cell': {'v': 'Монтаж'}},
            {'op': 'cell.set', 'ref': 'B2', 'cell': {'v': '1200'}},
            {'op': 'cell.set', 'ref': 'B3', 'cell': {'v': '800'}},
            {'op': 'cell.set', 'ref': 'B4', 'cell': {'v': '=SUM(B2:B3)'}},
        ]
        self.a.post(f"/api/office/docs/{d['id']}/ops/", {'ops': ops}, format='json')
        csv_body = self.a.get(f"/api/office/docs/{d['id']}/download/csv/").content.decode('utf-8-sig')
        self.assertIn('Монтаж', csv_body)
        self.assertIn('2000', csv_body)
        self.assertEqual(self.a.get(f"/api/office/docs/{d['id']}/download/md/").status_code, 400)

    def test_document_exports_markdown_and_printable_html(self):
        d = self.create()
        ops = [
            {'op': 'block.put', 'block': {'id': 'h', 'type': 'h1', 'text': 'Условия'}},
            {'op': 'block.put', 'block': {'id': 'l', 'type': 'ul', 'text': 'Срок — 10 дней'}},
            {'op': 'block.put', 'block': {'id': 't', 'type': 'todo', 'text': 'Согласовать', 'done': True}},
        ]
        self.a.post(f"/api/office/docs/{d['id']}/ops/", {'ops': ops}, format='json')
        md = self.a.get(f"/api/office/docs/{d['id']}/download/md/").content.decode()
        self.assertIn('# Условия', md)
        self.assertIn('- Срок — 10 дней', md)
        self.assertIn('- [x] Согласовать', md)
        page = self.a.get(f"/api/office/docs/{d['id']}/download/html/").content.decode()
        self.assertIn('<li>Срок — 10 дней</li>', page)
        self.assertIn('Договор', page)

    def test_history_snapshots_and_restore(self):
        d = self.create()
        from .models import REVISION_EVERY

        for i in range(REVISION_EVERY):
            self.a.post(f"/api/office/docs/{d['id']}/ops/",
                        {'ops': [{'op': 'block.put', 'block': {'id': 'b1', 'type': 'p', 'text': f'версия {i}'}}]},
                        format='json')
        history = self.a.get(f"/api/office/docs/{d['id']}/history/").json()
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]['version'], REVISION_EVERY)
        self.assertEqual(DocRevision.objects.count(), 1)
        self.a.post(f"/api/office/docs/{d['id']}/ops/",
                    {'ops': [{'op': 'block.put', 'block': {'id': 'b1', 'type': 'p', 'text': 'сломали'}}]},
                    format='json')
        restored = self.a.post(f"/api/office/docs/{d['id']}/history/{history[0]['id']}/restore/").json()
        self.assertEqual(restored['data']['blocks']['b1']['text'], f'версия {REVISION_EVERY - 1}')

    def test_comments_are_shared_and_resolved(self):
        d = self.create()
        self.share(d['id'], self.bob)
        c = self.b.post(f"/api/office/docs/{d['id']}/comments/", {'anchor': 'b1', 'text': 'Уточнить срок'}, format='json')
        self.assertEqual(c.status_code, 201)
        cid = c.json()['id']
        self.assertEqual(len(self.a.get(f"/api/office/docs/{d['id']}/comments/").json()), 1)
        self.a.patch(f"/api/office/docs/{d['id']}/comments/{cid}/", {'resolved': True}, format='json')
        self.assertEqual(self.a.get(f"/api/office/docs/{d['id']}/comments/?open=1").json(), [])
        self.assertEqual(self.e.get(f"/api/office/docs/{d['id']}/comments/").status_code, 404)
        self.assertEqual(self.b.delete(f"/api/office/docs/{d['id']}/comments/{cid}/").status_code, 204)
        self.assertFalse(DocComment.objects.exists())

    def test_owner_stays_and_a_co_author_can_leave(self):
        d = self.create()
        self.share(d['id'], self.bob)
        self.assertEqual(self.a.delete(f"/api/office/docs/{d['id']}/members/{self.alice.id}/").status_code, 409)
        self.assertEqual(self.b.delete(f"/api/office/docs/{d['id']}/members/{self.bob.id}/").status_code, 204)
        self.assertEqual(self.b.get(f"/api/office/docs/{d['id']}/").status_code, 404)
        self.assertTrue(DocMember.objects.filter(doc_id=d['id'], user=self.alice).exists())

    def test_duplicating_a_document_validates_its_content(self):
        d = self.create('deck', 'Питч')
        data = {'slides': {'s1': {'id': 's1', 'layout': 'bullets', 'title': 'План', 'bullets': ['раз', 'два']}},
                'order': ['s1'], 'theme': 'sky'}
        copy = self.a.post('/api/office/docs/', {'kind': 'deck', 'title': 'Питч (копия)', 'data': data}, format='json')
        self.assertEqual(copy.status_code, 201)
        self.assertEqual(copy.json()['data']['slides']['s1']['bullets'], ['раз', 'два'])
        bad = self.a.post('/api/office/docs/',
                          {'kind': 'deck', 'title': 'Мусор', 'data': {'slides': {'s1': {'id': 's1', 'layout': 'nope'}}, 'order': ['s1']}},
                          format='json')
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(Doc.objects.filter(title='Мусор').count(), 0)
        self.assertEqual(len(self.a.get('/api/office/docs/?kind=deck').json()), 2)
        self.assertEqual(d['kind'], 'deck')
