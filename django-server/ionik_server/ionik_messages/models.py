import uuid
from django.db import models
from django.conf import settings
from ionik_messages.encryption import encrypt_text, decrypt_text


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


class Message(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
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


class MessageReport(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    reporter = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='reports')
    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name='reports')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('reporter', 'message')

    def __str__(self):
        return f'{self.reporter.username} reported msg {self.message_id}'


class Guild(models.Model):
    """A Discord-like server (guild)."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=100)
    description = models.TextField(blank=True)
    icon = models.ImageField(upload_to='guild_icons/', null=True, blank=True)
    banner = models.ImageField(upload_to='guild_banners/', null=True, blank=True)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='owned_guilds')
    created_at = models.DateTimeField(auto_now_add=True)
    invite_code = models.CharField(max_length=16, unique=True, blank=True)

    def save(self, *args, **kwargs):
        if not self.invite_code:
            import secrets
            self.invite_code = secrets.token_urlsafe(8)[:8]
        super().save(*args, **kwargs)

    def __str__(self):
        return self.name


class GuildMembership(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    ROLE_CHOICES = [('owner', 'Owner'), ('admin', 'Admin'), ('member', 'Member')]
    guild = models.ForeignKey(Guild, on_delete=models.CASCADE, related_name='memberships')
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='guild_memberships')
    role = models.CharField(max_length=10, choices=ROLE_CHOICES, default='member')
    nickname = models.CharField(max_length=50, blank=True)
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('guild', 'user')

    def __str__(self):
        return f'{self.user.username} in {self.guild.name} ({self.role})'


class GuildChannel(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    CHANNEL_TYPE_CHOICES = [('text', 'Text'), ('voice', 'Voice')]
    guild = models.ForeignKey(Guild, on_delete=models.CASCADE, related_name='channels')
    name = models.CharField(max_length=100)
    channel_type = models.CharField(max_length=10, choices=CHANNEL_TYPE_CHOICES, default='text')
    topic = models.CharField(max_length=1024, blank=True)
    position = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['position', 'created_at']

    def __str__(self):
        return f'#{self.name} ({self.guild.name})'


class GuildMessage(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    channel = models.ForeignKey(GuildChannel, on_delete=models.CASCADE, related_name='messages')
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='guild_messages')
    encrypted_content = models.TextField()
    reply_to = models.ForeignKey('self', null=True, blank=True, on_delete=models.SET_NULL, related_name='replies')
    is_pinned = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['created_at']
        indexes = [
            models.Index(fields=['channel', '-created_at']),
        ]

    @property
    def content(self):
        return decrypt_text(self.encrypted_content)

    @content.setter
    def content(self, value):
        self.encrypted_content = encrypt_text(value)

    def __str__(self):
        return f'{self.author.username} in #{self.channel.name}: {self.content[:40]}'


class GuildAttachment(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    channel = models.ForeignKey(GuildChannel, on_delete=models.CASCADE, related_name='attachments')
    uploader = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    message = models.ForeignKey(GuildMessage, on_delete=models.SET_NULL, null=True, blank=True, related_name='attachments')
    file = models.FileField(upload_to=_attachment_upload_path)
    original_filename = models.CharField(max_length=255)
    content_type = models.CharField(max_length=100)
    file_size = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f'{self.original_filename} ({self.file_size} bytes)'


class GuildScheduledMessage(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    channel = models.ForeignKey(GuildChannel, on_delete=models.CASCADE, related_name='scheduled_messages')
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    encrypted_content = models.TextField()
    send_at = models.DateTimeField(db_index=True)
    reply_to = models.ForeignKey(GuildMessage, null=True, blank=True, on_delete=models.SET_NULL)
    attachment_ids = models.JSONField(default=list)
    is_sent = models.BooleanField(default=False, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    @property
    def content(self):
        return decrypt_text(self.encrypted_content)

    def __str__(self):
        return f'Guild scheduled by {self.author.username} at {self.send_at}'


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
