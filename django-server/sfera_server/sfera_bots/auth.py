"""DRF authentication for bot API keys.

Bots authenticate with `Authorization: Bot <token>` (the SDKs also accept the
`X-Bot-Token` header, which is easier from environments where the standard
header is awkward). A revoked key stops working immediately because deletion
clears `is_active` and rewrites the stored digest.
"""

from rest_framework import authentication, exceptions

from .models import BotAccount, hash_token


def token_from_request(request):
    header = request.META.get('HTTP_AUTHORIZATION', '')
    if header.lower().startswith('bot '):
        return header[4:].strip()
    return (request.META.get('HTTP_X_BOT_TOKEN') or '').strip()


def bot_from_token(token):
    if not token:
        return None
    return (
        BotAccount.objects
        .select_related('user', 'owner')
        .filter(token_hash=hash_token(token), is_active=True)
        .first()
    )


class BotTokenAuthentication(authentication.BaseAuthentication):
    keyword = 'Bot'

    def authenticate(self, request):
        token = token_from_request(request)
        if not token:
            return None
        bot = bot_from_token(token)
        if bot is None:
            raise exceptions.AuthenticationFailed('invalid or revoked bot token')
        # Stash the BotAccount so views don't re-query it.
        request.bot_account = bot
        return (bot.user, token)

    def authenticate_header(self, request):
        return self.keyword
