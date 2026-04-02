from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    nickname = models.CharField(max_length=50, blank=True, default='')
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
    # Voice & Video
    auto_input_sensitivity = models.BooleanField(default=True)
    echo_cancellation = models.BooleanField(default=True)
    noise_suppression = models.BooleanField(default=True)
    # Chat
    chat_show_timestamps = models.BooleanField(default=True)
    chat_emoji_reactions = models.BooleanField(default=True)
    chat_compact_mode = models.BooleanField(default=False)
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
    # Language
    language = models.CharField(max_length=5, default='en')

    def __str__(self):
        return f"Settings for {self.user}"


class UserDevice(models.Model):
    user = models.ForeignKey(
        User, on_delete=models.CASCADE,
        related_name='devices',
    )
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
