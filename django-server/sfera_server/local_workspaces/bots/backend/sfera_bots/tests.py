import unittest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from rest_framework.test import APIClient

from sfera_auth.models import User
from sfera_messages.models import Attachment, Conversation, ConversationParticipant, Message
from .servers_compat import HAS_SERVERS, Guild, GuildChannel, GuildMembership, GuildMessage

PNG_BYTES = b'\x89PNG\r\n\x1a\nbody'

from .models import BotAccount, BotUpdate
from .sferonik import SFERONIK_USERNAME, ensure_sferonik
from . import outbound

def _load_kafka_worker():
    """Import the worker even without the Kafka client installed.

    The worker is the production write path for messages, so its bot hook must
    be covered; `confluent_kafka` is a heavyweight native dependency that only
    the deployed image needs, so a stub stands in for the import.
    """
    import sys
    import types

    if 'confluent_kafka' not in sys.modules:
        try:
            import confluent_kafka  # noqa: F401
        except ImportError:
            stub = types.ModuleType('confluent_kafka')
            stub.Consumer = object
            stub.KafkaError = type('KafkaError', (Exception,), {})
            stub.Producer = object
            sys.modules['confluent_kafka'] = stub
    from sfera_messages.kafka_worker import _process_chat_message
    return _process_chat_message


_process_chat_message = _load_kafka_worker()


def app_client(user=None):
    client = APIClient(HTTP_X_IONIK_CLIENT='1')
    if user is not None:
        client.force_authenticate(user=user)
    return client


class SferonikTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username='alice', password='x')
        self.client = app_client(self.owner)

    def _say(self, text):
        """Send a DM to Сфероник and return its reply text."""
        bot = ensure_sferonik()
        convo = outbound.dm_conversation_for(self.owner, bot.user)
        msg = Message.objects.create(conversation=convo, author=self.owner)
        msg.content = text
        msg.save()
        outbound.dispatch_dm_message(msg)
        return Message.objects.filter(conversation=convo, author=bot.user).last().content

    def test_sferonik_chat_endpoint_creates_dm_and_greets(self):
        res = self.client.get('/api/bots/sferonik/')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()['bot']['username'], SFERONIK_USERNAME)
        convo = Conversation.objects.get(id=res.json()['conversation_id'])
        self.assertEqual(Message.objects.filter(conversation=convo).count(), 1)

    def test_sferonik_answers_a_command_that_arrives_through_kafka(self):
        bot = ensure_sferonik()
        convo = outbound.dm_conversation_for(self.owner, bot.user)
        _process_chat_message({
            'content': '/mybots',
            'author_id': str(self.owner.id),
            'conversation_id': str(convo.id),
        })
        reply = Message.objects.filter(conversation=convo, author=bot.user).last()
        self.assertIn('/newbot', reply.content)

    def test_sferonik_is_not_added_to_the_dm_list(self):
        from sfera_auth.models import Friendship

        self.client.get('/api/bots/sferonik/')
        bot = ensure_sferonik()
        self.assertFalse(Friendship.objects.filter(to_user=bot.user).exists())
        self.assertFalse(Friendship.objects.filter(from_user=bot.user).exists())

    def test_opening_sferonik_clears_a_legacy_contact(self):
        from sfera_auth.models import Friendship

        bot = ensure_sferonik()
        Friendship.objects.create(from_user=self.owner, to_user=bot.user, status='accepted')
        self.client.get('/api/bots/sferonik/')
        self.assertFalse(Friendship.objects.filter(to_user=bot.user).exists())

    def test_a_normal_bot_does_appear_in_the_dm_list(self):
        from sfera_auth.models import Friendship
        from .sferonik import create_bot

        account, _token = create_bot(self.owner, 'Погода', 'weather')
        outbound.dm_conversation_for(self.owner, account.user)
        self.assertTrue(
            Friendship.objects.filter(from_user=self.owner, to_user=account.user, status='accepted').exists()
        )

    @unittest.skipUnless(HAS_SERVERS, 'servers module not deployed')
    def test_addbot_only_offers_servers_the_user_manages(self):
        from .sferonik import create_bot

        account, _token = create_bot(self.owner, 'Погода', 'weather')
        mine = Guild.objects.create(name='Мой клуб', owner=self.owner, invite_code='inv-mine')
        GuildMembership.objects.create(guild=mine, user=self.owner, role='owner')

        stranger = User.objects.create_user(username='carol', password='x')
        theirs = Guild.objects.create(name='Чужой клуб', owner=stranger, invite_code='inv-theirs')
        GuildMembership.objects.create(guild=theirs, user=stranger, role='owner')
        GuildMembership.objects.create(guild=theirs, user=self.owner, role='member')

        listing = self._say('/addbot weather_bot')
        self.assertIn('Мой клуб', listing)
        self.assertNotIn('Чужой клуб', listing)

        self.assertIn('добавлен на сервер', self._say('1'))
        self.assertTrue(GuildMembership.objects.filter(guild=mine, user=account.user).exists())

        self._say('/removebot weather_bot')
        self.assertIn('убран с сервера', self._say('1'))
        self.assertFalse(GuildMembership.objects.filter(guild=mine, user=account.user).exists())

    def test_addbot_without_a_manageable_server(self):
        from .sferonik import create_bot

        create_bot(self.owner, 'Погода', 'weather')
        self.assertIn('Нет серверов', self._say('/addbot weather_bot'))

    def test_registration_flow_issues_a_key(self):
        self.assertIn('/newbot', self._say('/help'))
        self.assertIn('имя', self._say('/newbot').lower())
        self.assertIn('юзернейм', self._say('Погода').lower())
        # Registration now asks for the API tier before issuing the key.
        self.assertIn('@weather_bot', self._say('weather'))
        reply = self._say('1')
        # The key sits in a fenced code block so the client renders a copy button.
        self.assertRegex(reply, r'```\nsfb_[^\n]+\n```')

        account = BotAccount.objects.get(user__username='weather_bot')
        self.assertEqual(account.owner, self.owner)
        self.assertEqual(account.user.account_type, 'bot')

    def test_username_always_ends_with_bot_suffix(self):
        self._say('/newbot Погода')
        self._say('weather')
        self._say('1')
        self.assertTrue(BotAccount.objects.get(owner=self.owner).user.username.endswith('_bot'))

    def test_delete_revokes_key_but_keeps_the_dialog(self):
        self._say('/newbot Погода')
        self._say('weather')
        token = [l for l in self._say('1').splitlines() if l.startswith('sfb_')][0]
        account = BotAccount.objects.get(user__username='weather_bot')
        convo = outbound.dm_conversation_for(self.owner, account.user)
        outbound.send_dm(account.user, convo, 'hello from the bot')
        before = Message.objects.filter(conversation=convo).count()

        self._say('/deletebot weather_bot')
        self.assertIn('удалён', self._say('weather_bot'))

        account.refresh_from_db()
        self.assertFalse(account.is_active)
        self.assertEqual(Message.objects.filter(conversation=convo).count(), before)
        res = app_client().get('/api/bots/api/me/', HTTP_AUTHORIZATION=f'Bot {token}')
        self.assertEqual(res.status_code, 401)


class BotApiTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username='alice', password='x')
        self.peer = User.objects.create_user(username='bob', password='x')
        res = app_client(self.owner).post(
            '/api/bots/', {'username': 'weather', 'display_name': 'Погода'}, format='json',
        )
        self.assertEqual(res.status_code, 201)
        self.token = res.json()['token']
        self.account = BotAccount.objects.get(id=res.json()['id'])
        self.bot_client = app_client()
        self.bot_client.credentials(HTTP_AUTHORIZATION=f'Bot {self.token}')

    def test_key_auth_and_command_registration(self):
        res = self.bot_client.get('/api/bots/api/me/')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()['username'], 'weather_bot')

        res = self.bot_client.post(
            '/api/bots/api/commands/',
            {'commands': [{'command': 'start', 'description': 'Запустить'}]},
            format='json',
        )
        self.assertEqual(res.json()['commands'], [{'command': 'start', 'description': 'Запустить'}])

        # The client UI reads the same list to draw the command button.
        res = app_client(self.peer).get(f'/api/bots/commands/?user_id={self.account.user_id}')
        self.assertEqual(res.json()['bots'][0]['commands'][0]['command'], 'start')

    def test_incoming_command_is_queued_and_can_be_answered(self):
        convo = outbound.dm_conversation_for(self.peer, self.account.user)
        msg = Message.objects.create(conversation=convo, author=self.peer)
        msg.content = '/start now'
        msg.save()
        outbound.dispatch_dm_message(msg)

        updates = self.bot_client.get('/api/bots/api/updates/').json()['updates']
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0]['type'], 'command')
        self.assertEqual(updates[0]['command'], 'start')
        self.assertEqual(updates[0]['args'], 'now')
        self.assertEqual(updates[0]['chat_id'], str(convo.id))

        res = self.bot_client.post(
            '/api/bots/api/send/', {'chat_id': str(convo.id), 'text': 'привет'}, format='json',
        )
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.json()['author']['account_type'], 'bot')

        # Acknowledging with the offset drains the queue.
        acked = self.bot_client.get(f'/api/bots/api/updates/?offset={updates[0]["id"]}').json()
        self.assertEqual(acked['updates'], [])
        self.assertEqual(BotUpdate.objects.filter(bot=self.account).count(), 0)

    @unittest.skipUnless(HAS_SERVERS, 'servers module not deployed')
    def test_bot_on_a_server_hears_its_channel_and_can_post(self):
        guild = Guild.objects.create(name='Клуб', owner=self.owner, invite_code='inv1')
        GuildMembership.objects.create(guild=guild, user=self.owner, role='owner')
        GuildMembership.objects.create(guild=guild, user=self.peer, role='member')
        channel = GuildChannel.objects.create(guild=guild, name='general')

        res = app_client(self.owner).post(f'/api/bots/{self.account.id}/guilds/{guild.id}/')
        self.assertEqual(res.status_code, 200)

        msg = GuildMessage.objects.create(channel=channel, author=self.peer)
        msg.content = '/start'
        msg.save()
        outbound.dispatch_channel_message(msg)

        updates = self.bot_client.get('/api/bots/api/updates/').json()['updates']
        self.assertEqual(updates[0]['chat_type'], 'channel')
        self.assertEqual(updates[0]['chat_id'], str(channel.id))

        res = self.bot_client.post(
            '/api/bots/api/send/', {'chat_id': str(channel.id), 'text': 'здесь'}, format='json',
        )
        self.assertEqual(res.status_code, 201)
        self.assertEqual(GuildMessage.objects.filter(channel=channel, author=self.account.user).count(), 1)

        # The composer in that channel now offers the bot's commands.
        self.bot_client.post(
            '/api/bots/api/commands/',
            {'commands': [{'command': 'start', 'description': 'Запустить'}]}, format='json',
        )
        listed = app_client(self.peer).get(f'/api/bots/commands/?channel_id={channel.id}').json()
        self.assertEqual(listed['bots'][0]['username'], 'weather_bot')

    def test_messages_arriving_through_kafka_reach_the_bot(self):
        """Real clients write via the ws-gateway → Kafka worker, not the view."""
        convo = outbound.dm_conversation_for(self.peer, self.account.user)
        _process_chat_message({
            'content': '/start now',
            'author_id': str(self.peer.id),
            'conversation_id': str(convo.id),
        })

        updates = self.bot_client.get('/api/bots/api/updates/').json()['updates']
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0]['command'], 'start')

    def test_bot_can_edit_and_delete_its_own_messages(self):
        convo = outbound.dm_conversation_for(self.peer, self.account.user)
        sent = self.bot_client.post(
            '/api/bots/api/send/', {'chat_id': str(convo.id), 'text': 'первый вариант'}, format='json',
        ).json()

        res = self.bot_client.post(
            '/api/bots/api/edit/', {'message_id': sent['id'], 'text': 'исправлено'}, format='json',
        )
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.json()['edited'])
        self.assertEqual(Message.objects.get(id=sent['id']).content, 'исправлено')

        res = self.bot_client.post(
            '/api/bots/api/delete/', {'message_id': sent['id']}, format='json',
        )
        self.assertEqual(res.status_code, 204)
        self.assertFalse(Message.objects.filter(id=sent['id']).exists())

    def test_bot_cannot_edit_someone_elses_message(self):
        convo = outbound.dm_conversation_for(self.peer, self.account.user)
        theirs = Message.objects.create(conversation=convo, author=self.peer)
        theirs.content = 'моё сообщение'
        theirs.save()

        res = self.bot_client.post(
            '/api/bots/api/edit/', {'message_id': str(theirs.id), 'text': 'подмена'}, format='json',
        )
        self.assertEqual(res.status_code, 404)
        self.assertEqual(Message.objects.get(id=theirs.id).content, 'моё сообщение')

    def test_adding_a_bot_as_a_contact_needs_no_acceptance(self):
        res = app_client(self.peer).post(
            '/api/auth/friends/request/', {'user_id': str(self.account.user_id)}, format='json',
        )
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.json()['status'], 'accepted')

        listed = app_client(self.peer).get('/api/auth/friends/').json()
        self.assertIn('weather_bot', [u['username'] for u in listed])
        pending = app_client(self.peer).get('/api/auth/friends/requests/pending/').json()
        self.assertEqual(pending, [])

    def test_sferonik_never_appears_in_the_friend_list(self):
        from .sferonik import ensure_sferonik
        from sfera_auth.models import Friendship

        bot = ensure_sferonik()
        Friendship.objects.create(from_user=self.peer, to_user=bot.user, status='accepted')
        listed = app_client(self.peer).get('/api/auth/friends/').json()
        self.assertNotIn(SFERONIK_USERNAME, [u['username'] for u in listed])

    def test_bot_cannot_post_into_a_chat_it_is_not_in(self):
        stranger_convo = Conversation.objects.create()
        res = self.bot_client.post(
            '/api/bots/api/send/', {'chat_id': str(stranger_convo.id), 'text': 'hi'}, format='json',
        )
        self.assertEqual(res.status_code, 404)

    def test_rotating_the_key_invalidates_the_old_one(self):
        res = app_client(self.owner).post(f'/api/bots/{self.account.id}/token/')
        new_token = res.json()['token']
        self.assertNotEqual(new_token, self.token)
        self.assertEqual(self.bot_client.get('/api/bots/api/me/').status_code, 401)
        ok = app_client().get('/api/bots/api/me/', HTTP_AUTHORIZATION=f'Bot {new_token}')
        self.assertEqual(ok.status_code, 200)

    def test_unlock_requires_owning_the_bot(self):
        res = app_client(self.peer).post('/api/bots/unlock/', {'token': self.token}, format='json')
        self.assertEqual(res.status_code, 403)
        res = app_client(self.owner).post('/api/bots/unlock/', {'token': self.token}, format='json')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()['username'], 'weather_bot')

    def test_flow_graph_round_trip(self):
        graph = {'nodes': [{'id': 'n1', 'type': 'command'}], 'edges': []}
        res = app_client(self.owner).put(
            f'/api/bots/{self.account.id}/flow/',
            {'graph': graph, 'commands': [{'command': 'ping', 'description': 'pong'}]},
            format='json',
        )
        self.assertEqual(res.status_code, 200)
        res = app_client(self.owner).get(f'/api/bots/{self.account.id}/flow/')
        self.assertEqual(res.json()['graph'], graph)
        self.assertEqual(res.json()['commands'][0]['command'], 'ping')


class BotMessageEditRulesTests(TestCase):
    """A bot's words stay the bot's: it may rewrite them, a person may not."""

    def setUp(self):
        self.owner = User.objects.create_user(username='alice', password='x')
        self.peer = User.objects.create_user(username='bob', password='x')
        res = app_client(self.owner).post(
            '/api/bots/', {'username': 'weather', 'display_name': 'Погода'}, format='json',
        )
        self.token = res.json()['token']
        self.account = BotAccount.objects.get(id=res.json()['id'])
        self.bot = app_client()
        self.bot.credentials(HTTP_AUTHORIZATION=f'Bot {self.token}')
        self.convo = outbound.dm_conversation_for(self.peer, self.account.user)
        _msg, payload = outbound.send_dm(self.account.user, self.convo, 'первый ответ')
        self.bot_message_id = payload['id']

    def test_the_bot_can_rewrite_its_own_message(self):
        res = self.bot.post(
            '/api/bots/api/edit/',
            {'message_id': self.bot_message_id, 'text': 'исправленный ответ'},
            format='json',
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(Message.objects.get(id=self.bot_message_id).content, 'исправленный ответ')

    def test_a_person_in_the_chat_cannot_edit_the_bot_message(self):
        res = app_client(self.peer).patch(
            f'/api/messages/{self.bot_message_id}/', {'content': 'подделка'}, format='json',
        )
        self.assertEqual(res.status_code, 404)
        self.assertEqual(Message.objects.get(id=self.bot_message_id).content, 'первый ответ')

    def test_the_owner_cannot_edit_it_either(self):
        res = app_client(self.owner).patch(
            f'/api/messages/{self.bot_message_id}/', {'content': 'подделка'}, format='json',
        )
        self.assertEqual(res.status_code, 404)

    def test_signing_in_as_the_bot_account_does_not_open_the_app_edit_path(self):
        # The ownership check alone would allow this — the account IS the
        # author — so it is the account_type guard that has to refuse.
        res = app_client(self.account.user).patch(
            f'/api/messages/{self.bot_message_id}/', {'content': 'через веб'}, format='json',
        )
        self.assertEqual(res.status_code, 403)
        self.assertEqual(Message.objects.get(id=self.bot_message_id).content, 'первый ответ')

    def test_a_person_can_still_edit_their_own_message_in_a_bot_chat(self):
        mine = Message.objects.create(conversation=self.convo, author=self.peer)
        mine.content = '/hi'
        mine.save()
        res = app_client(self.peer).patch(
            f'/api/messages/{mine.id}/', {'content': '/hello'}, format='json',
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(Message.objects.get(id=mine.id).content, '/hello')


class BotMediaAndContextTests(TestCase):
    """Attachments, chat history, members and reactions."""

    def setUp(self):
        self.owner = User.objects.create_user(username='alice', password='x')
        self.peer = User.objects.create_user(username='bob', password='x')
        res = app_client(self.owner).post(
            '/api/bots/', {'username': 'weather', 'display_name': 'Погода'}, format='json',
        )
        self.token = res.json()['token']
        self.account = BotAccount.objects.get(id=res.json()['id'])
        self.bot = app_client()
        self.bot.credentials(HTTP_AUTHORIZATION=f'Bot {self.token}')
        self.convo = outbound.dm_conversation_for(self.peer, self.account.user)

    def _upload(self, chat_id, name='pic.png', body=PNG_BYTES):
        return self.bot.post(
            '/api/bots/api/upload/',
            {
                'chat_id': str(chat_id),
                'file': SimpleUploadedFile(name, body, content_type='image/png'),
            },
            format='multipart',
        )

    def test_upload_then_send_attaches_the_file_and_the_bot_can_read_it_back(self):
        up = self._upload(self.convo.id)
        self.assertEqual(up.status_code, 201)
        attachment_id = up.json()['id']

        res = self.bot.post(
            '/api/bots/api/send/',
            {'chat_id': str(self.convo.id), 'attachment_ids': [attachment_id]},
            format='json',
        )
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.json()['attachments'][0]['id'], attachment_id)
        # A bare photo with no caption is a valid message.
        self.assertEqual(res.json()['content'], '')

        self.assertIsNotNone(Attachment.objects.get(id=attachment_id).message_id)

        # And the file comes back through the bot's own download route.
        got = self.bot.get(f'/api/bots/api/file/{attachment_id}/')
        self.assertEqual(got.status_code, 200)
        self.assertEqual(got.content, PNG_BYTES)

    def test_the_same_attachment_cannot_be_sent_twice(self):
        attachment_id = self._upload(self.convo.id).json()['id']
        body = {'chat_id': str(self.convo.id), 'attachment_ids': [attachment_id]}
        self.assertEqual(self.bot.post('/api/bots/api/send/', body, format='json').status_code, 201)
        self.assertEqual(self.bot.post('/api/bots/api/send/', body, format='json').status_code, 400)

    def test_a_bot_cannot_download_a_file_from_a_chat_it_is_not_in(self):
        stranger = User.objects.create_user(username='carol', password='x')
        other = Conversation.objects.create()
        ConversationParticipant.objects.create(conversation=other, user=self.peer)
        ConversationParticipant.objects.create(conversation=other, user=stranger)
        att = Attachment.objects.create(
            conversation=other, uploader=self.peer, original_filename='secret.png',
            content_type='image/png', file_size=3,
        )
        self.assertEqual(self.bot.get(f'/api/bots/api/file/{att.id}/').status_code, 404)

    def test_an_incoming_photo_shows_up_in_updates(self):
        msg = Message.objects.create(conversation=self.convo, author=self.peer)
        msg.content = 'смотри'
        msg.save()
        Attachment.objects.create(
            conversation=self.convo, uploader=self.peer, message=msg,
            original_filename='cat.png', content_type='image/png', file_size=7,
        )
        outbound.dispatch_dm_message(msg)

        update = self.bot.get('/api/bots/api/updates/').json()['updates'][0]
        self.assertEqual(update['message']['attachments'][0]['filename'], 'cat.png')

    def test_history_reads_the_chat_back_without_draining_updates(self):
        for i in range(5):
            m = Message.objects.create(conversation=self.convo, author=self.peer)
            m.content = f'сообщение {i}'
            m.save()

        res = self.bot.get(f'/api/bots/api/history/?chat_id={self.convo.id}&limit=3')
        self.assertEqual(res.status_code, 200)
        # Newest three, oldest first.
        self.assertEqual(
            [m['content'] for m in res.json()['messages']],
            ['сообщение 2', 'сообщение 3', 'сообщение 4'],
        )

        # Paging backwards from the oldest one returned.
        first_id = res.json()['messages'][0]['id']
        older = self.bot.get(f'/api/bots/api/history/?chat_id={self.convo.id}&before={first_id}')
        self.assertEqual(
            [m['content'] for m in older.json()['messages']],
            ['сообщение 0', 'сообщение 1'],
        )

    def test_history_and_members_refuse_a_chat_the_bot_is_not_in(self):
        other = Conversation.objects.create()
        ConversationParticipant.objects.create(conversation=other, user=self.peer)
        self.assertEqual(self.bot.get(f'/api/bots/api/history/?chat_id={other.id}').status_code, 404)
        self.assertEqual(self.bot.get(f'/api/bots/api/members/?chat_id={other.id}').status_code, 404)

    @unittest.skipUnless(HAS_SERVERS, 'servers module not deployed')
    def test_members_of_a_dm_and_of_a_channel(self):
        res = self.bot.get(f'/api/bots/api/members/?chat_id={self.convo.id}')
        self.assertEqual(res.json()['chat_type'], 'dm')
        self.assertEqual(
            sorted(m['username'] for m in res.json()['members']),
            ['bob', 'weather_bot'],
        )

        guild = Guild.objects.create(name='Клуб', owner=self.owner, invite_code='inv-media')
        GuildMembership.objects.create(guild=guild, user=self.owner, role='owner')
        channel = GuildChannel.objects.create(guild=guild, name='general')
        app_client(self.owner).post(f'/api/bots/{self.account.id}/guilds/{guild.id}/')

        res = self.bot.get(f'/api/bots/api/members/?chat_id={channel.id}')
        self.assertEqual(res.json()['chat_type'], 'channel')
        roles = {m['username']: m['role'] for m in res.json()['members']}
        self.assertEqual(roles['alice'], 'owner')
        self.assertEqual(roles['weather_bot'], 'member')

    @unittest.skipUnless(HAS_SERVERS, 'servers module not deployed')
    def test_react_toggles_on_a_channel_message_and_is_refused_in_a_dm(self):
        guild = Guild.objects.create(name='Клуб', owner=self.owner, invite_code='inv-react')
        GuildMembership.objects.create(guild=guild, user=self.owner, role='owner')
        channel = GuildChannel.objects.create(guild=guild, name='general')
        app_client(self.owner).post(f'/api/bots/{self.account.id}/guilds/{guild.id}/')
        msg = GuildMessage.objects.create(channel=channel, author=self.owner)
        msg.content = 'ага'
        msg.save()

        res = self.bot.post(
            '/api/bots/api/react/', {'message_id': str(msg.id), 'emoji': '\U0001f44d'}, format='json',
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()['reactions'][0]['emoji'], '\U0001f44d')

        res = self.bot.post(
            '/api/bots/api/react/',
            {'message_id': str(msg.id), 'emoji': '\U0001f44d', 'remove': True},
            format='json',
        )
        self.assertEqual(res.json()['reactions'], [])

        # A DM message has no reactions to give.
        dm = Message.objects.create(conversation=self.convo, author=self.peer)
        dm.content = 'привет'
        dm.save()
        res = self.bot.post(
            '/api/bots/api/react/', {'message_id': str(dm.id), 'emoji': '\U0001f44d'}, format='json',
        )
        self.assertEqual(res.status_code, 404)
