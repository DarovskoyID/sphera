import secrets
import uuid

from django.conf import settings
from django.db import models

from sfera_messages.encryption import decrypt_bytes, encrypt_bytes

# A chain covers one conversation: 'dm:<conversation uuid>'.
SCOPE_MAX = 80
HASH_MAX = 64


def _package_upload(instance, filename):
    return f'attachments/{uuid.uuid4().hex}.enc'


class LegalSettings(models.Model):
    """Instance-wide settings; one row, edited by the superuser."""
    # Recording costs one insert per message: off until the instance wants it.
    record_chain = models.BooleanField(default=False)
    org_name = models.CharField(max_length=200, blank=True, default='')
    org_details = models.CharField(max_length=300, blank=True, default='')
    # RFC 3161 time-stamping authority; its reply is stored with the protocol.
    tsa_url = models.CharField(max_length=300, blank=True, default='')
    updated_at = models.DateTimeField(auto_now=True)

    @classmethod
    def load(cls):
        return cls.objects.first() or cls()


class ChainHead(models.Model):
    """Last link of a conversation's chain; the row lock serializes writers."""
    scope = models.CharField(max_length=SCOPE_MAX, primary_key=True)
    seq = models.BigIntegerField(default=0)
    last_hash = models.CharField(max_length=HASH_MAX, blank=True, default='')
    updated_at = models.DateTimeField(auto_now=True)


class ChainEntry(models.Model):
    """One message's place in the chain: only hashes, never the text itself."""
    scope = models.CharField(max_length=SCOPE_MAX, db_index=True)
    seq = models.BigIntegerField()
    message_id = models.CharField(max_length=64)
    author_id = models.CharField(max_length=64, blank=True, default='')
    sent_at = models.DateTimeField()
    recorded_at = models.DateTimeField(auto_now_add=True)
    content_hash = models.CharField(max_length=HASH_MAX)
    prev_hash = models.CharField(max_length=HASH_MAX, blank=True, default='')
    chain_hash = models.CharField(max_length=HASH_MAX)

    class Meta:
        ordering = ['scope', 'seq']
        constraints = [
            models.UniqueConstraint(fields=['scope', 'seq'], name='legal_uniq_chain_seq'),
            models.UniqueConstraint(fields=['scope', 'message_id'], name='legal_uniq_chain_message'),
        ]
        indexes = [models.Index(fields=['scope', 'sent_at'])]


class Package(models.Model):
    """A protocol: the messages of a period, frozen, hashed and signed."""
    STATUS_DRAFT, STATUS_SEALED = 'draft', 'sealed'
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # Short code people type on the public verification page.
    code = models.CharField(max_length=16, unique=True)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    title = models.CharField(max_length=200)
    scope = models.CharField(max_length=SCOPE_MAX)
    scope_title = models.CharField(max_length=200, blank=True, default='')
    period_from = models.DateTimeField(null=True, blank=True)
    period_to = models.DateTimeField(null=True, blank=True)
    status = models.CharField(max_length=8, default=STATUS_DRAFT)
    message_count = models.IntegerField(default=0)
    participants = models.JSONField(default=list, blank=True)
    # Snapshot of the messages, encrypted at rest like every other attachment.
    # Named "file" so the core's key-rotation command finds it.
    file = models.FileField(upload_to=_package_upload, null=True, blank=True)
    snapshot_size = models.PositiveIntegerField(default=0)
    content_hash = models.CharField(max_length=HASH_MAX, blank=True, default='')
    chain_ok = models.BooleanField(null=True)
    chain_note = models.CharField(max_length=300, blank=True, default='')
    tsa_reply = models.BinaryField(null=True, blank=True)
    tsa_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    sealed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [models.Index(fields=['owner', '-created_at'])]

    @staticmethod
    def new_code():
        alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
        return '-'.join(''.join(secrets.choice(alphabet) for _ in range(4)) for _ in range(3))

    def read_snapshot(self) -> bytes:
        if not self.file:
            return b''
        with self.file.open('rb') as fh:
            return decrypt_bytes(fh.read())

    def write_snapshot(self, raw: bytes):
        from django.core.files.base import ContentFile

        self.file.save(f'{self.id}.json.enc', ContentFile(encrypt_bytes(raw)), save=False)
        self.snapshot_size = len(raw)


class Signature(models.Model):
    """One party's signature under a protocol."""
    METHOD_CODE, METHOD_FILE = 'code', 'file'
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    package = models.ForeignKey(Package, on_delete=models.CASCADE, related_name='signatures')
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name='+')
    signer_name = models.CharField(max_length=200)
    signer_email = models.CharField(max_length=200, blank=True, default='')
    method = models.CharField(max_length=8)
    signed_at = models.DateTimeField(auto_now_add=True)
    signed_hash = models.CharField(max_length=HASH_MAX)
    ip = models.CharField(max_length=64, blank=True, default='')
    user_agent = models.CharField(max_length=300, blank=True, default='')
    # Detached signature file (CMS / PKCS#7 / Госключ) and what could be read from it.
    file = models.FileField(upload_to=_package_upload, null=True, blank=True)
    cert_subject = models.CharField(max_length=400, blank=True, default='')
    cert_serial = models.CharField(max_length=80, blank=True, default='')
    cert_fingerprint = models.CharField(max_length=HASH_MAX, blank=True, default='')
    cert_valid_to = models.DateTimeField(null=True, blank=True)
    note = models.CharField(max_length=300, blank=True, default='')

    class Meta:
        ordering = ['signed_at']


class SignRequest(models.Model):
    """An invitation to sign, for a user of this server or an outside party."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    package = models.ForeignKey(Package, on_delete=models.CASCADE, related_name='requests')
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, null=True, blank=True, related_name='+')
    email = models.CharField(max_length=200, blank=True, default='')
    token = models.CharField(max_length=64, default=secrets.token_urlsafe, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)
    signed_at = models.DateTimeField(null=True, blank=True)


class SignCode(models.Model):
    """Six digits mailed to the signer: a simple electronic signature."""
    package = models.ForeignKey(Package, on_delete=models.CASCADE, related_name='codes')
    email = models.CharField(max_length=200)
    code = models.CharField(max_length=6)
    attempts = models.PositiveSmallIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=['package', 'email'])]
