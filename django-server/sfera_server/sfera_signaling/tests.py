import json
from unittest.mock import AsyncMock
from django.test import SimpleTestCase
from .consumers import SignalingConsumer


class BusyCallTests(SimpleTestCase):
    def setUp(self):
        self.previous_users = SignalingConsumer._users
        self.me = {'channel': 'current', 'in_call_with': 'active-peer'}
        SignalingConsumer._users = {
            'me': self.me,
            'active-peer': {'channel': 'active'},
            'second-caller': {'channel': 'second'},
        }
        self.consumer = SignalingConsumer()
        self.consumer.user_id = 'me'
        self.consumer.channel_layer = AsyncMock()

    def tearDown(self):
        SignalingConsumer._users = self.previous_users

    async def test_busy_rejection_preserves_call_and_forwards_reason(self):
        await self.consumer.receive(json.dumps({
            'type': 'call-rejected', 'to': 'second-caller', 'callStatus': 'busy',
        }))
        self.assertEqual(self.me['in_call_with'], 'active-peer')
        self.consumer.channel_layer.send.assert_awaited_once_with('second', {
            'type': 'signal.forward',
            'data': {'type': 'call-rejected', 'to': 'second-caller', 'callStatus': 'busy', 'from': 'me'},
        })

    async def test_unrelated_call_end_preserves_active_call(self):
        await self.consumer.receive(json.dumps({'type': 'call-end', 'to': 'second-caller'}))
        self.assertEqual(self.me['in_call_with'], 'active-peer')

    async def test_ending_active_call_clears_state(self):
        await self.consumer.receive(json.dumps({'type': 'call-end', 'to': 'active-peer'}))
        self.assertIsNone(self.me['in_call_with'])

    async def test_socket_disconnect_preserves_peer_call_during_recovery(self):
        peer = SignalingConsumer._users['active-peer']
        peer['in_call_with'] = 'me'
        self.consumer.authed = True
        self.consumer.channel_name = 'current'
        self.consumer._set_status = AsyncMock()
        self.consumer._get_friend_ids = AsyncMock(return_value=[])
        self.consumer._notify_friends = AsyncMock()
        self.consumer._broadcast_peer_list = AsyncMock()
        await self.consumer.disconnect(1006)
        self.assertEqual(peer['in_call_with'], 'me')
        self.assertNotIn('me', SignalingConsumer._users)
        self.consumer.channel_layer.send.assert_awaited_once_with('active', {
            'type': 'signal.forward', 'data': {'type': 'peer-disconnected', 'from': 'me'},
        })

    async def test_resume_restores_call_state_and_notifies_peer(self):
        self.me['in_call_with'] = None
        await self.consumer.receive(json.dumps({'type': 'call-resume', 'to': 'active-peer'}))
        self.assertEqual(self.me['in_call_with'], 'active-peer')
        self.assertEqual(self.consumer.channel_layer.send.call_args.args[1]['data']['type'], 'call-resume')

    async def test_resume_missing_peer_reports_disconnection(self):
        self.consumer.send = AsyncMock()
        await self.consumer.receive(json.dumps({'type': 'call-resume', 'to': 'gone'}))
        self.consumer.send.assert_awaited_once_with(text_data=json.dumps({'type': 'peer-disconnected', 'from': 'gone'}))

    async def test_recovery_offer_does_not_ring_offline_peer_again(self):
        self.consumer.send = AsyncMock()
        self.consumer._push_fcm_call = AsyncMock()
        await self.consumer.receive(json.dumps({'type': 'offer', 'to': 'gone', 'recovery': True}))
        self.consumer._push_fcm_call.assert_not_awaited()
        self.consumer.send.assert_awaited_once_with(text_data=json.dumps({'type': 'peer-disconnected', 'from': 'gone'}))
