import re

from channels.middleware import BaseMiddleware
from channels.db import database_sync_to_async
from django.contrib.auth.models import AnonymousUser
from django.http import HttpResponse
from rest_framework_simplejwt.tokens import AccessToken
from sfera_auth.models import User

# Module bundles are loaded with import() (no custom headers); module webhooks are
# called by external systems (1C, amoCRM, Bitrix24).
_PUBLIC_API = re.compile(r'^/api/(modules/[a-z0-9_-]+/bundle\.js$|[a-z0-9_-]+/webhook/)')


class AppOnlyMiddleware:
    """
    Blocks direct browser access to the server.
    Every HTTP request must carry the custom header X-Ionik-Client: 1,
    except the key-authenticated bot API (/api/bots/api/), which exists
    precisely so third-party programs can call it.
    CORS pre-flight OPTIONS requests are allowed through so the browser
    can negotiate the custom header before the real request is sent.
    WebSocket connections are handled by ASGI/Channels and are not
    affected by this WSGI middleware.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if (
            request.method != 'OPTIONS'
            and not request.path.startswith('/media/')
            and not request.path.startswith('/status-')
            and not request.path.startswith('/metrics')
            # Public bot API: third-party SDKs are legitimate non-app clients.
            and not request.path.startswith('/api/bots/api/')
            and not _PUBLIC_API.match(request.path)
            and request.headers.get('X-Ionik-Client') != '1'
        ):
            return HttpResponse()
        return self.get_response(request)


class BanGuardMiddleware:
    """Refuses every API request made with a banned user's token — core and modules.

    Runs before DRF and any module view, so nothing a banned account sends is
    processed. `/api/auth/ban-status/` answers with the ban itself, which is how
    the client shows the ban screen.
    """

    STATUS_PATH = '/api/auth/ban-status/'

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        from django.http import JsonResponse
        from sfera_auth import bans

        if request.path.startswith('/api/') and request.method != 'OPTIONS':
            user_id = bans.user_id_from_bearer(request.headers.get('Authorization', ''))
            if user_id and bans.is_banned(user_id):
                info = bans.ban_info(user_id) or {'error': 'account_banned', 'reason': ''}
                if request.path == self.STATUS_PATH:
                    return JsonResponse({'banned': True, **info})
                return JsonResponse(info, status=403)
        return self.get_response(request)


class SecurityHeadersMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        from django.conf import settings

        response = self.get_response(request)
        headers = {
            'Content-Security-Policy': getattr(settings, 'CONTENT_SECURITY_POLICY', ''),
            'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'X-Content-Type-Options': 'nosniff',
            'X-Permitted-Cross-Domain-Policies': 'none',
        }
        for name, value in headers.items():
            if value and name not in response:
                response[name] = value
        return response


@database_sync_to_async
def get_user_from_token(token_str):
    from sfera_auth import bans
    try:
        token = AccessToken(token_str)
        user = User.objects.get(id=token['user_id'])
    except Exception:
        return AnonymousUser()
    if not user.is_active or bans.is_banned(user.id):
        return AnonymousUser()
    return user


@database_sync_to_async
def _still_banned(user_id):
    from sfera_auth import bans
    return bans.is_banned(user_id)


def _token_from_subprotocols(scope):
    protocols = scope.get('subprotocols') or []
    try:
        marker_index = protocols.index('ionik.jwt')
    except ValueError:
        return None
    if marker_index + 1 < len(protocols):
        return protocols[marker_index + 1]
    return None


class JWTAuthMiddleware(BaseMiddleware):
    """Authenticate WebSocket connections via the ionik.jwt subprotocol."""

    async def __call__(self, scope, receive, send):
        token = _token_from_subprotocols(scope)
        if token:
            scope['user'] = await get_user_from_token(token)
        else:
            scope['user'] = AnonymousUser()

        user = scope['user']
        if getattr(user, 'is_authenticated', False):
            user_id = user.id

            async def guarded_receive():
                # Sockets opened before a ban: drop frames from a banned user and
                # end the connection, for core and module consumers alike.
                event = await receive()
                if event.get('type') == 'websocket.receive' and await _still_banned(user_id):
                    try:
                        await send({'type': 'websocket.close', 'code': 4003})
                    except Exception:
                        pass
                    return {'type': 'websocket.disconnect', 'code': 4003}
                return event

            return await super().__call__(scope, guarded_receive, send)
        return await super().__call__(scope, receive, send)
