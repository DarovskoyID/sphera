import secrets

from django.conf import settings
from django.db import models

from sfera_messages.encryption import decrypt_text, encrypt_text


class Connection(models.Model):
    """The 1C:Enterprise base of this server (standard OData interface). One row, edited by the superuser."""
    # e.g. https://1c.company.ru/trade/odata/standard.odata/
    base_url = models.CharField(max_length=500, blank=True, default='')
    username = models.CharField(max_length=150, blank=True, default='')
    encrypted_password = models.TextField(blank=True, default='')
    # Metadata names differ between configurations (УТ, КА, ERP, БП…).
    counterparty_entity = models.CharField(max_length=200, default='Catalog_Контрагенты')
    product_entity = models.CharField(max_length=200, default='Catalog_Номенклатура')
    document_entity = models.CharField(max_length=200, default='Document_ЗаказКлиента')
    document_counterparty_field = models.CharField(max_length=200, default='Контрагент_Key')
    inn_field = models.CharField(max_length=100, default='ИНН')
    # 1C posts notifications to /api/onec/webhook/<secret>/
    inbound_secret = models.CharField(max_length=64, default=secrets.token_urlsafe)
    notify_users = models.ManyToManyField(settings.AUTH_USER_MODEL, related_name='+', blank=True)
    allowed_users = models.ManyToManyField(settings.AUTH_USER_MODEL, related_name='+', blank=True)
    entity_sets = models.JSONField(default=list, blank=True)
    last_error = models.TextField(blank=True, default='')
    updated_at = models.DateTimeField(auto_now=True)

    @classmethod
    def load(cls):
        return cls.objects.first() or cls.objects.create()

    @property
    def password(self):
        return decrypt_text(self.encrypted_password) if self.encrypted_password else ''

    @password.setter
    def password(self, value):
        self.encrypted_password = encrypt_text(value) if value else ''

    @property
    def configured(self):
        return bool(self.base_url)


class Event(models.Model):
    DIRECTION = [('out', 'To 1C'), ('in', 'From 1C')]
    direction = models.CharField(max_length=3, choices=DIRECTION)
    kind = models.CharField(max_length=40)
    summary = models.CharField(max_length=300)
    entity_id = models.CharField(max_length=64, blank=True, default='')
    ok = models.BooleanField(default=True)
    payload = models.JSONField(default=dict, blank=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['-created_at']
