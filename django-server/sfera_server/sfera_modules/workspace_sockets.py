"""License checks for realtime traffic; never forwards message/media content."""
import json
from django.core.cache import cache
from channels.db import database_sync_to_async
from .workspace_access import enforced, require
from .commercial import config, CommercialError


def allowed(module_id):
    if not enforced(): return True
    try:
        base, instance, token = config()
        key = f'commercial:socket:{instance}:{module_id}'
        result = cache.get(key)
        if result is not None: return result
        require(module_id, 'realtime', method='CONNECT', transport='websocket')
        cache.set(key, True, 15)
        return True
    except CommercialError:
        return False


class LicensedSocket:
    def __init__(self, application, module_id):
        self.application, self.module_id = application, module_id

    async def __call__(self, scope, receive, send):
        first = await receive()
        readonly_module = self.module_id in ('office', 'whiteboard')
        if first['type'] == 'websocket.connect' and not readonly_module and enforced():
            if not await database_sync_to_async(allowed, thread_sensitive=False)(self.module_id):
                await send({'type': 'websocket.close', 'code': 4403})
                return
        initial = [first]
        async def licensed_receive():
            while True:
                if initial: return initial.pop()
                message = await receive()
                if message['type'] == 'websocket.receive' and enforced():
                    readonly = self.module_id in ('office', 'whiteboard')
                    kind = ''
                    if readonly and message['type'] == 'websocket.connect': return message
                    if readonly:
                        try:
                            data = json.loads(message.get('text') or '{}')
                            kind = data.get('type', '')
                        except (ValueError, AttributeError): return message
                        if kind in ('hello', 'ping', 'pong'): return message
                    if not await database_sync_to_async(allowed, thread_sensitive=False)(self.module_id):
                        if readonly:
                            if kind == 'ops': await send({'type': 'websocket.send', 'text': json.dumps({'type': 'error', 'error': 'subscription_required', 'seq': data.get('seq')})})
                            continue
                        await send({'type': 'websocket.close', 'code': 4403})
                        return {'type': 'websocket.disconnect', 'code': 4403}
                return message
        await self.application(scope, licensed_receive, send)
