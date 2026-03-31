import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from .models import Conversation, Message
from ionik_auth.models import User


class ChatConsumer(AsyncWebsocketConsumer):
    """
    WebSocket consumer for real-time chat messages.

    Connect:   ws://host/ws/chat/<conversation_id>/?token=<jwt>
    Send:      {"message": "hello"}
    Receive:   {"id": 1, "author": {...}, "content": "hello", "created_at": "..."}
    """

    async def connect(self):
        self.conversation_id = self.scope['url_route']['kwargs']['conversation_id']
        self.room_group = f'chat_{self.conversation_id}'

        # Verify user is participant
        user = self.scope.get('user')
        if not user or user.is_anonymous:
            await self.close()
            return

        is_participant = await self.check_participant(user.id)
        if not is_participant:
            await self.close()
            return

        await self.channel_layer.group_add(self.room_group, self.channel_name)
        await self.accept()

    async def disconnect(self, close_code):
        await self.channel_layer.group_discard(self.room_group, self.channel_name)

    async def receive(self, text_data):
        data = json.loads(text_data)
        content = data.get('message', '').strip()
        if not content:
            return

        user = self.scope['user']
        msg = await self.save_message(user.id, content)

        # Broadcast to all users in this conversation
        await self.channel_layer.group_send(self.room_group, {
            'type': 'chat_message',
            'message': msg,
        })

    async def chat_message(self, event):
        await self.send(text_data=json.dumps(event['message']))

    @database_sync_to_async
    def check_participant(self, user_id):
        return Conversation.objects.filter(
            id=self.conversation_id, participants__id=user_id
        ).exists()

    @database_sync_to_async
    def save_message(self, user_id, content):
        user = User.objects.get(id=user_id)
        msg = Message.objects.create(
            conversation_id=self.conversation_id,
            author=user,
            content=content,
        )
        return {
            'id': msg.id,
            'author': {
                'id': user.id,
                'username': user.username,
                'avatar': user.avatar,
                'status': user.status,
            },
            'content': msg.content,
            'created_at': msg.created_at.isoformat(),
        }
