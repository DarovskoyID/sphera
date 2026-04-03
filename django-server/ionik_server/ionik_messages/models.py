import uuid
from django.db import models
from django.conf import settings
from ionik_messages.encryption import encrypt_text, decrypt_text


class Conversation(models.Model):
    participants = models.ManyToManyField(settings.AUTH_USER_MODEL, related_name='conversations')
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        names = ', '.join(u.username for u in self.participants.all()[:3])
        return f'Conversation({names})'


class Message(models.Model):
    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name='messages')
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='sent_messages')
    encrypted_content = models.TextField()
    reply_to = models.ForeignKey('self', null=True, blank=True, on_delete=models.SET_NULL, related_name='replies')
    is_pinned = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

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


class MessageReport(models.Model):
    reporter = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='reports')
    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name='reports')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('reporter', 'message')

    def __str__(self):
        return f'{self.reporter.username} reported msg {self.message_id}'
