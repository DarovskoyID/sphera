import asyncio
import ujson
from django.utils import timezone
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from .models import Conversation, Message, Attachment
from .encryption import encrypt_text
from ionik_auth.models import User


class ChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.conversation_id = self.scope['url_route']['kwargs']['conversation_id']
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

        await self.channel_layer.group_add(self.room_group, self.channel_name)
        await self.accept()

    async def disconnect(self, close_code):
        await self.channel_layer.group_discard(self.room_group, self.channel_name)

    async def receive(self, text_data):
        data = ujson.loads(text_data)
        content = data.get('message', '').strip()
        attachment_ids = data.get('attachment_ids', [])
        if isinstance(attachment_ids, int):
            attachment_ids = [attachment_ids]
        reply_to_id = data.get('reply_to_id')

        if not content and not attachment_ids:
            return

        now = timezone.now().isoformat()

        attachments_data = []
        if attachment_ids:
            attachments_data = await self.get_attachments_data(attachment_ids)

        reply_to_data = None
        if reply_to_id:
            reply_to_data = await self.get_reply_data(int(reply_to_id))

        msg_payload = {
            'author': self.user_data,
            'content': content,
            'created_at': now,
            'attachments': attachments_data,
            'reply_to': reply_to_data,
            'is_pinned': False,
        }

        broadcast = self.channel_layer.group_send(
            self.room_group,
            {'type': 'chat_message', 'message': msg_payload},
        )
        save = self.save_message(content, attachment_ids, reply_to_id)

        results = await asyncio.gather(broadcast, save, return_exceptions=True)
        if isinstance(results[1], int):
            msg_payload['id'] = results[1]
        elif isinstance(results[1], Exception):
            print(f'Message save error: {results[1]}')

    async def chat_message(self, event):
        await self.send(text_data=ujson.dumps(event['message']))

    async def message_deleted(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'message_deleted',
            'id': event['message_id'],
        }))

    async def message_pinned(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'message_pinned',
            'id': event['message_id'],
            'is_pinned': event['is_pinned'],
        }))

    @database_sync_to_async
    def check_participant(self, user_id):
        return Conversation.objects.filter(
            id=self.conversation_id, participants__id=user_id
        ).exists()

    @database_sync_to_async
    def get_user_data(self, user_id):
        user = User.objects.get(id=user_id)
        avatar_url = ''
        if user.avatar:
            avatar_url = user.avatar.url if hasattr(user.avatar, 'url') else str(user.avatar)
        return {
            'id': str(user.id),
            'username': user.username,
            'nickname': user.nickname,
            'avatar': avatar_url,
            'status': user.status,
        }

    @database_sync_to_async
    def get_attachments_data(self, attachment_ids):
        result = []
        for att in Attachment.objects.filter(id__in=attachment_ids, conversation_id=self.conversation_id):
            result.append({
                'id': att.id,
                'filename': att.original_filename,
                'content_type': att.content_type,
                'file_size': att.file_size,
                'url': f'/api/attachments/{att.id}/',
            })
        return result

    @database_sync_to_async
    def get_reply_data(self, reply_to_id):
        try:
            msg = Message.objects.select_related('author').get(
                id=reply_to_id, conversation_id=self.conversation_id
            )
            return {
                'id': msg.id,
                'content': msg.content[:200],
                'author': {
                    'id': str(msg.author.id),
                    'username': msg.author.username,
                    'nickname': msg.author.nickname,
                },
            }
        except Message.DoesNotExist:
            return None

    @database_sync_to_async
    def save_message(self, plaintext, attachment_ids=None, reply_to_id=None):
        msg = Message.objects.create(
            conversation_id=self.conversation_id,
            author_id=int(self.user_data['id']),
            encrypted_content=encrypt_text(plaintext or ''),
            reply_to_id=reply_to_id,
        )
        if attachment_ids:
            Attachment.objects.filter(id__in=attachment_ids).update(message=msg)
        return msg.id
