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
