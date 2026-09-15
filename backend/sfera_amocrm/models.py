import secrets

from django.conf import settings
from django.db import models

from sfera_messages.encryption import decrypt_text, encrypt_text


class Connection(models.Model):
    """The amoCRM account of this server. One row, edited by the superuser."""
    # e.g. "mycompany.amocrm.ru" or "mycompany.kommo.com"
    domain = models.CharField(max_length=200, blank=True, default='')
    # A long-lived token of a private integration, or OAuth tokens.
    encrypted_access_token = models.TextField(blank=True, default='')
    encrypted_refresh_token = models.TextField(blank=True, default='')
    token_expires_at = models.DateTimeField(null=True, blank=True)
    client_id = models.CharField(max_length=100, blank=True, default='')
    encrypted_client_secret = models.TextField(blank=True, default='')
    redirect_uri = models.CharField(max_length=300, blank=True, default='')
    pipeline_id = models.BigIntegerField(null=True, blank=True)
    # Inbound webhook URL: /api/amocrm/webhook/<secret>/
    webhook_secret = models.CharField(max_length=64, default=secrets.token_urlsafe)
    # Who is told about events from amoCRM.
    notify_users = models.ManyToManyField(settings.AUTH_USER_MODEL, related_name='+', blank=True)
    # Empty: every user of the server may create leads.
    allowed_users = models.ManyToManyField(settings.AUTH_USER_MODEL, related_name='+', blank=True)
    account_name = models.CharField(max_length=200, blank=True, default='')
    last_error = models.TextField(blank=True, default='')
    updated_at = models.DateTimeField(auto_now=True)

    @classmethod
    def load(cls):
        return cls.objects.first() or cls.objects.create()

    def _get(self, field):
        value = getattr(self, f'encrypted_{field}')
        return decrypt_text(value) if value else ''

    def _set(self, field, value):
        setattr(self, f'encrypted_{field}', encrypt_text(value) if value else '')

    access_token = property(lambda self: self._get('access_token'), lambda self, v: self._set('access_token', v))
    refresh_token = property(lambda self: self._get('refresh_token'), lambda self, v: self._set('refresh_token', v))
    client_secret = property(lambda self: self._get('client_secret'), lambda self, v: self._set('client_secret', v))

    @property
    def configured(self):
        return bool(self.domain and self.encrypted_access_token)


class Event(models.Model):
    """What went to and came from amoCRM, for the log in the module."""
    DIRECTION = [('out', 'To amoCRM'), ('in', 'From amoCRM')]
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
