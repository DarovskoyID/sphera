from django.test import TestCase
from rest_framework.test import APIClient

from sfera_auth.models import User
from sfera_messages.models import (
    Conversation, Guild, GuildChannel, GuildMembership, GuildMessage, Message,
)

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

    def test_registration_flow_issues_a_key(self):
        self.assertIn('/newbot', self._say('/help'))
        self.assertIn('имя', self._say('/newbot').lower())
        self.assertIn('юзернейм', self._say('Погода').lower())
        reply = self._say('weather')
        self.assertIn('@weather_bot', reply)
        self.assertIn('sfb_', reply)

        account = BotAccount.objects.get(user__username='weather_bot')
        self.assertEqual(account.owner, self.owner)
        self.assertEqual(account.user.account_type, 'bot')

    def test_username_always_ends_with_bot_suffix(self):
        self._say('/newbot Погода')
        self._say('weather')
        self.assertTrue(BotAccount.objects.get(owner=self.owner).user.username.endswith('_bot'))

    def test_delete_revokes_key_but_keeps_the_dialog(self):
        self._say('/newbot Погода')
        token = [l for l in self._say('weather').splitlines() if l.startswith('sfb_')][0]
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
