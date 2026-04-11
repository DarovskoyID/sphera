import asyncio
import ujson
from datetime import timedelta
from django.utils import timezone
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from .models import (
    Conversation, Message, Attachment, ScheduledMessage,
    GuildMembership, GuildMessage, GuildAttachment, GuildScheduledMessage,
)
from .encryption import encrypt_text
from ionik_auth.models import User, BlockedUser
from .voice_state import _voice_channels


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


class GuildChannelConsumer(AsyncWebsocketConsumer):
    """WebSocket consumer for guild text channels."""

    async def connect(self):
        self.guild_id = self.scope['url_route']['kwargs']['guild_id']
        self.channel_id = self.scope['url_route']['kwargs']['channel_id']
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
        await self.accept()

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
        pending = await self.get_pending_scheduled()
        for item in pending:
            asyncio.ensure_future(
                self._deliver_scheduled(item['id'], item['send_at'])
            )

    async def disconnect(self, close_code):
        await self.channel_layer.group_discard(self.room_group, self.channel_name)
        await self.channel_layer.group_discard(self.guild_group, self.channel_name)

    async def receive(self, text_data):
        data = ujson.loads(text_data)
        content = data.get('message', '').strip()
        reply_to_id = data.get('reply_to_id')
        attachment_ids = data.get('attachment_ids', [])
        if isinstance(attachment_ids, int):
            attachment_ids = [attachment_ids]

        if not content and not attachment_ids:
            return

        msg_id = await self.save_message(content, reply_to_id, attachment_ids)
        reply_to_data = None
        if reply_to_id:
            reply_to_data = await self.get_reply_data(int(reply_to_id))
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

        await self.channel_layer.group_send(
            self.room_group,
            {'type': 'chat_message', 'message': msg_payload},
        )

    async def guild_scheduled_queued(self, event):
        from django.utils.timezone import make_aware
        from django.utils.dateparse import parse_datetime
        scheduled_id = event['scheduled_id']
        send_at = parse_datetime(event['send_at'])
        if send_at and send_at.tzinfo is None:
            send_at = make_aware(send_at)
        if send_at:
            asyncio.ensure_future(self._deliver_scheduled(scheduled_id, send_at))

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
                id__in=sched.attachment_ids
            ).update(message=real_msg)

        sched.is_sent = True
        sched.save(update_fields=['is_sent'])

        author = sched.author
        reply_to_data = None
        if sched.reply_to:
            reply_to_data = {
                'id': sched.reply_to.id,
                'content': sched.reply_to.content[:200],
                'author': {
                    'id': str(sched.reply_to.author.id),
                    'username': sched.reply_to.author.username,
                    'nickname': sched.reply_to.author.nickname or '',
                },
            }

        attachments_data = []
        if sched.attachment_ids:
            for att in GuildAttachment.objects.filter(id__in=sched.attachment_ids):
                attachments_data.append({
                    'id': att.id,
                    'filename': att.original_filename,
                    'content_type': att.content_type,
                    'file_size': att.file_size,
                    'url': f'/api/guild-attachments/{att.id}/',
                })

        return {
            'id': real_msg.id,
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

    async def voice_presence_update(self, event):
        await self.send(text_data=ujson.dumps({
            'type': 'voice_presence_update',
            'channel_id': event['channel_id'],
            'participants': event['participants'],
        }))

    @database_sync_to_async
    def check_membership(self, user_id):
        return GuildMembership.objects.filter(guild_id=self.guild_id, user_id=user_id).exists()

    @database_sync_to_async
    def get_user_data(self, user_id):
        user = User.objects.get(id=user_id)
        # Use guild nickname if set
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
    def save_message(self, plaintext, reply_to_id=None, attachment_ids=None):
        msg = GuildMessage.objects.create(
            channel_id=self.channel_id,
            author_id=int(self.user_data['id']),
            encrypted_content=encrypt_text(plaintext or ''),
            reply_to_id=reply_to_id,
        )
        if attachment_ids:
            GuildAttachment.objects.filter(id__in=attachment_ids).update(message=msg)
        return msg.id

    @database_sync_to_async
    def get_attachments_data(self, attachment_ids):
        result = []
        for att in GuildAttachment.objects.filter(
            id__in=attachment_ids, channel_id=self.channel_id
        ):
            result.append({
                'id': att.id,
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
                'id': msg.id,
                'content': msg.content[:200],
                'author': {'id': str(msg.author.id), 'username': msg.author.username, 'nickname': msg.author.nickname or ''},
            }
        except GuildMessage.DoesNotExist:
            return None


class GuildVoiceConsumer(AsyncWebsocketConsumer):
    """Presence-only consumer for guild voice channels.
    Tracks who is in the channel and relays WebRTC signaling between them.
    """

    async def connect(self):
        self.guild_id = self.scope['url_route']['kwargs']['guild_id']
        self.channel_id = self.scope['url_route']['kwargs']['channel_id']
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

        await self.channel_layer.group_add(self.room_group, self.channel_name)
        await self.accept()

        # Register in voice channel: {channel_id: {'_guild_id': int, user_id: user_info, ...}}
        if self.channel_id not in _voice_channels:
            _voice_channels[self.channel_id] = {'_guild_id': self.guild_id}
        _voice_channels[self.channel_id][self.user_id] = self.user_info

        # Send current participants list to the joining user (exclude _guild_id sentinel)
        participants = [v for k, v in _voice_channels[self.channel_id].items() if k != '_guild_id']
        await self.send(text_data=ujson.dumps({
            'type': 'voice_participants',
            'participants': participants,
        }))

        # Notify voice room participants that this user joined
        await self.channel_layer.group_send(
            self.room_group,
            {'type': 'voice_user_joined', 'user': self.user_info, 'from_user': self.user_id},
        )

        # Notify ALL guild members (guild text WS group) so they see presence without being in voice
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
        # Remove from registry
        if self.channel_id in _voice_channels:
            _voice_channels[self.channel_id].pop(self.user_id, None)
            if not _voice_channels[self.channel_id]:
                del _voice_channels[self.channel_id]

        await self.channel_layer.group_discard(self.room_group, self.channel_name)

        # Notify voice room participants
        await self.channel_layer.group_send(
            self.room_group,
            {'type': 'voice_user_left', 'user_id': self.user_id},
        )

        # Notify ALL guild members
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
            # Update muted state and broadcast
            muted = bool(data.get('muted', False))
            if self.channel_id in _voice_channels and self.user_id in _voice_channels[self.channel_id]:
                _voice_channels[self.channel_id][self.user_id]['muted'] = muted
            await self.channel_layer.group_send(
                self.room_group,
                {'type': 'voice_mute_changed', 'user_id': self.user_id, 'muted': muted},
            )

        elif msg_type == 'signal':
            # Forward WebRTC signal to specific target user in this channel
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

    # ── Channel layer handlers ──

    async def voice_user_joined(self, event):
        if event['from_user'] == self.user_id:
            return  # Don't send to self
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

    async def voice_signal(self, event):
        # Only deliver to intended recipient
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
    def get_user_info(self, user_id):
        user = User.objects.get(id=user_id)
        return {
            'id': str(user.id),
            'username': user.username,
            'nickname': user.nickname or '',
            'avatar': user.avatar.url if user.avatar else '',
            'muted': False,
        }
