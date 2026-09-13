"""Проверка Python-SDK против настоящего сервера.

Тест поднимает живой Django (LiveServerTestCase) и гоняет по нему тот же
протокол, которым пользуются SDK для C++ и Rust: ключ в заголовке, длинный
опрос с подтверждением через offset, отправка сообщения.
"""

import pathlib
import sys
import unittest

from django.test import LiveServerTestCase

from sfera_auth.models import User
from sfera_messages.models import Attachment, Message

from . import outbound
from .models import BotAccount, BotUpdate
from .sferonik import create_bot

from sfera_modules.loader import REPO_ROOT
SDK_PATH = REPO_ROOT / 'bot-sdks' / 'python'
if str(SDK_PATH) not in sys.path:
    sys.path.insert(0, str(SDK_PATH))

try:
    from sfera_bot import Bot, BotError  # noqa: E402
except ImportError:  # pragma: no cover - SDK лежит рядом в репозитории
    Bot = None
    BotError = Exception


@unittest.skipIf(Bot is None, 'Python SDK не найден в bot-sdks/python')
class PythonSdkTests(LiveServerTestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username='alice', password='x')
        self.account, self.token = create_bot(self.owner, 'Погода', 'weather')
        self.bot = Bot(token=self.token, server=self.live_server_url, timeout=0)

    def test_me_reports_the_bot_identity(self):
        self.assertEqual(self.bot.me()['username'], 'weather_bot')

    def test_revoked_key_is_rejected(self):
        bad = Bot(token='sfb_nope', server=self.live_server_url, timeout=0)
        with self.assertRaises(BotError):
            bad.me()

    def test_commands_registration_reaches_the_database(self):
        from sfera_bot import Command

        self.bot.set_commands([Command('start', 'Запустить')])
        self.account.refresh_from_db()
        self.assertEqual(self.account.commands, [{'command': 'start', 'description': 'Запустить'}])

    def test_full_round_trip_command_to_reply(self):
        peer = User.objects.create_user(username='bob', password='x')
        convo = outbound.dm_conversation_for(peer, self.account.user)
        incoming = Message.objects.create(conversation=convo, author=peer)
        incoming.content = '/start сейчас'
        incoming.save()
        outbound.dispatch_dm_message(incoming)

        updates = self.bot.poll()
        self.assertEqual(len(updates), 1)
        update = updates[0]
        self.assertTrue(update.is_command)
        self.assertTrue(update.is_direct)
        self.assertEqual(update.command, 'start')
        self.assertEqual(update.args, 'сейчас')
        self.assertEqual(update.user, 'bob')

        self.bot.reply(update, 'привет')
        reply = Message.objects.filter(conversation=convo, author=self.account.user).last()
        self.assertEqual(reply.content, 'привет')

        # Следующий опрос подтверждает предыдущий — очередь пустеет.
        self.assertEqual(self.bot.poll(), [])
        self.assertEqual(BotUpdate.objects.filter(bot=self.account).count(), 0)

    def test_dispatch_routes_to_the_registered_handler(self):
        seen = []

        @self.bot.command('start', 'Запустить')
        def handle(bot, update):
            seen.append(update.args)

        peer = User.objects.create_user(username='bob', password='x')
        convo = outbound.dm_conversation_for(peer, self.account.user)
        message = Message.objects.create(conversation=convo, author=peer)
        message.content = '/start сейчас'
        message.save()
        outbound.dispatch_dm_message(message)

        for update in self.bot.poll():
            self.bot.dispatch(update)
        self.assertEqual(seen, ['сейчас'])

    def test_chats_lists_the_dm(self):
        peer = User.objects.create_user(username='bob', password='x')
        outbound.dm_conversation_for(peer, self.account.user)
        chats = self.bot.chats()
        self.assertEqual([c.chat_type for c in chats], ['dm'])
        self.assertEqual(chats[0].peer['username'], 'bob')

    def test_bot_account_is_marked_as_bot(self):
        self.assertEqual(BotAccount.objects.get(id=self.account.id).user.account_type, 'bot')

    def test_send_file_uploads_and_posts_it_and_download_reads_it_back(self):
        peer = User.objects.create_user(username='bob', password='x')
        convo = outbound.dm_conversation_for(peer, self.account.user)

        blob = b'\x89PNG\r\n\x1a\nhello'
        sent = self.bot.send_file(convo.id, blob, caption='держи', filename='cat.png')
        self.assertEqual(sent['content'], 'держи')
        attachment_id = sent['attachments'][0]['id']

        self.assertEqual(Attachment.objects.get(id=attachment_id).original_filename, 'cat.png')
        self.assertEqual(self.bot.download(attachment_id), blob)

    def test_history_and_members_read_the_chat_back(self):
        peer = User.objects.create_user(username='bob', password='x')
        convo = outbound.dm_conversation_for(peer, self.account.user)
        for text in ('первое', 'второе'):
            m = Message.objects.create(conversation=convo, author=peer)
            m.content = text
            m.save()

        self.assertEqual(
            [m['content'] for m in self.bot.history(convo.id)],
            ['первое', 'второе'],
        )
        self.assertEqual(
            sorted(m['username'] for m in self.bot.members(convo.id)),
            ['bob', 'weather_bot'],
        )

    def test_an_incoming_photo_arrives_as_an_attachment(self):
        peer = User.objects.create_user(username='bob', password='x')
        convo = outbound.dm_conversation_for(peer, self.account.user)
        incoming = Message.objects.create(conversation=convo, author=peer)
        incoming.content = 'смотри'
        incoming.save()
        Attachment.objects.create(
            conversation=convo, uploader=peer, message=incoming,
            original_filename='cat.png', content_type='image/png', file_size=5,
        )
        outbound.dispatch_dm_message(incoming)

        update = self.bot.poll()[0]
        self.assertTrue(update.has_media)
        self.assertTrue(update.attachments[0].is_image)
        self.assertEqual(update.attachments[0].filename, 'cat.png')
