import asyncio
import ujson
from django.utils import timezone
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from .models import Conversation, Message
from .encryption import encrypt_text
from ionik_auth.models import User


class ChatConsumer(AsyncWebsocketConsumer):
    """
    High-performance WebSocket consumer for real-time chat.

    Optimizations:
    - User data cached on connect (no per-message query)
    - ujson for fast JSON serialization
    - Broadcast + DB save run concurrently
    - Single INSERT per message, no SELECT
    """

    async def connect(self):
        self.conversation_id = (
            self.scope['url_route']['kwargs']['conversation_id']
        )
        self.room_group = f'chat_{self.conversation_id}'

        user = self.scope.get('user')
        if not user or user.is_anonymous:
            await self.close()
            return

        is_participant = await self.check_participant(user.id)
        if not is_participant:
            await self.close()
            return

        self.user_data = await self.get_user_data(user.id)

        await self.channel_layer.group_add(
            self.room_group, self.channel_name
        )
        await self.accept()

    async def disconnect(self, close_code):
        await self.channel_layer.group_discard(
            self.room_group, self.channel_name
        )

    async def receive(self, text_data):
        data = ujson.loads(text_data)
        content = data.get('message', '').strip()
        if not content:
            return

        now = timezone.now().isoformat()
        msg_payload = {
            'author': self.user_data,
            'content': content,
            'created_at': now,
        }

        broadcast = self.channel_layer.group_send(
            self.room_group,
            {'type': 'chat_message', 'message': msg_payload},
        )
        save = self.save_message(content)

        results = await asyncio.gather(
            broadcast, save, return_exceptions=True
        )
        if isinstance(results[1], int):
            msg_payload['id'] = results[1]
        elif isinstance(results[1], Exception):
            print(f'Message save error: {results[1]}')

    async def chat_message(self, event):
        await self.send(
            text_data=ujson.dumps(event['message'])
        )

    @database_sync_to_async
    def check_participant(self, user_id):
        return Conversation.objects.filter(
            id=self.conversation_id,
            participants__id=user_id,
        ).exists()

    @database_sync_to_async
    def get_user_data(self, user_id):
        user = User.objects.get(id=user_id)
        avatar_url = ''
        if user.avatar:
            if hasattr(user.avatar, 'url'):
                avatar_url = user.avatar.url
            else:
                avatar_url = str(user.avatar)
        return {
            'id': str(user.id),
            'username': user.username,
            'nickname': user.nickname,
            'avatar': avatar_url,
            'status': user.status,
        }

    @database_sync_to_async
    def save_message(self, plaintext):
        msg = Message.objects.create(
            conversation_id=self.conversation_id,
            author_id=int(self.user_data['id']),
            encrypted_content=encrypt_text(plaintext),
        )
        return msg.id
