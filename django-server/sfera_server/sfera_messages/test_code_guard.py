from django.contrib.auth import get_user_model
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient

from .code_guard import asks_for_code, is_bare_or_presented_code, looks_like_code, should_block
from .models import ChatSafetySettings, Conversation, Message

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
        benign = (
            'привет, как дела?', 'встречаемся в 1830', 'код ревью сделал', 'my zip is 10115',
            'скинь пароль от вай фай', 'скинь пароль от wi-fi', 'какой код от домофона?',
            'скинь код проекта на github', 'пришли промокод', 'дай пароль от роутера',
            'скинь пароль', 'напиши код ошибки',
        )
        for text in benign:
            self.assertFalse(asks_for_code(text), text)
        for text in ('скинь пароль от госуслуг', 'пароль из смс продиктуйте', 'назовите одноразовый пароль'):
            self.assertTrue(asks_for_code(text), text)

    def test_strict_presentation(self):
        for text in ('4821', '482 913', 'код 4821', 'пароль из смс: 553311', 'CVV 4821'):
            self.assertTrue(is_bare_or_presented_code(text), text)
        for text in ('встречаемся в 1830 у метро', 'пароль от вайфая 12345678', 'купил за 2500 рублей', 'привет'):
            self.assertFalse(is_bare_or_presented_code(text), text)


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

    def test_wifi_password_is_not_blocked(self):
        self.say(self.scammer, 'скинь пароль от вай фай')
        self.assertEqual(self.send('12345678').status_code, 201)

    def test_strict_mode_blocks_without_context(self):
        self.assertEqual(self.send('4821').status_code, 201)
        ChatSafetySettings.objects.update_or_create(pk=1, defaults={'block_all_codes': True})
        self.assertEqual(self.send('4821').status_code, 403)
        self.assertEqual(self.send('встречаемся в 1830 у метро').status_code, 201)

    def test_only_superuser_switches_strict_mode(self):
        self.assertEqual(self.client.put('/api/chat-safety/', {'block_all_codes': True}, format='json').status_code, 403)
        root = User.objects.create_superuser(username='root', email='root@x.ru', password='pass12345')
        admin = APIClient(HTTP_X_IONIK_CLIENT='1')
        admin.force_authenticate(root)
        res = admin.put('/api/chat-safety/', {'block_all_codes': True}, format='json')
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.data['block_all_codes'])
        self.assertTrue(self.client.get('/api/chat-safety/').data['block_all_codes'])

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
