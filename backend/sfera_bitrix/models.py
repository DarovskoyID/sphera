import secrets

from django.conf import settings
from django.db import models

from sfera_messages.encryption import decrypt_text, encrypt_text


class Connection(models.Model):
    """The Bitrix24 portal of this server. One row, edited by the superuser."""
    # Incoming webhook: https://<portal>/rest/<user>/<code>/ — the code is a secret.
    encrypted_webhook_url = models.TextField(blank=True, default='')
    portal = models.CharField(max_length=200, blank=True, default='')
    # Token Bitrix24 puts into outgoing webhook calls (auth[application_token]).
    encrypted_application_token = models.TextField(blank=True, default='')
    default_responsible_id = models.IntegerField(null=True, blank=True)
    inbound_secret = models.CharField(max_length=64, default=secrets.token_urlsafe)
    notify_users = models.ManyToManyField(settings.AUTH_USER_MODEL, related_name='+', blank=True)
    allowed_users = models.ManyToManyField(settings.AUTH_USER_MODEL, related_name='+', blank=True)
    scopes = models.JSONField(default=list, blank=True)
    last_error = models.TextField(blank=True, default='')
    updated_at = models.DateTimeField(auto_now=True)

    @classmethod
    def load(cls):
        return cls.objects.first() or cls.objects.create()

    @property
    def webhook_url(self):
        return decrypt_text(self.encrypted_webhook_url) if self.encrypted_webhook_url else ''

    @webhook_url.setter
    def webhook_url(self, value):
        self.encrypted_webhook_url = encrypt_text(value) if value else ''

    @property
    def application_token(self):
        return decrypt_text(self.encrypted_application_token) if self.encrypted_application_token else ''

    @application_token.setter
    def application_token(self, value):
        self.encrypted_application_token = encrypt_text(value) if value else ''

    @property
    def configured(self):
        return bool(self.encrypted_webhook_url)


class Event(models.Model):
    DIRECTION = [('out', 'To Bitrix24'), ('in', 'From Bitrix24')]
    direction = models.CharField(max_length=3, choices=DIRECTION)
    kind = models.CharField(max_length=40)
    summary = models.CharField(max_length=300)
    entity_id = models.CharField(max_length=40, blank=True, default='')
    ok = models.BooleanField(default=True)
    payload = models.JSONField(default=dict, blank=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['-created_at']
