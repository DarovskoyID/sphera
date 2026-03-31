import json
from channels.generic.websocket import AsyncWebsocketConsumer


class SignalingConsumer(AsyncWebsocketConsumer):
    """
    WebSocket consumer for WebRTC signaling.
    Replaces the old HTTP polling signaling server.

    Connect:   ws://host/ws/signaling/?token=<jwt>
    Signals:   {"type": "offer"|"answer"|"candidate"|"video-toggle"|"demo-toggle", "to": "<user_id>", ...}
    Receives:  Same format with "from" field added.
    Peers:     {"type": "peers", "peers": [{"id": "1", "name": "alice"}, ...]}
    """

    # Shared state across all instances
    _users = {}  # user_id -> {"channel": channel_name, "name": username}

    async def connect(self):
        user = self.scope.get('user')
        if not user or user.is_anonymous:
            await self.close()
            return

        self.user_id = str(user.id)
        SignalingConsumer._users[self.user_id] = {
            'channel': self.channel_name,
            'name': user.username,
        }

        await self.channel_layer.group_add('signaling', self.channel_name)
        await self.accept()
        await self._broadcast_peer_list()

    async def disconnect(self, close_code):
        SignalingConsumer._users.pop(self.user_id, None)
        await self.channel_layer.group_discard('signaling', self.channel_name)
        await self._broadcast_peer_list()

    async def receive(self, text_data):
        data = json.loads(text_data)
        target_id = str(data.get('to', ''))

        target = SignalingConsumer._users.get(target_id)
        if target:
            await self.channel_layer.send(target['channel'], {
                'type': 'signal.forward',
                'data': {**data, 'from': self.user_id},
            })

    async def signal_forward(self, event):
        await self.send(text_data=json.dumps(event['data']))

    async def peer_list_update(self, event):
        await self.send(text_data=json.dumps(event['data']))

    async def _broadcast_peer_list(self):
        peers = [
            {'id': uid, 'name': info['name']}
            for uid, info in SignalingConsumer._users.items()
        ]
        await self.channel_layer.group_send('signaling', {
            'type': 'peer.list.update',
            'data': {'type': 'peers', 'peers': peers},
        })
