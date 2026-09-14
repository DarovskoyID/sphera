from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from channels.testing import WebsocketCommunicator
from django.test import TransactionTestCase, override_settings
from rest_framework_simplejwt.tokens import AccessToken

from sfera_auth.models import User


@override_settings(CHANNEL_LAYERS={'default': {'BACKEND': 'channels.layers.InMemoryChannelLayer'}})
class BanPushTests(TransactionTestCase):
    def test_ban_reaches_open_signaling_socket_and_closes_it(self):
        from sfera_auth import bans
        from sfera_auth.models import UserBan
        from sfera_server.asgi import application

        user = User.objects.create_user(username='troll', password='pass12345')
        token = str(AccessToken.for_user(user))

        async def scenario():
            comm = WebsocketCommunicator(application, '/ws/signaling/', subprotocols=['ionik.jwt', token])
            connected, _ = await comm.connect()
            self.assertTrue(connected)
            await comm.receive_nothing(timeout=0.5)

            from channels.db import database_sync_to_async
            await database_sync_to_async(UserBan.objects.create)(user=user, reason='спам')
            await database_sync_to_async(bans.notify_banned)(user.id)

            frame = None
            for _ in range(10):
                out = await comm.receive_output(timeout=2)
                if out['type'] == 'websocket.send' and 'account_banned' in out.get('text', ''):
                    frame = out['text']
                    break
            self.assertIsNotNone(frame)
            self.assertIn('спам', frame.encode().decode('unicode_escape') if '\\u' in frame else frame)
            closed = await comm.receive_output(timeout=2)
            self.assertEqual(closed['type'], 'websocket.close')
            await comm.disconnect()

            # A new connection with the same token is not authenticated any more.
            again = WebsocketCommunicator(application, '/ws/signaling/', subprotocols=['ionik.jwt', token])
            await again.connect()
            out = await again.receive_output(timeout=2)
            while out['type'] != 'websocket.close':
                out = await again.receive_output(timeout=2)
            self.assertEqual(out.get('code'), 4001)
            await again.disconnect()

        async_to_sync(scenario)()
