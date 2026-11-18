"""ws/m/channels/<channel_id>/ — server → client feed events.

Posting goes over HTTP (reliable for attachment-heavy posts); the socket only
delivers events and runs timers for scheduled posts while someone is watching.
"""
import asyncio
import json

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.utils import timezone

from sfera_modules.permissions import ws_has_module
from sfera_signaling.consumers import _accepted_subprotocol

MODULE = 'channels'


class ChannelFeedConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.channel_id = str(self.scope['url_route']['kwargs']['channel_id'])
        self.group = f'feed_{self.channel_id}'
        self._timers = []
        user = self.scope.get('user')
        if not user or user.is_anonymous or not await ws_has_module(self.scope, MODULE):
            await self.close()
            return
        if not await self._can_read(user.id):
            await self.close()
            return
        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.accept(subprotocol=_accepted_subprotocol(self.scope))
        for send_at in await self._pending():
            self._arm(send_at)

    async def disconnect(self, code):
        for t in self._timers:
            t.cancel()
        await self.channel_layer.group_discard(self.group, self.channel_name)

    async def receive(self, text_data=None, bytes_data=None):
        # Read-only socket; ignore anything the client sends.
        return

    async def feed_event(self, event):
        data = event['data']
        if data.get('type') == 'post_scheduled':
            from django.utils.dateparse import parse_datetime
            send_at = parse_datetime(data.get('send_at') or '')
            if send_at:
                self._arm(send_at)
        await self.send(text_data=json.dumps(data))

    def _arm(self, send_at):
        async def fire():
            delay = (send_at - timezone.now()).total_seconds()
            if delay > 0:
                await asyncio.sleep(delay)
            await self._deliver()
        self._timers = [t for t in self._timers if not t.done()]
        self._timers.append(asyncio.ensure_future(fire()))

    @database_sync_to_async
    def _can_read(self, user_id):
        from .models import Channel, Subscription
        ch = Channel.objects.filter(id=self.channel_id).first()
        return bool(ch) and (ch.is_discoverable or Subscription.objects.filter(channel=ch, user_id=user_id).exists())

    @database_sync_to_async
    def _pending(self):
        from datetime import timedelta
        from .models import ScheduledPost
        return list(ScheduledPost.objects.filter(
            channel_id=self.channel_id, is_sent=False, send_at__lte=timezone.now() + timedelta(hours=24),
        ).values_list('send_at', flat=True))

    @database_sync_to_async
    def _deliver(self):
        from .services import deliver_due
        deliver_due(self.channel_id)
