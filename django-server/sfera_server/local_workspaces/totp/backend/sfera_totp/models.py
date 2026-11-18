import uuid

from django.conf import settings
from django.db import models

from sfera_messages.encryption import decrypt_text, encrypt_text


class TotpSettings(models.Model):
    """Server-wide switch, owned by the superuser."""
    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    required_for_all = models.BooleanField(default=False)
    # Printed in the authenticator app next to the account.
    issuer = models.CharField(max_length=60, default='Сфера')
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = 'TOTP settings'

    @classmethod
    def load(cls):
        row, _ = cls.objects.get_or_create(id=1)
        return row


class TotpDevice(models.Model):
    """One authenticator per account.

    The secret is stored with the core's message encryption, so a database copy
    on its own does not let anyone generate codes.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='totp_device')
    # Named for the core: rotate_message_encryption walks every ENCRYPTED_DATA
    # model through this field.
    encrypted_content = models.TextField()
    confirmed_at = models.DateTimeField(null=True, blank=True)
    # Newest 30-second step already spent: a code works exactly once.
    last_counter = models.PositiveBigIntegerField(default=0)
    last_used_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    @property
    def secret(self) -> str:
        return decrypt_text(self.encrypted_content)

    @secret.setter
    def secret(self, value: str):
        self.encrypted_content = encrypt_text(value)

    @property
    def confirmed(self) -> bool:
        return self.confirmed_at is not None


class BackupCode(models.Model):
    """A one-time way in when the authenticator is lost. Stored hashed."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='totp_backup_codes')
    code_hash = models.CharField(max_length=64, db_index=True)
    used_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user', 'code_hash'], name='totp_uniq_backup')]
