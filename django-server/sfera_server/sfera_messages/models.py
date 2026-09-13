import json
import uuid
from django.db import models
from django.conf import settings
from sfera_messages.encryption import encrypt_text, decrypt_text

# Rich message kinds. 'text' is the plain message every existing row already is.
MESSAGE_TYPE_TEXT = 'text'
MESSAGE_TYPE_POLL = 'poll'
MESSAGE_TYPE_TODO = 'todo'
MESSAGE_TYPE_CONTACT = 'contact'
MESSAGE_TYPE_LOCATION = 'location'
MESSAGE_TYPE_CHOICES = [
    (MESSAGE_TYPE_TEXT, 'Text'),
    (MESSAGE_TYPE_POLL, 'Poll'),
    (MESSAGE_TYPE_TODO, 'Todo'),
    (MESSAGE_TYPE_CONTACT, 'Contact'),
    (MESSAGE_TYPE_LOCATION, 'Location'),
]


class RichPayloadMixin(models.Model):
    """Structured body for non-text messages (poll/todo/contact/location).

    The payload is encrypted at rest like message content, because it can hold
    personal data (a shared phone number, GPS coordinates). `live_until` is kept
    as a real column so live-location expiry stays queryable.
    """
    message_type = models.CharField(
        max_length=16, choices=MESSAGE_TYPE_CHOICES, default=MESSAGE_TYPE_TEXT, db_index=True
    )
    encrypted_payload = models.TextField(blank=True, default='')
    live_until = models.DateTimeField(null=True, blank=True)

    class Meta:
        abstract = True

    @property
    def payload(self):
        if not self.encrypted_payload:
            return {}
        try:
            return json.loads(decrypt_text(self.encrypted_payload))
        except (ValueError, TypeError):
            return {}

    @payload.setter
    def payload(self, value):
        self.encrypted_payload = (
            encrypt_text(json.dumps(value, ensure_ascii=False)) if value else ''
        )


class Conversation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    participants = models.ManyToManyField(
        settings.AUTH_USER_MODEL,
        through='ConversationParticipant',
        related_name='conversations',
    )
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        names = ', '.join(u.username for u in self.participants.all()[:3])
        return f'Conversation({names})'


class ConversationParticipant(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name='+')
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')

    class Meta:
        unique_together = ('conversation', 'user')


class Message(RichPayloadMixin):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name='messages')
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='sent_messages')
    encrypted_content = models.TextField()
    reply_to = models.ForeignKey('self', null=True, blank=True, on_delete=models.SET_NULL, related_name='replies')
    is_pinned = models.BooleanField(default=False)
    edited = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    # Receipt timestamps for the OTHER participant (DM is always 1-on-1).
    delivered_at = models.DateTimeField(null=True, blank=True)
    read_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['created_at']
        indexes = [
            models.Index(fields=['conversation', '-created_at']),
        ]

    @property
    def content(self):
        return decrypt_text(self.encrypted_content)

    @content.setter
    def content(self, value):
        self.encrypted_content = encrypt_text(value)

    def __str__(self):
        return f'{self.author.username}: {self.content[:40]}'


def _attachment_upload_path(instance, filename):
    return f'attachments/{uuid.uuid4().hex}.enc'


class Attachment(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name='attachments')
    uploader = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    message = models.ForeignKey(
        Message, on_delete=models.SET_NULL, null=True, blank=True, related_name='attachments'
    )
    file = models.FileField(upload_to=_attachment_upload_path)
    original_filename = models.CharField(max_length=255)
    content_type = models.CharField(max_length=100)
    file_size = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f'{self.original_filename} ({self.file_size} bytes)'


class MessagePin(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='pinned_messages')
    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name='pins')

    class Meta:
        unique_together = ('user', 'message')
        indexes = [
            models.Index(fields=['user', 'message']),
        ]


class MessageReport(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    reporter = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='reports')
    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name='reports')
    created_at = models.DateTimeField(auto_now_add=True)
    # Closed by the superuser in the admin panel.
    resolved_at = models.DateTimeField(null=True, blank=True)
    resolved_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    resolution = models.CharField(max_length=16, blank=True, default='')

    class Meta:
        unique_together = ('reporter', 'message')

    def __str__(self):
        return f'{self.reporter.username} reported msg {self.message_id}'


class ScheduledMessage(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name='scheduled_messages')
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    encrypted_content = models.TextField()
    send_at = models.DateTimeField(db_index=True)
    reply_to = models.ForeignKey(Message, null=True, blank=True, on_delete=models.SET_NULL)
    attachment_ids = models.JSONField(default=list)
    is_sent = models.BooleanField(default=False, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    @property
    def content(self):
        return decrypt_text(self.encrypted_content)

    def __str__(self):
        return f'Scheduled by {self.author.username} at {self.send_at}'


class TodoCheck(models.Model):
    """A ticked checklist item in a DM. Shared state: one row per item, and it
    records who ticked it (unique on message+item, not per user)."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name='todo_checks')
    item_id = models.CharField(max_length=32)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('message', 'item_id')


class ChatSafetySettings(models.Model):
    """Instance-wide chat safety switches, set by the superuser. Single row (pk=1)."""
    # Block any message that looks like a secret code (SMS/bank/app code),
    # not only one somebody in the chat has just asked for.
    block_all_codes = models.BooleanField(default=False)
    updated_at = models.DateTimeField(auto_now=True)

    @classmethod
    def get(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj
