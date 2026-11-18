"""Live board socket: ops from collaborators and their cursors."""
import ujson
from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer

from sfera_messages.consumers import _accepted_subprotocol
from sfera_messages.services import _author_brief
from sfera_modules.permissions import ws_has_module

from .models import ROLE_VIEWER, Board
from .views import commit_ops, group_name, role_of


class BoardConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.board_id = str(self.scope['url_route']['kwargs']['board_id'])
        user = self.scope.get('user')
        if not user or user.is_anonymous or not await ws_has_module(self.scope, 'whiteboard'):
            await self.close()
            return
        self.role = await database_sync_to_async(role_of)(user, self.board_id)
        if not self.role:
            await self.close()
            return
        self.brief = await database_sync_to_async(_author_brief)(user)
        self.group = group_name(self.board_id)
        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.accept(subprotocol=_accepted_subprotocol(self.scope))
        board = await database_sync_to_async(lambda: Board.objects.filter(id=self.board_id).values('doc', 'version').first())()
        await self.send(text_data=ujson.dumps({'type': 'snapshot', **(board or {})}))
        await self._relay({'type': 'join', 'user': self.brief, 'channel': self.channel_name})

    async def disconnect(self, code):
        if hasattr(self, 'group'):
            await self._relay({'type': 'leave', 'channel': self.channel_name})
            await self.channel_layer.group_discard(self.group, self.channel_name)

    async def receive(self, text_data=None, bytes_data=None):
        try:
            data = ujson.loads(text_data or '{}')
        except ValueError:
            return
        kind = data.get('type')
        if kind == 'cursor':
            if not self.role or self.role == ROLE_VIEWER:
                return
            await self._relay({
                'type': 'cursor', 'channel': self.channel_name, 'user': self.brief,
                'x': data.get('x'), 'y': data.get('y'), 'selection': (data.get('selection') or [])[:50],
            })
        elif kind == 'ops':
            # Role may have changed since connecting.
            self.role = await database_sync_to_async(role_of)(self.scope['user'], self.board_id)
            if not self.role or self.role == ROLE_VIEWER:
                await self.send(text_data=ujson.dumps({'type': 'error', 'error': 'forbidden', 'seq': data.get('seq')}))
                return
            ops = data.get('ops')
            version, error = await database_sync_to_async(commit_ops)(self.board_id, self.scope['user'], ops)
            if error:
                await self.send(text_data=ujson.dumps({'type': 'error', 'error': error, 'seq': data.get('seq')}))
                return
            await self.send(text_data=ujson.dumps({'type': 'ack', 'seq': data.get('seq'), 'version': version}))
            await self._relay({
                'type': 'ops', 'ops': ops, 'version': version, 'client_id': str(data.get('client_id', ''))[:40],
                'user_id': str(self.scope['user'].id),
            })
        elif kind == 'hello':
            # A newcomer asks who is here; everyone answers with a cursor frame.
            await self._relay({'type': 'join', 'user': self.brief, 'channel': self.channel_name})

    async def _relay(self, message):
        await self.channel_layer.group_send(self.group, {'type': 'board.event', 'message': message, 'sender': self.channel_name})

    async def board_event(self, event):
        message = event['message']
        if event.get('sender') == self.channel_name and message.get('type') in ('cursor', 'join', 'leave', 'ops'):
            return
        if message.get('type') == 'access_changed' and message.get('user_id') == str(self.scope['user'].id):
            self.role = await database_sync_to_async(role_of)(self.scope['user'], self.board_id)
            if self.role == ROLE_VIEWER:
                await self._relay({'type': 'leave', 'channel': self.channel_name})
            if not self.role:
                await self.send(text_data=ujson.dumps({'type': 'removed'}))
                await self.close()
                return
        await self.send(text_data=ujson.dumps(message))
