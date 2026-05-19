from urllib.parse import parse_qs
from channels.middleware import BaseMiddleware
from channels.db import database_sync_to_async
from django.contrib.auth.models import AnonymousUser
from django.http import HttpResponse
from rest_framework_simplejwt.tokens import AccessToken
from ionik_auth.models import User


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
            and request.headers.get('X-Ionik-Client') != '1'
        ):
            return HttpResponse()
        return self.get_response(request)


@database_sync_to_async
def get_user_from_token(token_str):
    try:
        token = AccessToken(token_str)
        return User.objects.get(id=token['user_id'])
    except Exception:
        return AnonymousUser()


class JWTAuthMiddleware(BaseMiddleware):
    """Authenticate WebSocket connections via ?token=<jwt> query param."""

    async def __call__(self, scope, receive, send):
        qs = parse_qs(scope.get('query_string', b'').decode())
        token_list = qs.get('token', [])
        if token_list:
            scope['user'] = await get_user_from_token(token_list[0])
        else:
            scope['user'] = AnonymousUser()
        return await super().__call__(scope, receive, send)
