import asyncio
import uuid
import ujson
from datetime import timedelta
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from .models import (
    Conversation, Message, Attachment, ScheduledMessage,
    Guild, GuildMembership, GuildMessage, GuildAttachment, GuildScheduledMessage,
)
from .encryption import encrypt_text
from sfera_auth.models import User, BlockedUser
from .voice_state import _voice_channels
from sfera_server.metrics import inc as _metrics_inc

WS_AUTH_SUBPROTOCOL = 'ionik.jwt'


def _accepted_subprotocol(scope):
    return WS_AUTH_SUBPROTOCOL if WS_AUTH_SUBPROTOCOL in (scope.get('subprotocols') or []) else None


def _kafka_enabled():
    try:
        from django.conf import settings
        return getattr(settings, 'KAFKA_ENABLED', False)
    except Exception:
        return False


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
        await self.accept(subprotocol=_accepted_subprotocol(self.scope))
        _metrics_inc('ws_connections_total')

        # Start asyncio tasks for any pending scheduled messages
        self._scheduled_tasks = []
        pending = await self.get_pending_scheduled()
        for item in pending:
            task = asyncio.ensure_future(self._deliver_scheduled(item['id'], item['send_at']))
            self._scheduled_tasks.append(task)

        # Mark all incoming (other-author) messages without delivered_at as delivered
        delivered = await self.mark_delivered(user.id)
        if delivered:
            await self.channel_layer.group_send(
                self.room_group,
                {'type': 'message_status', 'ids': delivered, 'field': 'delivered_at', 'ts': timezone.now().isoformat()},
            )

    async def disconnect(self, close_code):
        for task in getattr(self, '_scheduled_tasks', []):
            task.cancel()
        self._scheduled_tasks = []
        await self.channel_layer.group_discard(self.room_group, self.channel_name)

    async def receive(self, text_data):
        _metrics_inc('ws_messages_received')
        data = ujson.loads(text_data)

        # Read-receipt command: client opened the chat, mark unread incoming messages as read
        if data.get('type') == 'mark_read':
            user = self.scope.get('user')
            read = await self.mark_read(user.id)
            if read:
                await self.channel_layer.group_send(
                    self.room_group,
                    {'type': 'message_status', 'ids': read, 'field': 'read_at', 'ts': timezone.now().isoformat()},
                )
            return

        content = data.get('message', '').strip()
        attachment_ids = data.get('attachment_ids', [])
        if isinstance(attachment_ids, int):
            attachment_ids = [attachment_ids]
        reply_to_id = data.get('reply_to_id')
        nonce = data.get('nonce')

        if not content and not attachment_ids:
            return

        # Refuse if either participant has blocked the other
        if await self.is_blocked():
            return

        attachment_ids = await self.validate_attachment_ids(attachment_ids)
        if attachment_ids is None:
            return
        reply_to_data = None
        if reply_to_id:
            reply_to_data = await self.get_reply_data(reply_to_id)
            if reply_to_data is None:
                return

        # Generate message UUID up front so both Kafka and WS broadcast use the same ID
        msg_id = str(uuid.uuid4())

        if _kafka_enabled():
            # Fast path: broadcast via Redis immediately, persist via Kafka async
            from .kafka_producer import publish_chat_message, publish_chat_notification

            attachments_data = []
            if attachment_ids:
                attachments_data = await self.get_attachments_data(attachment_ids)
            now = timezone.now().isoformat()
            msg_payload = {
                'id': msg_id,
                'author': self.user_data,
                'content': content,
                'created_at': now,
                'attachments': attachments_data,
                'reply_to': reply_to_data,
                'is_pinned': False,
            }
            if nonce:
                msg_payload['nonce'] = nonce

            # 1) Broadcast to all WS clients via Redis pub/sub (instant)
            await self.channel_layer.group_send(
                self.room_group,
                {'type': 'chat_message', 'message': msg_payload},
            )

            # 2) Publish to Kafka for DB persistence (async, durable)
            publish_chat_message(str(self.conversation_id), {
                'msg_id': msg_id,
                'conversation_id': str(self.conversation_id),
                'author_id': self.user_data['id'],
                'content': content,
                'attachment_ids': attachment_ids,
                'reply_to_id': reply_to_id,
            })

            # 3) Push notifications via Kafka
            sender_name = self.user_data.get('nickname') or self.user_data.get('username', '')
            notif_content = content if content else ('\U0001f4ce Attachment' if attachment_ids else '')
            other_ids = await self.get_other_participant_ids()

            # Signaling WS notification (real-time)
            notification = {
                'type': 'new_message_notification',
                'sender_id': self.user_data.get('id', ''),
                'sender_name': sender_name,
                'content': notif_content,
            }
            for pid in other_ids:
                await self.channel_layer.group_send(
                    f'user_{pid}',
                    {'type': 'new.message.notification', 'data': notification},
                )

            # FCM push via Kafka
            publish_chat_notification({
                'user_ids': other_ids,
                'payload': {
                    'type': 'message',
                    'sender_name': sender_name,
                    'content': notif_content,
                },
            })
        else:
            # Fallback: original synchronous path (no Kafka)
            coros = [self.save_message(content, attachment_ids, reply_to_id, msg_id)]
            if attachment_ids:
                coros.append(self.get_attachments_data(attachment_ids))
            if reply_to_id:
                coros.append(self.get_reply_data(reply_to_id))

            results = await asyncio.gather(*coros, return_exceptions=True)

            saved_id = results[0] if not isinstance(results[0], Exception) else msg_id
            idx = 1
            attachments_data = []
            if attachment_ids:
                attachments_data = results[idx] if not isinstance(results[idx], Exception) else []
                idx += 1
            if reply_to_id:
                reply_to_data = results[idx] if not isinstance(results[idx], Exception) else None

            msg_payload = {
                'id': str(saved_id),
                'author': self.user_data,
                'content': content,
                'created_at': timezone.now().isoformat(),
                'attachments': attachments_data,
                'reply_to': reply_to_data,
                'is_pinned': False,
            }
            if nonce:
                msg_payload['nonce'] = nonce

            await self.channel_layer.group_send(
                self.room_group,
                {'type': 'chat_message', 'message': msg_payload},
            )

            # Push notifications
            sender_name = self.user_data.get('nickname') or self.user_data.get('username', '')
            notif_content = content if content else ('\U0001f4ce Attachment' if attachment_ids else '')
            notification = {
                'type': 'new_message_notification',
                'sender_id': self.user_data.get('id', ''),
                'sender_name': sender_name,
                'content': notif_content,
            }
            other_ids = await self.get_other_participant_ids()
            for pid in other_ids:
                await self.channel_layer.group_send(
                    f'user_{pid}',
                    {'type': 'new.message.notification', 'data': notification},
                )
            await self.push_fcm_to_users(other_ids, {
                'type': 'message',
                'sender_name': sender_name,
                'content': notif_content,
            })

    async def chat_message(self, event):
        _metrics_inc('ws_messages_sent')
        await self.send(text_data=ujson.dumps(event['message']))

    async def message_status(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'message_status',
            'ids': event['ids'],
            'field': event['field'],
            'ts': event['ts'],
        }))

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

    async def todo_update(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'todo_update',
            'message_id': event['message_id'],
            'todo': event['todo'],
        }))

    async def message_edited(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'message_edited',
            'message': event['message'],
        }))

    async def location_update(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'location_update',
            'message_id': event['message_id'],
            'location': event['location'],
        }))

    async def conversation_deleted(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'conversation_deleted',
            'conversation_id': event['conversation_id'],
        }))
        await self.close()

    async def scheduled_message_queued(self, event):
        scheduled_id = event['scheduled_id']
        send_at_str = event['send_at']
        send_at = parse_datetime(send_at_str)
        if send_at:
            task = asyncio.ensure_future(self._deliver_scheduled(scheduled_id, send_at))
            if not hasattr(self, '_scheduled_tasks'):
                self._scheduled_tasks = []
            self._scheduled_tasks = [t for t in self._scheduled_tasks if not t.done()]
            self._scheduled_tasks.append(task)

    async def _deliver_scheduled(self, scheduled_id, send_at):
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
        qs = ScheduledMessage.objects.filter(
            conversation_id=self.conversation_id,
            is_sent=False,
            send_at__lte=now + timedelta(hours=24),
        ).values('id', 'send_at')
        return list(qs)

    @database_sync_to_async
    def deliver_scheduled_message(self, scheduled_id):
        try:
            msg = ScheduledMessage.objects.select_related(
                'author', 'reply_to', 'reply_to__author'
            ).get(id=scheduled_id, conversation_id=self.conversation_id, is_sent=False)
        except ScheduledMessage.DoesNotExist:
            return None

        real_msg = Message.objects.create(
            conversation_id=self.conversation_id,
            author=msg.author,
            encrypted_content=msg.encrypted_content,
            reply_to=msg.reply_to,
        )
        if msg.attachment_ids:
            Attachment.objects.filter(
                id__in=msg.attachment_ids,
                conversation_id=self.conversation_id,
                uploader=msg.author,
                message__isnull=True,
            ).update(message=real_msg)

        msg.is_sent = True
        msg.save(update_fields=['is_sent'])

        author = msg.author
        avatar_url = author.avatar.url if author.avatar else ''

        reply_to_data = None
        if msg.reply_to:
            reply_to_data = {
                'id': str(msg.reply_to.id),
                'content': msg.reply_to.content[:200],
                'author': {
                    'id': str(msg.reply_to.author.id),
                    'username': msg.reply_to.author.username,
                    'nickname': msg.reply_to.author.nickname,
                },
            }

        attachments_data = []
        if msg.attachment_ids:
            for att in Attachment.objects.filter(id__in=msg.attachment_ids, message=real_msg):
                attachments_data.append({
                    'id': str(att.id),
                    'filename': att.original_filename,
                    'content_type': att.content_type,
                    'file_size': att.file_size,
                    'url': f'/api/attachments/{att.id}/',
                })

        return {
            'id': str(real_msg.id),
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
    def push_fcm_to_users(self, user_ids, data):
        try:
            from sfera_server.fcm import send_to_user
            for uid in user_ids:
                send_to_user(uid, data)
        except Exception:
            pass

    @database_sync_to_async
    def mark_delivered(self, user_id):
        qs = Message.objects.filter(
            conversation_id=self.conversation_id,
            delivered_at__isnull=True,
        ).exclude(author_id=user_id)
        ids = [str(mid) for mid in qs.values_list('id', flat=True)]
        if ids:
            qs.update(delivered_at=timezone.now())
        return ids

    @database_sync_to_async
    def mark_read(self, user_id):
        qs = Message.objects.filter(
            conversation_id=self.conversation_id,
            read_at__isnull=True,
        ).exclude(author_id=user_id)
        ids = [str(mid) for mid in qs.values_list('id', flat=True)]
        if ids:
            now = timezone.now()
            Message.objects.filter(id__in=ids, delivered_at__isnull=True).update(delivered_at=now)
            qs.update(read_at=now)
        return ids

    @database_sync_to_async
    def get_other_participant_ids(self):
        ids = list(
            Conversation.objects.filter(id=self.conversation_id)
            .values_list('participants__id', flat=True)
        )
        return [str(pid) for pid in ids if str(pid) != str(self.user_data['id'])]

    @database_sync_to_async
    def check_participant(self, user_id):
        return Conversation.objects.filter(
            id=self.conversation_id, participants__id=user_id
        ).exists()

    @database_sync_to_async
    def is_blocked(self):
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
                'id': str(att.id),
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
                'id': str(msg.id),
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
    def validate_attachment_ids(self, attachment_ids):
        if not attachment_ids:
            return []
        if not isinstance(attachment_ids, list) or len(attachment_ids) > 15:
            return None
        try:
            normalized = [str(uuid.UUID(str(item))) for item in attachment_ids]
        except (TypeError, ValueError):
            return None
        found = set(
            str(item) for item in Attachment.objects.filter(
                id__in=normalized,
                conversation_id=self.conversation_id,
                uploader_id=self.user_data['id'],
                message__isnull=True,
            ).values_list('id', flat=True)
        )
        if found != set(normalized):
            return None
        return normalized

    @database_sync_to_async
    def save_message(self, plaintext, attachment_ids=None, reply_to_id=None, msg_id=None):
        kwargs = dict(
            conversation_id=self.conversation_id,
            author_id=self.user_data['id'],
            encrypted_content=encrypt_text(plaintext or ''),
            reply_to_id=reply_to_id,
        )
        if msg_id:
            kwargs['id'] = msg_id
        msg = Message.objects.create(**kwargs)
        if attachment_ids:
            Attachment.objects.filter(
                id__in=attachment_ids,
                conversation_id=self.conversation_id,
                uploader_id=self.user_data['id'],
                message__isnull=True,
            ).update(message=msg)
        return str(msg.id)


class GuildChannelConsumer(AsyncWebsocketConsumer):
    """WebSocket consumer for guild text channels."""

    async def connect(self):
        self.guild_id = str(self.scope['url_route']['kwargs']['guild_id'])
        self.channel_id = str(self.scope['url_route']['kwargs']['channel_id'])
        self.room_group = f'guild_channel_{self.channel_id}'
        self.guild_group = f'guild_{self.guild_id}'

        user = self.scope.get('user')
        if not user or user.is_anonymous:
            await self.close()
            return

        is_member = await self.check_membership(user.id)
        if not is_member:
            await self.close()
            return

        self.user_data = await self.get_user_data(user.id)

        await self.channel_layer.group_add(self.room_group, self.channel_name)
        await self.channel_layer.group_add(self.guild_group, self.channel_name)
        await self.accept(subprotocol=_accepted_subprotocol(self.scope))

        # Send current voice presence snapshot for this guild's voice channels only
        for ch_id, ch_data in _voice_channels.items():
            if ch_data.get('_guild_id') != self.guild_id:
                continue
            members = [v for k, v in ch_data.items() if k != '_guild_id']
            if members:
                await self.send(text_data=ujson.dumps({
                    'type': 'voice_presence_update',
                    'channel_id': ch_id,
                    'participants': members,
                }))

        # Deliver any pending scheduled messages
        self._scheduled_tasks = []
        pending = await self.get_pending_scheduled()
        for item in pending:
            task = asyncio.ensure_future(
                self._deliver_scheduled(item['id'], item['send_at'])
            )
            self._scheduled_tasks.append(task)

    async def disconnect(self, close_code):
        for task in getattr(self, '_scheduled_tasks', []):
            task.cancel()
        self._scheduled_tasks = []
        await self.channel_layer.group_discard(self.room_group, self.channel_name)
        await self.channel_layer.group_discard(self.guild_group, self.channel_name)

    @database_sync_to_async
    def is_muted(self):
        from django.utils import timezone
        try:
            membership = GuildMembership.objects.get(guild_id=self.guild_id, user_id=self.user_data['id'])
            return membership.muted_until and membership.muted_until > timezone.now()
        except GuildMembership.DoesNotExist:
            return False

    @database_sync_to_async
    def is_personal_channel_restricted(self):
        try:
            guild = Guild.objects.get(id=self.guild_id)
            if not guild.is_personal_channel:
                return False
            return str(guild.owner_id) != self.user_data['id']
        except Guild.DoesNotExist:
            return False

    async def receive(self, text_data):
        data = ujson.loads(text_data)
        content = data.get('message', '').strip()
        reply_to_id = data.get('reply_to_id')
        attachment_ids = data.get('attachment_ids', [])
        nonce = data.get('nonce')
        if isinstance(attachment_ids, int):
            attachment_ids = [attachment_ids]

        if not content and not attachment_ids:
            return

        if await self.is_muted():
            await self.send(text_data=ujson.dumps({'type': 'error', 'message': 'You are muted'}))
            return

        if await self.is_personal_channel_restricted():
            await self.send(text_data=ujson.dumps({'type': 'error', 'message': 'Only the channel owner can post'}))
            return

        attachment_ids = await self.validate_attachment_ids(attachment_ids)
        if attachment_ids is None:
            return
        reply_to_data = None
        if reply_to_id:
            reply_to_data = await self.get_reply_data(reply_to_id)
            if reply_to_data is None:
                return

        msg_id = str(uuid.uuid4())

        if _kafka_enabled():
            from .kafka_producer import publish_guild_message, publish_guild_notification

            attachments_data = []
            if attachment_ids:
                attachments_data = await self.get_attachments_data(attachment_ids)
            msg_payload = {
                'id': msg_id,
                'author': self.user_data,
                'content': content,
                'created_at': timezone.now().isoformat(),
                'reply_to': reply_to_data,
                'attachments': attachments_data,
                'is_pinned': False,
            }
            if nonce:
                msg_payload['nonce'] = nonce

            # 1) Broadcast instantly via Redis
            await self.channel_layer.group_send(
                self.room_group,
                {'type': 'chat_message', 'message': msg_payload},
            )

            # 2) Persist via Kafka
            publish_guild_message(self.channel_id, {
                'msg_id': msg_id,
                'channel_id': self.channel_id,
                'author_id': self.user_data['id'],
                'content': content,
                'attachment_ids': attachment_ids,
                'reply_to_id': reply_to_id,
            })

            # 3) FCM push via Kafka
            sender_name = self.user_data.get('nickname') or self.user_data.get('username', '')
            member_ids = await self.get_guild_member_ids_except_self()
            publish_guild_notification({
                'user_ids': member_ids,
                'payload': {
                    'type': 'message',
                    'sender_name': sender_name,
                    'content': content,
                },
            })
        else:
            # Fallback: synchronous path
            saved_id = await self.save_message(content, reply_to_id, attachment_ids, msg_id)
            if reply_to_id:
                reply_to_data = await self.get_reply_data(reply_to_id)
            attachments_data = []
            if attachment_ids:
                attachments_data = await self.get_attachments_data(attachment_ids)

            msg_payload = {
                'id': saved_id,
                'author': self.user_data,
                'content': content,
                'created_at': timezone.now().isoformat(),
                'reply_to': reply_to_data,
                'attachments': attachments_data,
                'is_pinned': False,
            }
            if nonce:
                msg_payload['nonce'] = nonce

            await self.channel_layer.group_send(
                self.room_group,
                {'type': 'chat_message', 'message': msg_payload},
            )

            sender_name = self.user_data.get('nickname') or self.user_data.get('username', '')
            member_ids = await self.get_guild_member_ids_except_self()
            await self.push_fcm_to_users(member_ids, {
                'type': 'message',
                'sender_name': sender_name,
                'content': content,
            })

    async def guild_scheduled_queued(self, event):
        from django.utils.timezone import make_aware
        scheduled_id = event['scheduled_id']
        send_at = parse_datetime(event['send_at'])
        if send_at and send_at.tzinfo is None:
            send_at = make_aware(send_at)
        if send_at:
            task = asyncio.ensure_future(self._deliver_scheduled(scheduled_id, send_at))
            if not hasattr(self, '_scheduled_tasks'):
                self._scheduled_tasks = []
            self._scheduled_tasks = [t for t in self._scheduled_tasks if not t.done()]
            self._scheduled_tasks.append(task)

    async def _deliver_scheduled(self, scheduled_id, send_at):
        now = timezone.now()
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
    def push_fcm_to_users(self, user_ids, data):
        try:
            from sfera_server.fcm import send_to_user
            for uid in user_ids:
                send_to_user(uid, data)
        except Exception:
            pass

    @database_sync_to_async
    def get_guild_member_ids_except_self(self):
        from sfera_messages.models import GuildMembership
        ids = list(
            GuildMembership.objects.filter(guild_id=self.guild_id)
            .exclude(user_id=self.user_data['id'])
            .values_list('user_id', flat=True)
        )
        return [str(uid) for uid in ids]

    @database_sync_to_async
    def get_pending_scheduled(self):
        now = timezone.now()
        qs = GuildScheduledMessage.objects.filter(
            channel_id=self.channel_id,
            is_sent=False,
            send_at__lte=now + timedelta(hours=24),
        ).values('id', 'send_at')
        return list(qs)

    @database_sync_to_async
    def deliver_scheduled_message(self, scheduled_id):
        try:
            sched = GuildScheduledMessage.objects.select_related(
                'author', 'reply_to', 'reply_to__author'
            ).get(id=scheduled_id, channel_id=self.channel_id, is_sent=False)
        except GuildScheduledMessage.DoesNotExist:
            return None

        real_msg = GuildMessage.objects.create(
            channel_id=self.channel_id,
            author=sched.author,
            encrypted_content=sched.encrypted_content,
            reply_to=sched.reply_to,
        )
        if sched.attachment_ids:
            GuildAttachment.objects.filter(
                id__in=sched.attachment_ids,
                channel_id=self.channel_id,
                uploader=sched.author,
                message__isnull=True,
            ).update(message=real_msg)
        from .search_index import index_message
        index_message(real_msg)

        sched.is_sent = True
        sched.save(update_fields=['is_sent'])

        author = sched.author
        reply_to_data = None
        if sched.reply_to:
            reply_to_data = {
                'id': str(sched.reply_to.id),
                'content': sched.reply_to.content[:200],
                'author': {
                    'id': str(sched.reply_to.author.id),
                    'username': sched.reply_to.author.username,
                    'nickname': sched.reply_to.author.nickname or '',
                },
            }

        attachments_data = []
        if sched.attachment_ids:
            for att in GuildAttachment.objects.filter(id__in=sched.attachment_ids, message=real_msg):
                attachments_data.append({
                    'id': str(att.id),
                    'filename': att.original_filename,
                    'content_type': att.content_type,
                    'file_size': att.file_size,
                    'url': f'/api/guild-attachments/{att.id}/',
                })

        return {
            'id': str(real_msg.id),
            'author': {
                'id': str(author.id),
                'username': author.username,
                'nickname': author.nickname or '',
                'avatar': author.avatar.url if author.avatar else '',
                'status': author.status,
            },
            'content': sched.content,
            'created_at': real_msg.created_at.isoformat(),
            'attachments': attachments_data,
            'reply_to': reply_to_data,
            'is_pinned': False,
        }

    async def chat_message(self, event):
        await self.send(text_data=ujson.dumps(event['message']))

    async def message_deleted(self, event):
        await self.send(text_data=ujson.dumps({'type': 'message_deleted', 'id': event['id']}))

    async def message_pinned(self, event):
        await self.send(text_data=ujson.dumps({'type': 'message_pinned', 'id': event['id'], 'is_pinned': event['is_pinned']}))

    async def reaction_update(self, event):
        await self.send(text_data=ujson.dumps({'type': 'reaction_update', 'message_id': event['message_id'], 'reactions': event['reactions']}))

    async def poll_update(self, event):
        # `poll` carries no per-user flags (see rich.poll_view) — each client keeps
        # its own selection locally, so one payload is safe to fan out.
        await self.send(text_data=ujson.dumps({'type': 'poll_update', 'message_id': event['message_id'], 'poll': event['poll']}))

    async def todo_update(self, event):
        await self.send(text_data=ujson.dumps({'type': 'todo_update', 'message_id': event['message_id'], 'todo': event['todo']}))

    async def message_edited(self, event):
        await self.send(text_data=ujson.dumps({'type': 'message_edited', 'message': event['message']}))

    async def location_update(self, event):
        await self.send(text_data=ujson.dumps({'type': 'location_update', 'message_id': event['message_id'], 'location': event['location']}))

    async def comment_added(self, event):
        await self.send(text_data=ujson.dumps({'type': 'comment_added', 'message_id': event['message_id'], 'comment': event['comment']}))

    async def comment_deleted(self, event):
        await self.send(text_data=ujson.dumps({'type': 'comment_deleted', 'message_id': event['message_id'], 'comment_id': event['comment_id']}))

    # ── Guild-level events (received via guild_group) ──

    async def guild_deleted(self, event):
        await self.send(text_data=ujson.dumps({'type': 'guild_deleted', 'guild_id': event['guild_id']}))
        await self.close()

    async def member_joined(self, event):
        await self.send(text_data=ujson.dumps({'type': 'member_joined', 'member': event['member']}))

    async def member_left(self, event):
        await self.send(text_data=ujson.dumps({'type': 'member_left', 'user_id': event['user_id']}))

    async def member_kicked(self, event):
        await self.send(text_data=ujson.dumps({'type': 'member_kicked', 'user_id': event['user_id'], 'guild_name': event.get('guild_name', '')}))

    async def channel_created(self, event):
        await self.send(text_data=ujson.dumps({'type': 'channel_created', 'channel': event['channel']}))

    async def channel_deleted(self, event):
        await self.send(text_data=ujson.dumps({'type': 'channel_deleted', 'channel_id': event['channel_id']}))

    async def channel_updated(self, event):
        await self.send(text_data=ujson.dumps({'type': 'channel_updated', 'channel': event['channel']}))

    async def category_created(self, event):
        await self.send(text_data=ujson.dumps({'type': 'category_created', 'category': event['category']}))

    async def category_deleted(self, event):
        await self.send(text_data=ujson.dumps({'type': 'category_deleted', 'category_id': event['category_id']}))

    async def voice_presence_update(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'voice_presence_update',
            'channel_id': event['channel_id'],
            'participants': event['participants'],
        }))

    async def member_muted(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'member_muted',
            'user_id': event['user_id'],
            'muted_until': event['muted_until'],
        }))

    async def member_roles_changed(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'member_roles_changed',
            'user_id': event['user_id'],
            'custom_roles': event['custom_roles'],
        }))

    async def member_role_changed(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'member_role_changed',
            'user_id': event['user_id'],
            'role': event['role'],
        }))

    @database_sync_to_async
    def check_membership(self, user_id):
        return GuildMembership.objects.filter(guild_id=self.guild_id, user_id=user_id).exists()

    @database_sync_to_async
    def get_user_data(self, user_id):
        user = User.objects.get(id=user_id)
        nickname = ''
        try:
            m = GuildMembership.objects.get(guild_id=self.guild_id, user_id=user_id)
            nickname = m.nickname or user.nickname or ''
        except GuildMembership.DoesNotExist:
            nickname = user.nickname or ''
        return {
            'id': str(user.id),
            'username': user.username,
            'nickname': nickname,
            'avatar': user.avatar.url if user.avatar else '',
            'status': user.status,
        }

    @database_sync_to_async
    def save_message(self, plaintext, reply_to_id=None, attachment_ids=None, msg_id=None):
        kwargs = dict(
            channel_id=self.channel_id,
            author_id=self.user_data['id'],
            encrypted_content=encrypt_text(plaintext or ''),
            reply_to_id=reply_to_id,
        )
        if msg_id:
            kwargs['id'] = msg_id
        msg = GuildMessage.objects.create(**kwargs)
        if attachment_ids:
            GuildAttachment.objects.filter(
                id__in=attachment_ids,
                channel_id=self.channel_id,
                uploader_id=self.user_data['id'],
                message__isnull=True,
            ).update(message=msg)
        from .search_index import index_message
        index_message(msg)
        return str(msg.id)

    @database_sync_to_async
    def get_attachments_data(self, attachment_ids):
        result = []
        for att in GuildAttachment.objects.filter(
            id__in=attachment_ids, channel_id=self.channel_id
        ):
            result.append({
                'id': str(att.id),
                'filename': att.original_filename,
                'content_type': att.content_type,
                'file_size': att.file_size,
                'url': f'/api/guild-attachments/{att.id}/',
            })
        return result

    @database_sync_to_async
    def get_reply_data(self, reply_to_id):
        try:
            msg = GuildMessage.objects.select_related('author').get(
                id=reply_to_id, channel_id=self.channel_id
            )
            return {
                'id': str(msg.id),
                'content': msg.content[:200],
                'author': {'id': str(msg.author.id), 'username': msg.author.username, 'nickname': msg.author.nickname or ''},
            }
        except GuildMessage.DoesNotExist:
            return None

    @database_sync_to_async
    def validate_attachment_ids(self, attachment_ids):
        if not attachment_ids:
            return []
        if not isinstance(attachment_ids, list) or len(attachment_ids) > 15:
            return None
        try:
            normalized = [str(uuid.UUID(str(item))) for item in attachment_ids]
        except (TypeError, ValueError):
            return None
        found = set(
            str(item) for item in GuildAttachment.objects.filter(
                id__in=normalized,
                channel_id=self.channel_id,
                uploader_id=self.user_data['id'],
                message__isnull=True,
            ).values_list('id', flat=True)
        )
        if found != set(normalized):
            return None
        return normalized


class GuildPresenceConsumer(AsyncWebsocketConsumer):
    """Guild-level WS: subscribes to guild group only (no channel).
    Used when a user has selected a guild but hasn't opened any channel,
    so they still receive member join/leave/kick and channel events.
    """

    async def connect(self):
        self.guild_id = str(self.scope['url_route']['kwargs']['guild_id'])
        self.guild_group = f'guild_{self.guild_id}'

        user = self.scope.get('user')
        if not user or user.is_anonymous:
            await self.close()
            return

        # Accept any authenticated user even if they aren't a member yet — the client
        # may open a guild it hasn't joined. Only members are subscribed to guild
        # events; non-members simply receive nothing instead of a handshake 403 (which
        # the client retries, flooding the console).
        await self.accept(subprotocol=_accepted_subprotocol(self.scope))
        if await self._check_membership(user.id):
            await self.channel_layer.group_add(self.guild_group, self.channel_name)

    async def disconnect(self, close_code):
        await self.channel_layer.group_discard(self.guild_group, self.channel_name)

    async def receive(self, text_data):
        pass

    async def guild_deleted(self, event):
        await self.send(text_data=ujson.dumps({'type': 'guild_deleted', 'guild_id': event['guild_id']}))
        await self.close()

    async def member_joined(self, event):
        await self.send(text_data=ujson.dumps({'type': 'member_joined', 'member': event['member']}))

    async def member_left(self, event):
        await self.send(text_data=ujson.dumps({'type': 'member_left', 'user_id': event['user_id']}))

    async def member_kicked(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'member_kicked',
            'user_id': event['user_id'],
            'guild_name': event.get('guild_name', ''),
        }))

    async def channel_created(self, event):
        await self.send(text_data=ujson.dumps({'type': 'channel_created', 'channel': event['channel']}))

    async def channel_deleted(self, event):
        await self.send(text_data=ujson.dumps({'type': 'channel_deleted', 'channel_id': event['channel_id']}))

    async def channel_updated(self, event):
        await self.send(text_data=ujson.dumps({'type': 'channel_updated', 'channel': event['channel']}))

    async def category_created(self, event):
        await self.send(text_data=ujson.dumps({'type': 'category_created', 'category': event['category']}))

    async def category_deleted(self, event):
        await self.send(text_data=ujson.dumps({'type': 'category_deleted', 'category_id': event['category_id']}))

    async def voice_presence_update(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'voice_presence_update',
            'channel_id': event['channel_id'],
            'participants': event['participants'],
        }))

    async def member_role_updated(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'member_role_updated',
            'user_id': event['user_id'],
            'role': event['role'],
        }))

    async def member_muted(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'member_muted',
            'user_id': event['user_id'],
            'muted_until': event['muted_until'],
        }))

    async def member_roles_changed(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'member_roles_changed',
            'user_id': event['user_id'],
            'custom_roles': event['custom_roles'],
        }))

    async def member_role_changed(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'member_role_changed',
            'user_id': event['user_id'],
            'role': event['role'],
        }))

    @database_sync_to_async
    def _check_membership(self, user_id):
        return GuildMembership.objects.filter(guild_id=self.guild_id, user_id=user_id).exists()


class GuildVoiceConsumer(AsyncWebsocketConsumer):
    """Presence-only consumer for guild voice channels.
    Tracks who is in the channel and relays WebRTC signaling between them.
    """

    async def connect(self):
        self.guild_id = str(self.scope['url_route']['kwargs']['guild_id'])
        self.channel_id = str(self.scope['url_route']['kwargs']['channel_id'])
        self.room_group = f'guild_voice_{self.channel_id}'

        user = self.scope.get('user')
        if not user or user.is_anonymous:
            await self.close()
            return

        is_member = await self.check_membership(user.id)
        if not is_member:
            await self.close()
            return

        self.user_info = await self.get_user_info(user.id)
        self.user_id = str(user.id)

        user_limit = await self._get_user_limit()
        if user_limit and user_limit > 0:
            current_count = len([k for k in _voice_channels.get(self.channel_id, {}) if k != '_guild_id'])
            if current_count >= user_limit:
                await self.close()
                return

        await self.channel_layer.group_add(self.room_group, self.channel_name)
        await self.accept(subprotocol=_accepted_subprotocol(self.scope))

        if self.channel_id not in _voice_channels:
            _voice_channels[self.channel_id] = {'_guild_id': self.guild_id}
        _voice_channels[self.channel_id][self.user_id] = self.user_info

        participants = [v for k, v in _voice_channels[self.channel_id].items() if k != '_guild_id']
        await self.send(text_data=ujson.dumps({
            'type': 'voice_participants',
            'participants': participants,
        }))

        await self.channel_layer.group_send(
            self.room_group,
            {'type': 'voice_user_joined', 'user': self.user_info, 'from_user': self.user_id},
        )

        guild_group = f'guild_{self.guild_id}'
        all_participants = [v for k, v in _voice_channels[self.channel_id].items() if k != '_guild_id']
        await self.channel_layer.group_send(
            guild_group,
            {
                'type': 'voice_presence_update',
                'channel_id': self.channel_id,
                'participants': all_participants,
            },
        )

    async def disconnect(self, close_code):
        if not getattr(self, 'user_id', None):
            await self.channel_layer.group_discard(self.room_group, self.channel_name)
            return

        if self.channel_id in _voice_channels:
            _voice_channels[self.channel_id].pop(self.user_id, None)
            if set(_voice_channels[self.channel_id].keys()) <= {'_guild_id'}:
                del _voice_channels[self.channel_id]

        await self.channel_layer.group_discard(self.room_group, self.channel_name)

        await self.channel_layer.group_send(
            self.room_group,
            {'type': 'voice_user_left', 'user_id': self.user_id},
        )

        guild_group = f'guild_{self.guild_id}'
        remaining = [v for k, v in _voice_channels.get(self.channel_id, {}).items() if k != '_guild_id']
        await self.channel_layer.group_send(
            guild_group,
            {
                'type': 'voice_presence_update',
                'channel_id': self.channel_id,
                'participants': remaining,
            },
        )

    async def receive(self, text_data):
        data = ujson.loads(text_data)
        msg_type = data.get('type')

        if msg_type == 'voice_mute':
            muted = bool(data.get('muted', False))
            if self.channel_id in _voice_channels and self.user_id in _voice_channels[self.channel_id]:
                _voice_channels[self.channel_id][self.user_id]['muted'] = muted
            await self.channel_layer.group_send(
                self.room_group,
                {'type': 'voice_mute_changed', 'user_id': self.user_id, 'muted': muted},
            )

        elif msg_type == 'voice_deafen':
            deafened = bool(data.get('deafened', False))
            if self.channel_id in _voice_channels and self.user_id in _voice_channels[self.channel_id]:
                _voice_channels[self.channel_id][self.user_id]['deafened'] = deafened
            await self.channel_layer.group_send(
                self.room_group,
                {'type': 'voice_deafen_changed', 'user_id': self.user_id, 'deafened': deafened},
            )

        elif msg_type == 'signal':
            target_id = str(data.get('to', ''))
            await self.channel_layer.group_send(
                self.room_group,
                {
                    'type': 'voice_signal',
                    'from_user': self.user_id,
                    'to_user': target_id,
                    'payload': data.get('payload'),
                },
            )

    async def voice_user_joined(self, event):
        if event['from_user'] == self.user_id:
            return
        await self.send(text_data=ujson.dumps({
            'type': 'voice_user_joined',
            'user': event['user'],
        }))

    async def voice_user_left(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'voice_user_left',
            'user_id': event['user_id'],
        }))

    async def voice_mute_changed(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'voice_mute_changed',
            'user_id': event['user_id'],
            'muted': event['muted'],
        }))

    async def voice_deafen_changed(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'voice_deafen_changed',
            'user_id': event['user_id'],
            'deafened': event['deafened'],
        }))

    async def voice_signal(self, event):
        if event['to_user'] != self.user_id:
            return
        await self.send(text_data=ujson.dumps({
            'type': 'signal',
            'from': event['from_user'],
            'payload': event['payload'],
        }))

    @database_sync_to_async
    def check_membership(self, user_id):
        return GuildMembership.objects.filter(
            guild_id=self.guild_id, user_id=user_id
        ).exists()

    @database_sync_to_async
    def _get_user_limit(self):
        from .models import GuildChannel
        try:
            return GuildChannel.objects.get(id=self.channel_id).user_limit
        except GuildChannel.DoesNotExist:
            return 0

    @database_sync_to_async
    def get_user_info(self, user_id):
        user = User.objects.get(id=user_id)
        return {
            'id': str(user.id),
            'username': user.username,
            'nickname': user.nickname or '',
            'avatar': user.avatar.url if user.avatar else '',
            'muted': False,
        }
