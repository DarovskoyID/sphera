from channels.middleware import BaseMiddleware
from channels.db import database_sync_to_async
from django.contrib.auth.models import AnonymousUser
from django.http import HttpResponse
from rest_framework_simplejwt.tokens import AccessToken
from sfera_auth.models import User


class AppOnlyMiddleware:
    """
    Blocks direct browser access to the server.
    Every HTTP request must carry the custom header X-Ionik-Client: 1.
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
            and request.headers.get('X-Ionik-Client') != '1'
        ):
            return HttpResponse()
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
    try:
        token = AccessToken(token_str)
        return User.objects.get(id=token['user_id'])
    except Exception:
        return AnonymousUser()


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
        return await super().__call__(scope, receive, send)
