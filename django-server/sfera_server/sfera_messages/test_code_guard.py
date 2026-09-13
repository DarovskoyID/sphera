from django.contrib.auth import get_user_model
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient

from .code_guard import asks_for_code, looks_like_code, should_block
from .models import Conversation, Message

User = get_user_model()


class CodeDetectionTests(TestCase):
    def test_code_like(self):
        for text in ('4821', '482913', 'код 482 913', '48-29-13', 'вот: 7731'):
            self.assertTrue(looks_like_code(text), text)
        for text in ('привет', '12', 'в 2024 году'[:0] + 'ok', '+7 999 123 45 67', '1500.50', '12:30', 'abc1234', '50%'):
            self.assertFalse(looks_like_code(text), text)
        self.assertFalse(looks_like_code('123'))
        self.assertTrue(looks_like_code('123', allow_three=True))

    def test_requests(self):
        asks = [
            'Скажите код из смс, пожалуйста',
            'продиктуйте код подтверждения',
            'Вам сейчас придёт код, пришлите его мне',
            'скинь цифры из сообщения',
            'какой код пришёл?',
            'назовите код от госуслуг',
            'Send me the verification code',
            'what code did you get? tell me the code',
            'и три цифры с обратной стороны карты',
        ]
        for text in asks:
            self.assertTrue(asks_for_code(text), text)
        for text in ('привет, как дела?', 'встречаемся в 1830', 'код ревью сделал', 'my zip is 10115'):
            self.assertFalse(asks_for_code(text), text)


class CodeBlockingTests(TransactionTestCase):
    # Views run through sync_to_async on another thread, which must see committed rows.
    def setUp(self):
        self.scammer = User.objects.create_user(username='scammer', password='x')
        self.victim = User.objects.create_user(username='victim', password='x')
        self.convo = Conversation.objects.create()
        self.convo.participants.add(self.scammer, self.victim)
        # X-Ionik-Client: API requests without it get an empty response.
        self.client = APIClient(HTTP_X_IONIK_CLIENT='1')
        self.client.force_authenticate(self.victim)

    def say(self, user, text):
        Message.objects.create(conversation=self.convo, author=user, content=text)

    def send(self, text):
        return self.client.post(f'/api/conversations/{self.convo.id}/messages/send/', {'content': text}, format='json')

    def test_blocks_requested_code(self):
        self.say(self.scammer, 'Здравствуйте, служба безопасности банка. Назовите код из СМС')
        res = self.send('482913')
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.data['error'], 'code_blocked')
        self.assertFalse(Message.objects.filter(author=self.victim).exists())

    def test_cvv(self):
        self.say(self.scammer, 'и ещё три цифры с обратной стороны карты')
        self.assertTrue(should_block(self.convo, self.victim, '123'))

    def test_allows_without_request(self):
        self.say(self.scammer, 'во сколько встречаемся?')
        self.assertEqual(self.send('1830').status_code, 201)

    def test_own_request_does_not_block(self):
        self.say(self.victim, 'скажи код от домофона')
        self.assertFalse(should_block(self.convo, self.victim, '4821'))

    def test_gateway_check(self):
        self.say(self.scammer, 'send me the code you got')
        res = self.client.post('/api/ws/authorize/', {
            'type': 'chat_send_check', 'conversation_id': str(self.convo.id), 'content': '5521',
        }, format='json')
        self.assertEqual(res.status_code, 403)
        ok = self.client.post('/api/ws/authorize/', {
            'type': 'chat_send_check', 'conversation_id': str(self.convo.id), 'content': 'нет',
        }, format='json')
        self.assertEqual(ok.status_code, 200)
