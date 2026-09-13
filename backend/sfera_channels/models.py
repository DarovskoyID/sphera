import secrets
import uuid

from django.conf import settings
from django.db import models

from sfera_messages.encryption import decrypt_text, encrypt_text
from sfera_messages.models import RichPayloadMixin

MAX_OWNED_CHANNELS = 3
MAX_SUBSCRIPTIONS = 75


def _attachment_upload_path(instance, filename):
    return f'attachments/{uuid.uuid4().hex}.enc'


def _invite_code():
    return secrets.token_urlsafe(8)[:8]


class Channel(models.Model):
    """A personal feed: the owner publishes, subscribers read, react and comment."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='owned_feed_channels')
    name = models.CharField(max_length=100, db_index=True)
    description = models.TextField(blank=True)
    tags = models.JSONField(default=list, blank=True)
    icon = models.ImageField(upload_to='guild_icons/', null=True, blank=True)
    banner = models.ImageField(upload_to='guild_banners/', null=True, blank=True)
    invite_code = models.CharField(max_length=16, unique=True, default=_invite_code)
    is_discoverable = models.BooleanField(default=True)
    comments_enabled = models.BooleanField(default=True)
    is_official = models.BooleanField(default=False, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    legacy_guild_id = models.UUIDField(null=True, blank=True, unique=True)

    class Meta:
        indexes = [models.Index(fields=['is_discoverable', 'name'])]

    def __str__(self):
        return self.name


class Subscription(models.Model):
    ROLE_CHOICES = [('owner', 'Owner'), ('subscriber', 'Subscriber')]
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    channel = models.ForeignKey(Channel, on_delete=models.CASCADE, related_name='subscriptions')
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='feed_subscriptions')
    role = models.CharField(max_length=12, choices=ROLE_CHOICES, default='subscriber')
    notifications_muted = models.BooleanField(default=False)
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('channel', 'user')


class Post(RichPayloadMixin):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    channel = models.ForeignKey(Channel, on_delete=models.CASCADE, related_name='posts')
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    encrypted_content = models.TextField(blank=True, default='')
    tags = models.JSONField(default=list, blank=True)
    is_pinned = models.BooleanField(default=False)
    edited = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['created_at']
        indexes = [models.Index(fields=['channel', '-created_at'])]

    @property
    def content(self):
        return decrypt_text(self.encrypted_content) if self.encrypted_content else ''

    @content.setter
    def content(self, value):
        self.encrypted_content = encrypt_text(value)


class PostAttachment(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    channel = models.ForeignKey(Channel, on_delete=models.CASCADE, related_name='attachments')
    post = models.ForeignKey(Post, on_delete=models.SET_NULL, null=True, blank=True, related_name='attachments')
    uploader = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    file = models.FileField(upload_to=_attachment_upload_path)
    original_filename = models.CharField(max_length=255)
    content_type = models.CharField(max_length=100)
    file_size = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)


class ScheduledPost(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    channel = models.ForeignKey(Channel, on_delete=models.CASCADE, related_name='scheduled_posts')
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    encrypted_content = models.TextField(blank=True, default='')
    attachment_ids = models.JSONField(default=list)
    send_at = models.DateTimeField(db_index=True)
    is_sent = models.BooleanField(default=False, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    @property
    def content(self):
        return decrypt_text(self.encrypted_content) if self.encrypted_content else ''


class PostReaction(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    post = models.ForeignKey(Post, on_delete=models.CASCADE, related_name='reactions')
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    emoji = models.CharField(max_length=50)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('post', 'user', 'emoji')


class PostView(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    post = models.ForeignKey(Post, on_delete=models.CASCADE, related_name='views')
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('post', 'user')


class PostComment(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    post = models.ForeignKey(Post, on_delete=models.CASCADE, related_name='comments')
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    encrypted_content = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['created_at']

    @property
    def content(self):
        return decrypt_text(self.encrypted_content)

    @content.setter
    def content(self, value):
        self.encrypted_content = encrypt_text(value)


class PostPollVote(models.Model):
    # related_name matches sfera_messages.rich.poll_view.
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    message = models.ForeignKey(Post, on_delete=models.CASCADE, related_name='poll_votes')
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    option_id = models.CharField(max_length=32)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('message', 'user', 'option_id')


class PostTodoCheck(models.Model):
    # related_name matches sfera_messages.rich.todo_view.
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    message = models.ForeignKey(Post, on_delete=models.CASCADE, related_name='todo_checks')
    item_id = models.CharField(max_length=32)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('message', 'item_id')
