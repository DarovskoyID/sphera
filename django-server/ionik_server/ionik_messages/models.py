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
