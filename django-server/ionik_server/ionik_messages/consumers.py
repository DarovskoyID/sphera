import asyncio
import ujson
from datetime import timedelta
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.db.models import Q
from .models import Conversation, Message, Attachment, ScheduledMessage
from .encryption import encrypt_text
from ionik_auth.models import User, BlockedUser


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

        # Start asyncio tasks for any pending scheduled messages
        pending = await self.get_pending_scheduled()
        for item in pending:
            asyncio.ensure_future(self._deliver_scheduled(item['id'], item['send_at']))

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

        # Refuse if either participant has blocked the other
        if await self.is_blocked():
            return

        # Run save + data fetches concurrently so the message gets its real DB id before broadcast
        coros = [self.save_message(content, attachment_ids, reply_to_id)]
        if attachment_ids:
            coros.append(self.get_attachments_data(attachment_ids))
        if reply_to_id:
            coros.append(self.get_reply_data(int(reply_to_id)))

        results = await asyncio.gather(*coros, return_exceptions=True)

        msg_id = results[0] if isinstance(results[0], int) else None
        idx = 1
        attachments_data = []
        if attachment_ids:
            attachments_data = results[idx] if not isinstance(results[idx], Exception) else []
            idx += 1
        reply_to_data = None
        if reply_to_id:
            reply_to_data = results[idx] if not isinstance(results[idx], Exception) else None

        msg_payload = {
            'id': msg_id,
            'author': self.user_data,
            'content': content,
            'created_at': timezone.now().isoformat(),
            'attachments': attachments_data,
            'reply_to': reply_to_data,
            'is_pinned': False,
        }

        await self.channel_layer.group_send(
            self.room_group,
            {'type': 'chat_message', 'message': msg_payload},
        )

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

    async def conversation_deleted(self, event):
        """Tell both clients the conversation was deleted, then close."""
        await self.send(text_data=ujson.dumps({
            'type': 'conversation_deleted',
            'conversation_id': event['conversation_id'],
        }))
        await self.close()

    async def scheduled_message_queued(self, event):
        """Called when a new scheduled message is created via REST API."""
        scheduled_id = event['scheduled_id']
        send_at_str = event['send_at']
        send_at = parse_datetime(send_at_str)
        if send_at:
            asyncio.ensure_future(self._deliver_scheduled(scheduled_id, send_at))

    async def _deliver_scheduled(self, scheduled_id: int, send_at):
        """Sleep until send_at, then deliver the scheduled message."""
        now = timezone.now()
        if send_at.tzinfo is None:
            from django.utils.timezone import make_aware
            send_at = make_aware(send_at)
        delay = (send_at - now).total_seconds()
        if delay > 0:
            await asyncio.sleep(delay)
        payload = await self.deliver_scheduled_message(scheduled_id)
        if payload:
            await self.channel_layer.group_send(
                self.room_group,
                {'type': 'chat_message', 'message': payload},
            )

    @database_sync_to_async
    def get_pending_scheduled(self):
        now = timezone.now()
        # Only take messages that haven't been sent and are within next 24h
        qs = ScheduledMessage.objects.filter(
            conversation_id=self.conversation_id,
            is_sent=False,
            send_at__lte=now + timedelta(hours=24),
        ).values('id', 'send_at')
        return list(qs)

    @database_sync_to_async
    def deliver_scheduled_message(self, scheduled_id: int):
        try:
            msg = ScheduledMessage.objects.select_related(
                'author', 'reply_to', 'reply_to__author'
            ).get(id=scheduled_id, conversation_id=self.conversation_id, is_sent=False)
        except ScheduledMessage.DoesNotExist:
            return None  # Already sent or cancelled

        real_msg = Message.objects.create(
            conversation_id=self.conversation_id,
            author=msg.author,
            encrypted_content=msg.encrypted_content,
            reply_to=msg.reply_to,
        )
        if msg.attachment_ids:
            Attachment.objects.filter(id__in=msg.attachment_ids).update(message=real_msg)

        msg.is_sent = True
        msg.save(update_fields=['is_sent'])

        author = msg.author
        avatar_url = author.avatar.url if author.avatar else ''

        reply_to_data = None
        if msg.reply_to:
            reply_to_data = {
                'id': msg.reply_to.id,
                'content': msg.reply_to.content[:200],
                'author': {
                    'id': str(msg.reply_to.author.id),
                    'username': msg.reply_to.author.username,
                    'nickname': msg.reply_to.author.nickname,
                },
            }

        attachments_data = []
        if msg.attachment_ids:
            for att in Attachment.objects.filter(id__in=msg.attachment_ids):
                attachments_data.append({
                    'id': att.id,
                    'filename': att.original_filename,
                    'content_type': att.content_type,
                    'file_size': att.file_size,
                    'url': f'/api/attachments/{att.id}/',
                })

        return {
            'id': real_msg.id,
            'author': {
                'id': str(author.id),
                'username': author.username,
                'nickname': author.nickname,
                'avatar': avatar_url,
                'status': author.status,
            },
            'content': msg.content,
            'created_at': real_msg.created_at.isoformat(),
            'attachments': attachments_data,
            'reply_to': reply_to_data,
            'is_pinned': False,
        }

    @database_sync_to_async
    def check_participant(self, user_id):
        return Conversation.objects.filter(
            id=self.conversation_id, participants__id=user_id
        ).exists()

    @database_sync_to_async
    def is_blocked(self):
        """True if any participant has blocked another in this conversation."""
        participant_ids = list(
            Conversation.objects.filter(id=self.conversation_id)
            .values_list('participants__id', flat=True)
        )
        return BlockedUser.objects.filter(
            blocker_id__in=participant_ids,
            blocked_id__in=participant_ids,
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
