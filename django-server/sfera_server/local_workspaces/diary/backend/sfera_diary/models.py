import uuid

from django.conf import settings
from django.db import models

from sfera_messages.encryption import decrypt_text, encrypt_text
from sfera_messages.models import RichPayloadMixin

MAX_DIARIES = 3


def _attachment_upload_path(instance, filename):
    return f'attachments/{uuid.uuid4().hex}.enc'


class Diary(models.Model):
    """A private, owner-only journal."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='diaries')
    name = models.CharField(max_length=100)
    created_at = models.DateTimeField(auto_now_add=True)
    # Guild the diary was migrated from (pre-module era); keeps ids stable for clients.
    legacy_guild_id = models.UUIDField(null=True, blank=True, unique=True)

    class Meta:
        ordering = ['created_at']

    def __str__(self):
        return self.name


class DiaryEntry(RichPayloadMixin):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    diary = models.ForeignKey(Diary, on_delete=models.CASCADE, related_name='entries')
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    encrypted_content = models.TextField(blank=True, default='')
    tags = models.JSONField(default=list, blank=True)
    edited = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['created_at']
        indexes = [models.Index(fields=['diary', '-created_at'])]

    @property
    def content(self):
        return decrypt_text(self.encrypted_content) if self.encrypted_content else ''

    @content.setter
    def content(self, value):
        self.encrypted_content = encrypt_text(value)


class DiaryAttachment(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    diary = models.ForeignKey(Diary, on_delete=models.CASCADE, related_name='attachments')
    entry = models.ForeignKey(DiaryEntry, on_delete=models.SET_NULL, null=True, blank=True, related_name='attachments')
    uploader = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    file = models.FileField(upload_to=_attachment_upload_path)
    original_filename = models.CharField(max_length=255)
    content_type = models.CharField(max_length=100)
    file_size = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)


class DiaryPollVote(models.Model):
    # related_name matches what sfera_messages.rich.poll_view reads.
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    message = models.ForeignKey(DiaryEntry, on_delete=models.CASCADE, related_name='poll_votes')
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    option_id = models.CharField(max_length=32)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('message', 'user', 'option_id')


class DiaryTodoCheck(models.Model):
    # related_name matches what sfera_messages.rich.todo_view reads.
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    message = models.ForeignKey(DiaryEntry, on_delete=models.CASCADE, related_name='todo_checks')
    item_id = models.CharField(max_length=32)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('message', 'item_id')
