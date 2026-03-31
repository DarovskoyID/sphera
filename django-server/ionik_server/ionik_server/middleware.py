from urllib.parse import parse_qs
from channels.middleware import BaseMiddleware
from channels.db import database_sync_to_async
from django.contrib.auth.models import AnonymousUser
from rest_framework_simplejwt.tokens import AccessToken
from ionik_auth.models import User


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
