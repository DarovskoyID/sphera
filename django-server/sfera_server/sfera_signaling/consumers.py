import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.db.models import Q
from asgiref.sync import sync_to_async

WS_AUTH_SUBPROTOCOL = 'ionik.jwt'


def _accepted_subprotocol(scope):
    return WS_AUTH_SUBPROTOCOL if WS_AUTH_SUBPROTOCOL in (scope.get('subprotocols') or []) else None


class SignalingConsumer(AsyncWebsocketConsumer):
    """
    WebRTC signaling + real-time presence (online status).

    Presence strategy:
    - On connect: set user online in DB, then directly notify each friend
      who is currently in _users (no group subscriptions → no race condition).
    - On disconnect: set user offline in DB, notify same friends.
    - On connect: also push each online friend's status to the newly connected
      user so their friend list is immediately up to date.
    """

    _users = {}  # user_id(str) -> {"channel": str, "name": str, "in_call_with": str|None}

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def connect(self):
        user = self.scope.get('user')
        if not user or user.is_anonymous:
            # Accept then immediately close so the browser gets a clean WS
            # close frame instead of "closed before established".
            await self.accept(subprotocol=_accepted_subprotocol(self.scope))
            await self.close(code=4001)
            return

        self.user_id = str(user.id)
        self.authed = True

        SignalingConsumer._users[self.user_id] = {
            'channel': self.channel_name,
            'name': user.nickname or user.username,
            'in_call_with': None,
        }

        await self.channel_layer.group_add('signaling', self.channel_name)
        await self.channel_layer.group_add(f'user_{self.user_id}', self.channel_name)
        await self.accept(subprotocol=_accepted_subprotocol(self.scope))

        # Mark online in DB
        await self._set_status('online')

        # Get friends list once
        friend_ids = await self._get_friend_ids()

        # Push MY online status directly to every currently-connected friend
        await self._notify_friends(friend_ids, 'online')

        # Push each connected friend's current status back to ME so my UI
        # updates immediately without waiting for their next state change.
        friend_statuses = await self._get_friend_statuses(friend_ids)
        for fid, fstatus in friend_statuses.items():
            await self.send(text_data=json.dumps({
                'type': 'status_update',
                'user_id': fid,
                'status': fstatus,
            }))

        await self._broadcast_peer_list()

    async def disconnect(self, close_code):
        # Guard: connect() may have returned early without setting these
        if not getattr(self, 'authed', False):
            return

        # Only remove from _users if THIS connection is still the active one.
        # If the client reconnected (e.g. React Strict Mode double-mount or network
        # blip), a newer connection has already replaced our entry — evicting it
        # would make the user invisible to callers even though they are online.
        current = SignalingConsumer._users.get(self.user_id)
        if current and current['channel'] == self.channel_name:
            # Notify call peer that the call has ended
            in_call_with = current.get('in_call_with')
            if in_call_with:
                peer = SignalingConsumer._users.get(in_call_with)
                if peer:
                    await self.channel_layer.send(peer['channel'], {
                        'type': 'signal.forward',
                        'data': {'type': 'call-end', 'from': self.user_id},
                    })
                    # Clear peer's call state too
                    if peer.get('in_call_with') == self.user_id:
                        peer['in_call_with'] = None

            SignalingConsumer._users.pop(self.user_id, None)

            await self.channel_layer.group_discard('signaling', self.channel_name)
            await self.channel_layer.group_discard(f'user_{self.user_id}', self.channel_name)

            await self._set_status('offline')

            friend_ids = await self._get_friend_ids()
            await self._notify_friends(friend_ids, 'offline')

            await self._broadcast_peer_list()
        else:
            # Stale connection closed — just clean up channel groups silently
            await self.channel_layer.group_discard('signaling', self.channel_name)
            await self.channel_layer.group_discard(f'user_{self.user_id}', self.channel_name)

    # ── Signaling messages ────────────────────────────────────────────────────

    async def receive(self, text_data):
        data = json.loads(text_data)
        target_id = str(data.get('to', ''))
        target = SignalingConsumer._users.get(target_id)
        signal_type = data.get('type', '')

        # Track call state
        me = SignalingConsumer._users.get(self.user_id)
        if me:
            if signal_type == 'offer':
                me['in_call_with'] = target_id
            elif signal_type == 'answer':
                me['in_call_with'] = str(data.get('from', target_id))
            elif signal_type in ('call-end', 'call-rejected'):
                me['in_call_with'] = None

        if target:
            await self.channel_layer.send(target['channel'], {
                'type': 'signal.forward',
                'data': {**data, 'from': self.user_id},
            })
        elif signal_type == 'offer':
            # Target is offline — send FCM call notification so their device wakes up
            caller_name = SignalingConsumer._users.get(self.user_id, {}).get('name', '') or self.user_id
            with_video = str(data.get('withVideo', data.get('with_video', False))).lower()
            await self._push_fcm_call(target_id, caller_name, with_video)

    @database_sync_to_async
    def _push_fcm_call(self, target_id, caller_name, with_video):
        from sfera_server.fcm import send_to_user
        send_to_user(target_id, {
            'type': 'call',
            'caller_name': caller_name,
            'with_video': with_video,
        })

    async def signal_forward(self, event):
        await self.send(text_data=json.dumps(event['data']))

    async def new_message_notification(self, event):
        await self.send(text_data=json.dumps(event['data']))

    async def block_notify(self, event):
        await self.send(text_data=json.dumps(event['data']))

    async def peer_list_update(self, event):
        await self.send(text_data=json.dumps(event['data']))

    async def user_profile_update(self, event):
        await self.send(text_data=json.dumps({
            'type': 'profile_update',
            'user': event['user'],
        }))

    async def dm_pin_toggled(self, event):
        await self.send(text_data=json.dumps({
            'type': 'message_pinned',
            'id': event['message_id'],
            'is_pinned': event['is_pinned'],
        }))

    async def account_banned(self, event):
        # The superuser banned this account: tell the client, then hang up.
        await self.send(text_data=json.dumps(event.get('data') or {'type': 'account_banned'}))
        await self.close(code=4003)

    async def account_unbanned(self, event):
        await self.send(text_data=json.dumps({'type': 'account_unbanned'}))

    async def module_event(self, event):
        # Generic module → client push (sfera_modules.hooks.push_to_user).
        await self.send(text_data=json.dumps({
            **event.get('payload', {}),
            'type': 'module_event',
            'event': event['event'],
        }))

    async def guild_kicked(self, event):
        await self.send(text_data=json.dumps({
            'type': 'guild_kicked_direct',
            'user_id': event['user_id'],
            'guild_name': event.get('guild_name', ''),
            'guild_id': event.get('guild_id', ''),
        }))

    # ── Presence helpers ──────────────────────────────────────────────────────

    async def _notify_friends(self, friend_ids: list, status: str):
        """Send status_update directly to each connected friend's channel."""
        payload = {
            'type': 'status_update',
            'user_id': self.user_id,
            'status': status,
        }
        for fid in friend_ids:
            entry = SignalingConsumer._users.get(fid)
            if entry:
                await self.channel_layer.send(entry['channel'], {
                    'type': 'signal.forward',
                    'data': payload,
                })

    async def _broadcast_peer_list(self):
        peers = [
            {'id': uid, 'name': info['name']}
            for uid, info in SignalingConsumer._users.items()
        ]
        await self.channel_layer.group_send('signaling', {
            'type': 'peer.list.update',
            'data': {'type': 'peers', 'peers': peers},
        })

    # ── DB helpers ────────────────────────────────────────────────────────────

    @database_sync_to_async
    def _set_status(self, status: str):
        from sfera_auth.models import User
        User.objects.filter(id=self.user_id).update(status=status)

    @database_sync_to_async
    def _get_friend_ids(self) -> list:
        from sfera_auth.models import Friendship
        rows = Friendship.objects.filter(
            Q(from_user_id=self.user_id) | Q(to_user_id=self.user_id),
            status='accepted',
        ).values_list('from_user_id', 'to_user_id')
        result = []
        for from_id, to_id in rows:
            other = to_id if str(from_id) == self.user_id else from_id
            result.append(str(other))
        return result

    @database_sync_to_async
    def _get_friend_statuses(self, friend_ids: list) -> dict:
        from sfera_auth.models import User
        rows = User.objects.filter(id__in=friend_ids).values('id', 'status')
        return {str(r['id']): r['status'] for r in rows}
