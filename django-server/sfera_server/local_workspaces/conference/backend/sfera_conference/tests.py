from unittest import mock

import jwt
from asgiref.sync import async_to_sync
from channels.db import database_sync_to_async
from channels.testing import WebsocketCommunicator
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient

from sfera_auth.models import User

from .access import issue_guest_pass, read_guest_pass
from .models import Conference


def app_client(user=None):
    client = APIClient(HTTP_X_IONIK_CLIENT='1')
    if user:
        client.force_authenticate(user=user)
    return client


class ConferenceAccessTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username='host', password='x')
        self.friend = User.objects.create_user(username='friend', password='x')
        self.other = User.objects.create_user(username='other', password='x')
        self.h, self.f, self.o = app_client(self.owner), app_client(self.friend), app_client(self.other)
        self.anon = app_client()

    def create(self, kind, **extra):
        r = self.h.post('/api/conference/conferences/', {'title': f'{kind} call', 'kind': kind, **extra}, format='json')
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def join(self, client, slug, **body):
        return client.post(f'/api/conference/conferences/{slug}/join/', body, format='json')

    def guest(self, slug, name):
        return self.anon.post(f'/api/conference/public/{slug}/guest/', {'name': name}, format='json')

    def test_internal_is_for_registered_users_only(self):
        c = self.create('internal')
        self.assertEqual(self.join(self.o, c['slug']).status_code, 200)
        self.assertEqual(self.join(self.anon, c['slug']).status_code, 401)
        self.assertEqual(self.guest(c['slug'], 'Bob').status_code, 404)
        self.assertNotIn('title', self.anon.get(f"/api/conference/public/{c['slug']}/").json())

    def test_private_is_for_invited_users(self):
        c = self.create('private', invitee_ids=[str(self.friend.id)])
        self.assertEqual(self.join(self.f, c['slug']).status_code, 200)
        self.assertEqual(self.join(self.o, c['slug']).status_code, 403)
        self.assertTrue(self.join(self.h, c['slug']).json()['host'])
        listed = [x['slug'] for x in self.o.get('/api/conference/conferences/').json()]
        self.assertNotIn(c['slug'], listed)

    def test_external_guests_join_by_link_with_a_name(self):
        c = self.create('external')
        self.assertEqual(self.join(self.o, c['slug']).status_code, 200)
        self.assertEqual(self.guest(c['slug'], ' ').status_code, 400)
        r = self.guest(c['slug'], '  Иван   Петров ')
        self.assertEqual(r.json()['name'], 'Иван Петров')
        joined = self.join(self.anon, c['slug'], guest_pass=r.json()['guest_pass'])
        self.assertEqual(joined.status_code, 200)
        self.assertFalse(joined.json()['host'])
        self.assertEqual(joined.json()['media']['mode'], 'mesh')

    def test_guest_pass_is_bound_to_the_conference_and_to_it_being_open(self):
        a = Conference.objects.get(slug=self.create('external')['slug'])
        b = Conference.objects.get(slug=self.create('external')['slug'])
        token, _ = issue_guest_pass(a, 'Guest')
        self.assertIsNotNone(read_guest_pass(token, a))
        self.assertIsNone(read_guest_pass(token, b))
        self.assertIsNone(read_guest_pass(token[:-3] + 'xyz', a))
        self.h.post(f'/api/conference/conferences/{a.slug}/end/')
        a.refresh_from_db()
        self.assertIsNone(read_guest_pass(token, a))

    def test_livekit_token_when_media_server_is_configured(self):
        c = self.create('internal')
        env = {'LIVEKIT_URL': 'wss://lk.example', 'LIVEKIT_API_KEY': 'key', 'LIVEKIT_API_SECRET': 'secret-secret-secret-secret-1234'}
        with mock.patch.dict('os.environ', env):
            body = self.join(self.f, c['slug']).json()
        self.assertEqual(body['media']['mode'], 'livekit')
        claims = jwt.decode(body['media']['token'], env['LIVEKIT_API_SECRET'], algorithms=['HS256'])
        self.assertEqual(claims['video']['room'], f"sfera-{c['id']}")
        self.assertFalse(claims['video']['roomAdmin'])

    def test_only_superuser_sees_media_settings(self):
        self.assertEqual(self.h.get('/api/conference/settings/').status_code, 403)


class ConferenceSocketTests(TransactionTestCase):
    """The room socket end to end: members, guests, lobby, chat, signaling, host controls."""

    def setUp(self):
        self.owner = User.objects.create_user(username='host', password='x')
        self.member = User.objects.create_user(username='member', password='x')

    async def _connect(self, slug, user=None, guest_pass=None):
        from rest_framework_simplejwt.tokens import AccessToken
        from sfera_server.asgi import application

        protocols = []
        if user:
            protocols = ['ionik.jwt', str(await database_sync_to_async(AccessToken.for_user)(user))]
        if guest_pass:
            protocols = ['conf.guest', guest_pass]
        ws = WebsocketCommunicator(application, f'/ws/m/conference/{slug}/', subprotocols=protocols)
        connected, _ = await ws.connect()
        return ws, connected

    async def _recv(self, ws, kind):
        for _ in range(10):
            frame = await ws.receive_json_from(timeout=3)
            if frame['type'] == kind:
                return frame
        raise AssertionError(f'no {kind} frame')

    def test_room_flow(self):
        async_to_sync(self._room_flow)()

    async def _room_flow(self):
        conf = await database_sync_to_async(Conference.objects.create)(title='Demo', kind='external', owner=self.owner, guest_lobby=True)
        host, ok = await self._connect(conf.slug, user=self.owner)
        self.assertTrue(ok)
        welcome = await self._recv(host, 'welcome')
        self.assertTrue(welcome['me']['host'])

        member, ok = await self._connect(conf.slug, user=self.member)
        self.assertTrue(ok)
        mwelcome = await self._recv(member, 'welcome')
        self.assertEqual([p['name'] for p in mwelcome['peers']], ['host'])
        joined = await self._recv(host, 'peer-joined')
        self.assertEqual(joined['peer']['name'], 'member')

        # Signaling goes to one peer only.
        await member.send_json_to({'type': 'signal', 'to': welcome['me']['peer_id'], 'data': {'kind': 'candidate'}})
        sig = await self._recv(host, 'signal')
        self.assertEqual(sig['from'], mwelcome['me']['peer_id'])

        # A guest waits in the lobby until admitted.
        token, _ = await database_sync_to_async(issue_guest_pass)(conf, 'Гость')
        guest, ok = await self._connect(conf.slug, guest_pass=token)
        self.assertTrue(ok)
        await self._recv(guest, 'lobby')
        lobby = await self._recv(host, 'lobby')
        self.assertEqual(lobby['lobby'][0]['name'], 'Гость')
        await host.send_json_to({'type': 'admit', 'peer_id': lobby['lobby'][0]['peer_id']})
        await self._recv(guest, 'admitted')
        gwelcome = await self._recv(guest, 'welcome')
        self.assertEqual(len(gwelcome['peers']), 2)

        # Chat reaches everyone and is kept for latecomers.
        await guest.send_json_to({'type': 'chat', 'text': 'привет'})
        msg = await self._recv(member, 'chat')
        self.assertEqual((msg['message']['name'], msg['message']['guest']), ('Гость', True))

        # Only the host controls the room.
        await member.send_json_to({'type': 'kick', 'peer_id': gwelcome['me']['peer_id']})
        await host.send_json_to({'type': 'kick', 'peer_id': gwelcome['me']['peer_id']})
        await self._recv(guest, 'kicked')
        left = await self._recv(member, 'peer-left')
        self.assertEqual(left['peer_id'], gwelcome['me']['peer_id'])

        await host.send_json_to({'type': 'end'})
        await self._recv(member, 'ended')
        await database_sync_to_async(conf.refresh_from_db)()
        self.assertIsNotNone(conf.ended_at)
        for ws in (host, member, guest):
            await ws.disconnect()

    def test_private_room_refuses_strangers_and_guests(self):
        async_to_sync(self._private)()

    async def _private(self):
        conf = await database_sync_to_async(Conference.objects.create)(title='Secret', kind='private', owner=self.owner)
        _, ok = await self._connect(conf.slug, user=self.member)
        self.assertFalse(ok)
        _, ok = await self._connect(conf.slug)
        self.assertFalse(ok)

    def test_dead_sockets_are_swept(self):
        async_to_sync(self._sweep)()

    async def _sweep(self):
        from datetime import timedelta

        from django.utils import timezone

        from .models import ConferencePeer

        conf = await database_sync_to_async(Conference.objects.create)(title='Demo', kind='internal', owner=self.owner)
        await database_sync_to_async(ConferencePeer.objects.create)(conference=conf, peer_id='ghost', channel='gone', data={'peer_id': 'ghost', 'name': 'ghost'})
        await database_sync_to_async(ConferencePeer.objects.filter(peer_id='ghost').update)(seen_at=timezone.now() - timedelta(minutes=5))
        host, _ = await self._connect(conf.slug, user=self.owner)
        welcome = await self._recv(host, 'welcome')
        self.assertEqual(welcome['peers'], [])
        await host.send_json_to({'type': 'ping'})
        await self._recv(host, 'pong')
        left = await self._recv(host, 'peer-left')
        self.assertEqual(left['peer_id'], 'ghost')
        await host.disconnect()
