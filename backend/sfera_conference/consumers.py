"""Conference room socket: who is in the room, chat, host controls and WebRTC signaling.

Media goes through the LiveKit server when one is configured (any number of
participants) and peer to peer otherwise; this socket carries the room state for
both and the signaling for the latter. Presence lives in the database, so it is
shared by every server node.
"""
import time
from datetime import timedelta

import ujson
from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.utils import timezone

from sfera_messages.consumers import _accepted_subprotocol
from sfera_modules.permissions import ws_has_module

from .access import is_host, read_guest_pass, user_can_join
from .models import AdmittedGuest, Conference, ConferenceMessage, ConferencePeer

CHAT_MAX = 2000
# Sockets ping every 25 s; a peer silent for longer is treated as gone.
STALE_AFTER = timedelta(seconds=90)


def _guest_token(scope):
    protocols = scope.get('subprotocols') or []
    if 'conf.guest' in protocols:
        i = protocols.index('conf.guest')
        if i + 1 < len(protocols):
            return protocols[i + 1]
    return None


def message_data(m):
    author = m.author
    return {
        'id': str(m.id),
        'text': m.text,
        'name': (author.nickname or author.username) if author else m.guest_name,
        'user_id': str(author.id) if author else None,
        'guest': author is None,
        'created_at': m.created_at.isoformat(),
    }


def live_peers(conf_id, status=ConferencePeer.STATUS_JOINED):
    return ConferencePeer.objects.filter(conference_id=conf_id, status=status, seen_at__gte=timezone.now() - STALE_AFTER)


class ConferenceConsumer(AsyncWebsocketConsumer):
    conf = None
    peer = None
    joined = False

    # ── Connection ───────────────────────────────────────────────────────────

    async def connect(self):
        slug = self.scope['url_route']['kwargs']['slug']
        self.conf = await database_sync_to_async(lambda: Conference.objects.filter(slug=slug).first())()
        if not self.conf or not self.conf.active:
            await self.close(code=4404)
            return
        user = self.scope.get('user')
        token = _guest_token(self.scope)
        if user and user.is_authenticated:
            if not await ws_has_module(self.scope, 'conference') or not await database_sync_to_async(user_can_join)(user, self.conf):
                await self.close(code=4403)
                return
            self.peer = {
                'peer_id': f'u{str(user.id)[:8]}-{int(time.time() * 1000) % 10_000_000}',
                'user_id': str(user.id),
                # Same identity as in the media server token (views._join_payload).
                'identity': f'user-{user.id}',
                'name': user.nickname or user.username,
                'avatar': user.avatar.url if getattr(user, 'avatar', None) else '',
                'guest': False,
                'host': await database_sync_to_async(is_host)(user, self.conf),
            }
            subprotocol = _accepted_subprotocol(self.scope)
        elif token:
            guest = await database_sync_to_async(read_guest_pass)(token, self.conf)
            if not guest:
                await self.close(code=4403)
                return
            self.peer = {'peer_id': guest['guest_id'], 'identity': guest['guest_id'], 'user_id': None, 'name': guest['name'], 'avatar': '', 'guest': True, 'host': False}
            subprotocol = 'conf.guest'
        else:
            await self.close(code=4401)
            return

        self.peer.update({'audio': False, 'video': False, 'screen': False, 'hand': False, 'joined_at': time.time()})
        self.group = f'conference_{self.conf.id}'
        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.accept(subprotocol=subprotocol)

        needs_lobby = self.peer['guest'] and self.conf.guest_lobby and not await database_sync_to_async(
            AdmittedGuest.objects.filter(conference=self.conf, guest_id=self.peer['peer_id']).exists)()
        if needs_lobby:
            await self._save(ConferencePeer.STATUS_LOBBY)
            await self.send_json({'type': 'lobby'})
            await self._broadcast_lobby()
            return
        await self._join()

    async def _join(self):
        self.joined = True
        await self._save(ConferencePeer.STATUS_JOINED)

        def snapshot():
            peers = [p.data for p in live_peers(self.conf.id).exclude(peer_id=self.peer['peer_id'])]
            messages = [message_data(m) for m in ConferenceMessage.objects.filter(conference=self.conf)
                        .select_related('author').order_by('-created_at')[:100]][::-1]
            lobby = [p.data for p in live_peers(self.conf.id, ConferencePeer.STATUS_LOBBY)] if self.peer['host'] else []
            return peers, messages, lobby

        peers, messages, lobby = await database_sync_to_async(snapshot)()
        await self.send_json({
            'type': 'welcome',
            'me': self.peer,
            'peers': peers,
            'messages': messages,
            'lobby': lobby,
            'conference': {'id': str(self.conf.id), 'title': self.conf.title, 'kind': self.conf.kind, 'owner_id': str(self.conf.owner_id)},
        })
        await self._broadcast({'type': 'peer-joined', 'peer': self.peer}, exclude_self=True)

    async def disconnect(self, code):
        await self._leave()
        if hasattr(self, 'group'):
            await self.channel_layer.group_discard(self.group, self.channel_name)

    async def _leave(self):
        """Remove this socket from the room once, whether it closed or was closed by the host."""
        if not self.peer or not hasattr(self, 'group') or getattr(self, 'left', False):
            return
        self.left = True
        await database_sync_to_async(ConferencePeer.objects.filter(conference=self.conf, peer_id=self.peer['peer_id'], channel=self.channel_name).delete)()
        if self.joined:
            await self._broadcast({'type': 'peer-left', 'peer_id': self.peer['peer_id']}, exclude_self=True)
        else:
            await self._broadcast_lobby()

    # ── Frames from the client ───────────────────────────────────────────────

    async def receive(self, text_data=None, bytes_data=None):
        try:
            data = ujson.loads(text_data or '{}')
        except ValueError:
            return
        kind = data.get('type')
        if kind == 'ping':
            await database_sync_to_async(ConferencePeer.objects.filter(conference=self.conf, peer_id=self.peer['peer_id']).update)(seen_at=timezone.now())
            await self.send_json({'type': 'pong'})
            await self._sweep()
            return
        if not self.joined:
            return
        pid = self.peer['peer_id']
        if kind == 'signal':
            target = await database_sync_to_async(lambda: live_peers(self.conf.id).filter(peer_id=str(data.get('to'))).values_list('channel', flat=True).first())()
            if target:
                await self.channel_layer.send(target, {'type': 'room.direct', 'message': {'type': 'signal', 'from': pid, 'data': data.get('data')}})
        elif kind == 'state':
            for field in ('audio', 'video', 'screen', 'hand'):
                if field in data:
                    self.peer[field] = bool(data[field])
            await self._save(ConferencePeer.STATUS_JOINED)
            await self._broadcast({'type': 'peer-updated', 'peer': self.peer}, exclude_self=True)
        elif kind == 'chat':
            text = str(data.get('text', '')).strip()[:CHAT_MAX]
            if text:
                await self._broadcast({'type': 'chat', 'message': await database_sync_to_async(self._save_message)(text)})
        elif kind == 'reaction':
            emoji = str(data.get('emoji', ''))[:8]
            if emoji:
                await self._broadcast({'type': 'reaction', 'peer_id': pid, 'emoji': emoji})
        elif kind in ('mute', 'kick', 'admit', 'deny', 'end', 'lower-hand') and self.peer['host']:
            await self._host_action(kind, str(data.get('peer_id', '')))

    def _save_message(self, text):
        user = self.scope.get('user')
        registered = bool(user and user.is_authenticated)
        m = ConferenceMessage(conference=self.conf, author=user if registered else None, guest_name='' if registered else self.peer['name'])
        m.text = text
        m.save()
        return message_data(ConferenceMessage.objects.select_related('author').get(id=m.id))

    async def _host_action(self, kind, target_id):
        if kind == 'end':
            def end():
                Conference.objects.filter(id=self.conf.id).update(ended_at=timezone.now())
                ConferencePeer.objects.filter(conference=self.conf).delete()
            await database_sync_to_async(end)()
            await self._broadcast({'type': 'ended'})
            return
        status = ConferencePeer.STATUS_LOBBY if kind in ('admit', 'deny') else ConferencePeer.STATUS_JOINED
        target = await database_sync_to_async(lambda: live_peers(self.conf.id, status).filter(peer_id=target_id).first())()
        if not target:
            return
        if kind in ('admit', 'deny'):
            if kind == 'admit':
                await database_sync_to_async(AdmittedGuest.objects.get_or_create)(conference=self.conf, guest_id=target_id)
            await self.channel_layer.send(target.channel, {'type': 'room.lobby_decision', 'admit': kind == 'admit'})
        elif kind == 'mute':
            await self.channel_layer.send(target.channel, {'type': 'room.direct', 'message': {'type': 'muted-by-host'}})
        elif kind == 'lower-hand':
            await self.channel_layer.send(target.channel, {'type': 'room.direct', 'message': {'type': 'hand-lowered'}})
        elif kind == 'kick':
            await self.channel_layer.send(target.channel, {'type': 'room.kick'})

    # ── Events from the channel layer ────────────────────────────────────────

    async def room_event(self, event):
        if event.get('exclude') == self.channel_name:
            return
        message = event['message']
        kind = message.get('type')
        if kind == 'lobby':
            if self.joined and self.peer.get('host'):
                await self.send_json(message)
            return
        if not self.joined and kind != 'ended':
            return
        await self.send_json(message)
        if kind == 'ended':
            await self.close(code=4000)

    async def room_direct(self, event):
        await self.send_json(event['message'])

    async def room_kick(self, event):
        await self.send_json({'type': 'kicked'})
        await self._leave()
        await self.close(code=4001)

    async def room_lobby_decision(self, event):
        if event['admit']:
            await self.send_json({'type': 'admitted'})
            await self._join()
            await self._broadcast_lobby()
        else:
            await self.send_json({'type': 'denied'})
            await self._leave()
            await self.close(code=4003)

    # ── Helpers ──────────────────────────────────────────────────────────────

    async def send_json(self, data):
        await self.send(text_data=ujson.dumps(data))

    async def _broadcast(self, message, exclude_self=False):
        await self.channel_layer.group_send(self.group, {
            'type': 'room.event', 'message': message, 'exclude': self.channel_name if exclude_self else None,
        })

    async def _sweep(self):
        """Sockets that died without closing (server restart, lost network) leave the room here."""
        def stale():
            rows = ConferencePeer.objects.filter(conference_id=self.conf.id, seen_at__lt=timezone.now() - STALE_AFTER)
            gone = list(rows.values_list('peer_id', 'status'))
            rows.delete()
            return gone
        gone = await database_sync_to_async(stale)()
        for peer_id, status in gone:
            if status == ConferencePeer.STATUS_JOINED:
                await self._broadcast({'type': 'peer-left', 'peer_id': peer_id})
        if any(status == ConferencePeer.STATUS_LOBBY for _, status in gone):
            await self._broadcast_lobby()

    async def _broadcast_lobby(self):
        lobby = await database_sync_to_async(lambda: [p.data for p in live_peers(self.conf.id, ConferencePeer.STATUS_LOBBY)])()
        await self._broadcast({'type': 'lobby', 'lobby': lobby})

    async def _save(self, status):
        await database_sync_to_async(ConferencePeer.objects.update_or_create)(
            conference=self.conf, peer_id=self.peer['peer_id'],
            defaults={'channel': self.channel_name, 'status': status, 'data': self.peer},
        )
