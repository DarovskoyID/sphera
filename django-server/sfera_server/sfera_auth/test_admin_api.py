from django.test import TransactionTestCase
from rest_framework.test import APIClient

from sfera_messages.models import Conversation, Message, MessageReport

from .models import User, UserBan


def client_for(user):
    c = APIClient(HTTP_X_IONIK_CLIENT='1')
    c.force_authenticate(user)
    return c


class AdminPanelTests(TransactionTestCase):
    # Views run through sync_to_async on another thread, which must see committed rows.
    def setUp(self):
        self.root = User.objects.create_superuser(username='root', email='root@x.ru', password='pass12345')
        self.alice = User.objects.create_user(username='alice', password='pass12345')
        self.troll = User.objects.create_user(username='troll', password='pass12345')
        convo = Conversation.objects.create()
        convo.participants.add(self.alice, self.troll)
        self.msg = Message.objects.create(conversation=convo, author=self.troll, content='оскорбление')
        self.report = MessageReport.objects.create(reporter=self.alice, message=self.msg)
        self.admin = client_for(self.root)

    def test_only_superuser(self):
        c = client_for(self.alice)
        for url in ('/api/admin/reports/', '/api/admin/bans/', '/api/admin/users/?q=tr'):
            self.assertEqual(c.get(url).status_code, 403, url)

    def test_reports_show_decrypted_message_and_resolve(self):
        data = self.admin.get('/api/admin/reports/').data
        self.assertEqual(data['open_count'], 1)
        self.assertEqual(data['reports'][0]['message']['content'], 'оскорбление')
        self.assertEqual(data['reports'][0]['author']['username'], 'troll')
        res = self.admin.post(f'/api/admin/reports/{self.report.id}/resolve/', {'resolution': 'dismissed'}, format='json')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(self.admin.get('/api/admin/reports/').data['open_count'], 0)
        self.assertEqual(len(self.admin.get('/api/admin/reports/?status=resolved').data['reports']), 1)

    def test_delete_reported_message(self):
        self.admin.post(f'/api/admin/reports/{self.report.id}/resolve/', {'resolution': 'deleted'}, format='json')
        self.assertFalse(Message.objects.filter(id=self.msg.id).exists())

    def test_ban_blocks_the_whole_system_and_unban_restores(self):
        res = self.admin.post('/api/admin/bans/', {'user_id': str(self.troll.id), 'reason': 'спам'}, format='json')
        self.assertEqual(res.status_code, 201)
        self.troll.refresh_from_db()
        self.assertFalse(self.troll.is_active)
        login = APIClient(HTTP_X_IONIK_CLIENT='1').post(
            '/api/auth/login/', {'username': 'troll', 'password': 'pass12345'}, format='json')
        self.assertEqual(login.status_code, 401)
        self.assertEqual(self.admin.get('/api/admin/bans/').data['bans'][0]['reason'], 'спам')

        self.assertEqual(self.admin.delete(f'/api/admin/bans/{self.troll.id}/').status_code, 204)
        self.troll.refresh_from_db()
        self.assertTrue(self.troll.is_active)
        self.assertFalse(UserBan.objects.exists())

    def test_cannot_ban_superuser(self):
        res = self.admin.post('/api/admin/bans/', {'user_id': str(self.root.id)}, format='json')
        self.assertEqual(res.status_code, 400)

    def test_user_search(self):
        users = self.admin.get('/api/admin/users/?q=tro').data['users']
        self.assertEqual([(u['username'], u['reports']) for u in users], [('troll', 1)])
