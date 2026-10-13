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


class DomainRequiredMiddleware:
    """Answers 500 to everything while the site address (SFERA_DOMAIN) is not set.

    Host checks, CSRF/CORS origins, the TURN realm and the sender of the
    verification-code mail are all derived from it, so a server without it
    must not pretend to work.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        from django.conf import settings

        if not settings.SFERA_DOMAIN:
            return HttpResponse('SFERA_DOMAIN is not set.', status=500, content_type='text/plain')
        return self.get_response(request)


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


# What a blocked-but-signed-in account may still reach whatever a module says:
# the module list and bundles (so the blocking screen can load at all) and the
# way out. Reading the own profile is allowed as an exact path — `/api/auth/me/`
# as a prefix would also open me/update/, me/password/ and me/delete/.
_ALWAYS_ALLOWED_PREFIXES = ('/api/modules/',)
_ALWAYS_ALLOWED_PATHS = ('/api/auth/me/', '/api/auth/logout/', '/api/auth/ban-status/')


class BanGuardMiddleware:
    """Refuses every API request a banned — or module-blocked — account makes.

    Runs before DRF and any module view, so nothing such an account sends is
    processed. `/api/auth/ban-status/` answers with the ban itself, which is how
    the client shows the ban screen.

    A module can keep an account out the same way through the ACCESS_GUARD hook
    (two-factor set-up, for instance). Because the decision lives here, in front
    of every view, it cannot be stepped around by editing the page or calling
    the API by hand: the client is never what enforces it.
    """

    STATUS_PATH = '/api/auth/ban-status/'

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        from django.http import JsonResponse
        from sfera_auth import bans
        from sfera_modules import hooks

        if request.path.startswith('/api/') and request.method != 'OPTIONS':
            user_id = bans.user_id_from_bearer(request.headers.get('Authorization', ''))
            if user_id and bans.is_banned(user_id):
                info = bans.ban_info(user_id) or {'error': 'account_banned', 'reason': ''}
                if request.path == self.STATUS_PATH:
                    return JsonResponse({'banned': True, **info})
                return JsonResponse(info, status=403)
            if user_id:
                block = hooks.access_block(user_id)
                if block:
                    prefixes = _ALWAYS_ALLOWED_PREFIXES + tuple(block.get('allow') or ())
                    if request.path not in _ALWAYS_ALLOWED_PATHS and not request.path.startswith(prefixes):
                        return JsonResponse({k: v for k, v in block.items() if k != 'allow'}, status=403)
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
    from sfera_modules import hooks
    try:
        token = AccessToken(token_str)
        user = User.objects.get(id=token['user_id'])
    except Exception:
        return AnonymousUser()
    # A module may keep the account out of the app (e.g. two-factor not set up
    # yet): then it gets no sockets either, core or module.
    if not user.is_active or bans.is_banned(user.id) or hooks.access_block(user.id):
        return AnonymousUser()
    return user


@database_sync_to_async
def _still_banned(user_id):
    from sfera_auth import bans
    from sfera_modules import hooks

    return bans.is_banned(user_id) or bool(hooks.access_block(user_id))


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
                # Sockets opened before a ban (or before a module blocked the
                # account): drop the frames and end the connection, for core and
                # module consumers alike.
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
