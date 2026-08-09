"""Bot accounts, their API keys, command lists and update queues.

A bot is a real `User` row with `account_type='bot'` (so it can be a
conversation participant, a guild member and a message author like anyone
else) plus a `BotAccount` row holding the owner link and the API key.

Keys are never stored in plain text: only a SHA-256 digest is kept, together
with a short public prefix so the owner can recognise which key is which.
Deleting a bot revokes the key and deactivates the login, but never touches
conversations or messages — history with a bot survives the bot.
"""

import hashlib
import secrets
import uuid

from django.conf import settings
from django.db import models

TOKEN_PREFIX = 'sfb'
BOT_USERNAME_SUFFIX = '_bot'


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def generate_token() -> tuple[str, str, str]:
    """Return (full_token, digest, public_prefix)."""
    secret = secrets.token_urlsafe(32)
    token = f'{TOKEN_PREFIX}_{secret}'
    return token, hash_token(token), token[:10]


class BotAccount(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='bot_profile',
    )
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='owned_bots',
    )
    display_name = models.CharField(max_length=64)
    description = models.CharField(max_length=280, blank=True, default='')
    # [{'command': 'start', 'description': '...'}] — what the client shows in
    # the command button next to the composer.
    commands = models.JSONField(default=list, blank=True)
    token_hash = models.CharField(max_length=64, unique=True, db_index=True)
    token_prefix = models.CharField(max_length=16, blank=True, default='')
    # System bots (Sferonik) are owned by nobody in practice and can't be deleted.
    is_system = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.user.username} (bot of {self.owner.username})'

    def set_token(self) -> str:
        """Issue a fresh key, invalidating the previous one. Returns plain text."""
        token, digest, prefix = generate_token()
        self.token_hash = digest
        self.token_prefix = prefix
        return token


class BotFlow(models.Model):
    """A node-editor graph saved for a bot, so work survives a page reload."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    bot = models.OneToOneField(BotAccount, on_delete=models.CASCADE, related_name='flow')
    graph = models.JSONField(default=dict, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f'flow of {self.bot.user.username}'


class BotUpdate(models.Model):
    """Queued event for a bot, consumed through long-polling `getUpdates`.

    An auto-incrementing integer id is what makes the offset protocol work, so
    this model deliberately does not use a UUID primary key.
    """
    UPDATE_MESSAGE = 'message'
    UPDATE_COMMAND = 'command'
    UPDATE_TYPE_CHOICES = [
        (UPDATE_MESSAGE, 'Message'),
        (UPDATE_COMMAND, 'Command'),
    ]

    id = models.BigAutoField(primary_key=True)
    bot = models.ForeignKey(BotAccount, on_delete=models.CASCADE, related_name='updates')
    update_type = models.CharField(max_length=16, choices=UPDATE_TYPE_CHOICES, default=UPDATE_MESSAGE)
    payload = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['id']
        indexes = [models.Index(fields=['bot', 'id'])]
