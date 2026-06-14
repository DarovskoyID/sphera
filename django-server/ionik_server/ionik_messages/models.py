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

    class Meta:
        unique_together = ('reporter', 'message')

    def __str__(self):
        return f'{self.reporter.username} reported msg {self.message_id}'


class Guild(models.Model):
    """A Discord-like server (guild)."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=100)
    description = models.TextField(blank=True)
    tag = models.CharField(max_length=8, blank=True, default='')
    icon = models.ImageField(upload_to='guild_icons/', null=True, blank=True)
    banner = models.ImageField(upload_to='guild_banners/', null=True, blank=True)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='owned_guilds')
    created_at = models.DateTimeField(auto_now_add=True)
    invite_code = models.CharField(max_length=16, unique=True, blank=True)
    boost_level = models.PositiveIntegerField(default=0)
    verification_level = models.CharField(max_length=20, default='none')
    default_notifications = models.CharField(max_length=20, default='all')
    explicit_content_filter = models.CharField(max_length=30, default='disabled')
    require_2fa = models.BooleanField(default=False)

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
    muted_until = models.DateTimeField(null=True, blank=True)
    notifications_muted = models.BooleanField(default=False)

    class Meta:
        unique_together = ('guild', 'user')

    def __str__(self):
        return f'{self.user.username} in {self.guild.name} ({self.role})'


class GuildCategory(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    guild = models.ForeignKey(Guild, on_delete=models.CASCADE, related_name='categories')
    name = models.CharField(max_length=100)
    position = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['position', 'created_at']

    def __str__(self):
        return f'{self.name} ({self.guild.name})'


class GuildChannel(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    CHANNEL_TYPE_CHOICES = [('text', 'Text'), ('voice', 'Voice')]
    guild = models.ForeignKey(Guild, on_delete=models.CASCADE, related_name='channels')
    category = models.ForeignKey(GuildCategory, on_delete=models.SET_NULL, null=True, blank=True, related_name='channels')
    name = models.CharField(max_length=100)
    channel_type = models.CharField(max_length=10, choices=CHANNEL_TYPE_CHOICES, default='text')
    topic = models.CharField(max_length=1024, blank=True)
    position = models.PositiveIntegerField(default=0)
    user_limit = models.PositiveIntegerField(default=0)
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


class GuildEmoji(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    guild = models.ForeignKey(Guild, on_delete=models.CASCADE, related_name='emojis')
    name = models.CharField(max_length=50)
    image = models.ImageField(upload_to='guild_emojis/')
    uploader = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('guild', 'name')

    def __str__(self):
        return f':{self.name}: ({self.guild.name})'


class GuildSticker(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    guild = models.ForeignKey(Guild, on_delete=models.CASCADE, related_name='stickers')
    name = models.CharField(max_length=50)
    description = models.CharField(max_length=200, blank=True)
    image = models.ImageField(upload_to='guild_stickers/')
    uploader = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f'{self.name} ({self.guild.name})'


class GuildSound(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    guild = models.ForeignKey(Guild, on_delete=models.CASCADE, related_name='sounds')
    name = models.CharField(max_length=50)
    file = models.FileField(upload_to='guild_sounds/')
    uploader = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f'{self.name} ({self.guild.name})'


class GuildRole(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    guild = models.ForeignKey(Guild, on_delete=models.CASCADE, related_name='custom_roles')
    name = models.CharField(max_length=50)
    color = models.CharField(max_length=7, default='#99aab5')
    permissions = models.JSONField(default=list)
    position = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['position', 'created_at']

    def __str__(self):
        return f'{self.name} ({self.guild.name})'


class GuildMemberRole(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    membership = models.ForeignKey(GuildMembership, on_delete=models.CASCADE, related_name='custom_role_assignments')
    role = models.ForeignKey(GuildRole, on_delete=models.CASCADE, related_name='member_assignments')

    class Meta:
        unique_together = ('membership', 'role')


class GuildInvite(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    guild = models.ForeignKey(Guild, on_delete=models.CASCADE, related_name='invites')
    creator = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='+')
    code = models.CharField(max_length=16, unique=True, blank=True)
    max_uses = models.PositiveIntegerField(null=True, blank=True)
    uses = models.PositiveIntegerField(default=0)
    expires_at = models.DateTimeField(null=True, blank=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def save(self, *args, **kwargs):
        if not self.code:
            import secrets
            self.code = secrets.token_urlsafe(8)[:8]
        super().save(*args, **kwargs)

    def __str__(self):
        return f'Invite {self.code} for {self.guild.name}'


class GuildAuditLog(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    guild = models.ForeignKey(Guild, on_delete=models.CASCADE, related_name='audit_logs')
    action = models.CharField(max_length=50)
    actor_id = models.CharField(max_length=40)
    actor_username = models.CharField(max_length=150)
    target_id = models.CharField(max_length=40, blank=True)
    target_username = models.CharField(max_length=150, blank=True)
    details = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.action} by {self.actor_username} in {self.guild.name}'
