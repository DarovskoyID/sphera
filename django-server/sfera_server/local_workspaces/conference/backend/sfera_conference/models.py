import secrets
import uuid

from django.conf import settings
from django.db import models

from sfera_messages.encryption import decrypt_text, encrypt_text

KIND_INTERNAL, KIND_PRIVATE, KIND_EXTERNAL = 'internal', 'private', 'external'
KINDS = [
    # Anyone registered on this server.
    (KIND_INTERNAL, 'Internal'),
    # Registered users the organizer invited.
    (KIND_PRIVATE, 'Private'),
    # Registered users, plus anyone with the link who gives a name.
    (KIND_EXTERNAL, 'External'),
]


def new_slug():
    # Link-safe and not guessable: 12 chars of base62 ≈ 71 bits.
    alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    return ''.join(secrets.choice(alphabet) for _ in range(12))


class Conference(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    slug = models.CharField(max_length=24, unique=True, default=new_slug)
    title = models.CharField(max_length=160)
    description = models.TextField(blank=True, default='', max_length=4000)
    kind = models.CharField(max_length=10, choices=KINDS, default=KIND_INTERNAL)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    invited = models.ManyToManyField(settings.AUTH_USER_MODEL, related_name='conference_invites', blank=True)
    starts_at = models.DateTimeField(null=True, blank=True)
    # Guests from the link wait until a host lets them in.
    guest_lobby = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    ended_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [models.Index(fields=['kind', 'ended_at'])]

    @property
    def active(self):
        return self.ended_at is None


class ConferenceMessage(models.Model):
    """In-meeting chat. Kept with the conference so latecomers see the history."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conference = models.ForeignKey(Conference, on_delete=models.CASCADE, related_name='messages')
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name='+')
    guest_name = models.CharField(max_length=64, blank=True, default='')
    encrypted_text = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['created_at']

    @property
    def text(self):
        return decrypt_text(self.encrypted_text)

    @text.setter
    def text(self, value):
        self.encrypted_text = encrypt_text(value)


class MediaSettings(models.Model):
    """Media server for large conferences (LiveKit). A single row edited by the superuser."""
    livekit_url = models.CharField(max_length=300, blank=True, default='')
    livekit_api_key = models.CharField(max_length=200, blank=True, default='')
    encrypted_api_secret = models.TextField(blank=True, default='')
    updated_at = models.DateTimeField(auto_now=True)

    @property
    def api_secret(self):
        return decrypt_text(self.encrypted_api_secret) if self.encrypted_api_secret else ''

    @api_secret.setter
    def api_secret(self, value):
        self.encrypted_api_secret = encrypt_text(value) if value else ''

    @classmethod
    def load(cls):
        return cls.objects.first() or cls()


class ConferencePeer(models.Model):
    """A socket in a conference room (or waiting in its lobby); gone when it disconnects."""
    STATUS_LOBBY, STATUS_JOINED = 'lobby', 'joined'
    conference = models.ForeignKey(Conference, on_delete=models.CASCADE, related_name='peers')
    peer_id = models.CharField(max_length=64)
    channel = models.CharField(max_length=200)
    status = models.CharField(max_length=8, default=STATUS_JOINED)
    data = models.JSONField(default=dict)
    seen_at = models.DateTimeField(auto_now=True, db_index=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['conference', 'peer_id'], name='conference_uniq_peer')]


class AdmittedGuest(models.Model):
    """Guests a host let in from the lobby (they may reconnect without waiting again)."""
    conference = models.ForeignKey(Conference, on_delete=models.CASCADE, related_name='admitted')
    guest_id = models.CharField(max_length=64)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['conference', 'guest_id'], name='conference_uniq_admitted')]
