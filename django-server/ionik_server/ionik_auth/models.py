import os
import uuid

from django.conf import settings
from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    nickname = models.CharField(max_length=50, blank=True, default='')
    phone = models.CharField(max_length=32, blank=True, default='')
    avatar = models.ImageField(upload_to='avatars/', blank=True, null=True)
    bio = models.CharField(max_length=200, blank=True, default='')
    status = models.CharField(
        max_length=10,
        choices=[
            ('online', 'Online'),
            ('idle', 'Idle'),
            ('dnd', 'DND'),
            ('offline', 'Offline'),
        ],
        default='offline',
    )

    def __str__(self):
        return self.username


class Friendship(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('accepted', 'Accepted'),
        ('rejected', 'Rejected'),
    ]

    from_user = models.ForeignKey(
        User, on_delete=models.CASCADE,
        related_name='sent_friend_requests',
    )
    to_user = models.ForeignKey(
        User, on_delete=models.CASCADE,
        related_name='received_friend_requests',
    )
    status = models.CharField(
        max_length=10, choices=STATUS_CHOICES, default='pending',
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('from_user', 'to_user')

    def __str__(self):
        return f"{self.from_user} -> {self.to_user} ({self.status})"


class BlockedUser(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    blocker = models.ForeignKey(
        User, on_delete=models.CASCADE,
        related_name='blocked_users',
    )
    blocked = models.ForeignKey(
        User, on_delete=models.CASCADE,
        related_name='blocked_by',
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('blocker', 'blocked')

    def __str__(self):
        return f"{self.blocker} blocked {self.blocked}"


class UserSettings(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(
        User, on_delete=models.CASCADE,
        related_name='settings',
    )
    # Profile
    show_profile_to_everyone = models.BooleanField(default=True)
    display_online_status = models.BooleanField(default=True)
    show_activity_status = models.BooleanField(default=False)
    # Privacy
    safe_dm_filter = models.BooleanField(default=True)
    scan_messages_everyone = models.BooleanField(default=True)
    scan_messages_non_friends = models.BooleanField(default=False)
    scan_messages_off = models.BooleanField(default=False)
    # Notifications
    enable_all_notifications = models.BooleanField(default=True)
    notify_direct_messages = models.BooleanField(default=True)
    notify_mentions = models.BooleanField(default=True)
    notify_all_server_messages = models.BooleanField(default=False)
    notify_friend_requests = models.BooleanField(default=True)
    sound_message = models.BooleanField(default=True)
    sound_incoming_call = models.BooleanField(default=True)
    # Appearance
    theme = models.CharField(max_length=10, default='dark')
    show_timestamps = models.BooleanField(default=True)
    show_avatars = models.BooleanField(default=True)
    # Mobile (applied by the WebView shell)
    allow_scale = models.BooleanField(default=False)
    # Voice & Video
    auto_input_sensitivity = models.BooleanField(default=True)
    echo_cancellation = models.BooleanField(default=True)
    noise_suppression = models.BooleanField(default=True)
    # Chat
    chat_show_timestamps = models.BooleanField(default=True)
    chat_emoji_reactions = models.BooleanField(default=True)
    chat_compact_mode = models.BooleanField(default=False)
    chat_message_spacing = models.PositiveSmallIntegerField(default=4)
    # Data & Privacy
    data_app_improvements = models.BooleanField(default=True)
    data_personalization = models.BooleanField(default=True)
    # Streamer
    streamer_mode = models.BooleanField(default=False)
    streamer_hide_info = models.BooleanField(default=False)
    streamer_disable_notifs = models.BooleanField(default=False)
    # Advanced
    developer_mode = models.BooleanField(default=False)
    hardware_acceleration = models.BooleanField(default=False)
    # Activity Privacy
    show_current_activity = models.BooleanField(default=True)
    show_game_status = models.BooleanField(default=True)
    # Accessibility
    high_contrast = models.BooleanField(default=False)
    screen_reader = models.BooleanField(default=False)
    reduce_motion = models.BooleanField(default=False)
    large_text = models.BooleanField(default=False)
    keyboard_outlines = models.BooleanField(default=False)
    # Language
    language = models.CharField(max_length=5, default='en')

    def __str__(self):
        return f"Settings for {self.user}"


class UserDevice(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        User, on_delete=models.CASCADE,
        related_name='devices',
    )
    # Stable per-install id reported by the client (X-Device-Id). Used as the
    # dedup key so devices are no longer (incorrectly) keyed by IP address.
    device_id = models.CharField(max_length=128, null=True, blank=True, db_index=True)
    device_name = models.CharField(max_length=200)
    device_type = models.CharField(
        max_length=20,
        choices=[
            ('desktop', 'Desktop'),
            ('mobile', 'Mobile'),
            ('tablet', 'Tablet'),
            ('other', 'Other'),
        ],
        default='other',
    )
    ip_address = models.GenericIPAddressField()
    last_login = models.DateTimeField(auto_now=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-last_login']

    def __str__(self):
        return f"{self.user} - {self.device_name} ({self.ip_address})"


class FcmToken(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='fcm_tokens')
    token = models.TextField(unique=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"{self.user} — {self.token[:20]}..."


class DataExport(models.Model):
    """A user-requested export of everything they have written on the platform.

    Built asynchronously (it may take several minutes); the client polls the
    status endpoint and downloads the JSON file once it is ready.
    """
    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('ready', 'Ready'),
        ('failed', 'Failed'),
    ]
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name='data_exports',
    )
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default='pending')
    file = models.FileField(upload_to='data_exports/', blank=True, null=True)
    item_count = models.PositiveIntegerField(default=0)
    error = models.TextField(blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"DataExport({self.user} — {self.status})"


def _emoji_upload_path(instance, filename):
    ext = os.path.splitext(filename)[1] or '.png'
    return f'emojis/{uuid.uuid4().hex}{ext}'


class CustomEmoji(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.SlugField(max_length=50, unique=True)
    image = models.ImageField(upload_to=_emoji_upload_path)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='custom_emojis'
    )
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f':{self.name}:'
