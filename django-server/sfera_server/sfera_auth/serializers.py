from datetime import timedelta

from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils import timezone
from rest_framework import serializers
from .models import User, Friendship, BlockedUser, UserDevice, UserSettings, CustomEmoji


def compute_verification(user):
    """Trust / verification level for a user.

    Level 1 — email is set on the profile.
    Level 2 — phone number is set.
    Level 3 — no complaints in the last 3 months and registered > 3 months ago.
    Level 4 — no complaints in the last year and registered > 1 year ago.

    Levels are cumulative-by-best: the highest satisfied tier wins.
    """
    # Imported lazily to avoid a circular import with sfera_messages.
    from sfera_messages.models import MessageReport

    now = timezone.now()
    has_email = bool(user.email)
    has_phone = bool(getattr(user, 'phone', ''))
    joined = user.date_joined
    age_3m = joined <= now - timedelta(days=90)
    age_1y = joined <= now - timedelta(days=365)

    reports = MessageReport.objects.filter(message__author=user)
    clean_3m = age_3m and not reports.filter(
        created_at__gte=now - timedelta(days=90)).exists()
    clean_1y = age_1y and not reports.filter(
        created_at__gte=now - timedelta(days=365)).exists()

    level = 0
    if has_email:
        level = max(level, 1)
    if has_phone:
        level = max(level, 2)
    if clean_3m:
        level = max(level, 3)
    if clean_1y:
        level = max(level, 4)

    return {
        'level': level,
        'has_email': has_email,
        'has_phone': has_phone,
        'clean_3_months': clean_3m,
        'clean_1_year': clean_1y,
    }


class UserSerializer(serializers.ModelSerializer):
    avatar = serializers.SerializerMethodField()
    verification_level = serializers.SerializerMethodField()
    verification = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            'id', 'username', 'nickname', 'avatar', 'bio', 'status',
            'account_type', 'verification_level', 'verification',
        ]

    def get_avatar(self, obj):
        if not obj.avatar:
            return ''
        request = self.context.get('request')
        if request:
            return request.build_absolute_uri(obj.avatar.url)
        return obj.avatar.url

    def _verification(self, obj):
        cache = getattr(self, '_verif_cache', None)
        if cache is None:
            cache = {}
            self._verif_cache = cache
        if obj.id not in cache:
            cache[obj.id] = compute_verification(obj)
        return cache[obj.id]

    def get_verification_level(self, obj):
        return self._verification(obj)['level']

    def get_verification(self, obj):
        return self._verification(obj)


class MeSerializer(UserSerializer):
    """Like UserSerializer but exposes the owner's private fields."""

    class Meta(UserSerializer.Meta):
        fields = UserSerializer.Meta.fields + ['email', 'phone', 'date_joined']


class ProfileUpdateSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ['nickname', 'bio', 'avatar', 'email', 'phone']
        extra_kwargs = {
            'nickname': {'required': False},
            'bio': {'required': False},
            'avatar': {'required': False},
            'email': {'required': False},
            'phone': {'required': False},
        }


class RegisterSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True)
    email = serializers.EmailField(required=True)

    class Meta:
        model = User
        fields = ['username', 'password', 'email', 'nickname', 'avatar', 'bio']

    def validate_password(self, value):
        # Apply the project-wide AUTH_PASSWORD_VALIDATORS (length, common, …).
        try:
            validate_password(value)
        except DjangoValidationError as exc:
            raise serializers.ValidationError(list(exc.messages))
        return value

    def validate_username(self, value):
        if User.objects.filter(username__iexact=value).exists():
            raise serializers.ValidationError('A user with that username already exists.')
        return value

    def validate_email(self, value):
        value = value.strip().lower()
        if User.objects.filter(email__iexact=value).exists():
            raise serializers.ValidationError('A user with that email already exists.')
        return value

    def create(self, validated_data):
        return User.objects.create_user(**validated_data)


class FriendshipSerializer(serializers.ModelSerializer):
    from_user = UserSerializer(read_only=True)
    to_user = UserSerializer(read_only=True)

    class Meta:
        model = Friendship
        fields = ['id', 'from_user', 'to_user', 'status', 'created_at']


class BlockedUserSerializer(serializers.ModelSerializer):
    blocked = UserSerializer(read_only=True)

    class Meta:
        model = BlockedUser
        fields = ['id', 'blocked', 'created_at']


class UserDeviceSerializer(serializers.ModelSerializer):
    class Meta:
        model = UserDevice
        fields = [
            'id', 'device_name', 'device_type',
            'ip_address', 'last_login', 'created_at',
        ]


class UserSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = UserSettings
        exclude = ['id', 'user']


class CustomEmojiSerializer(serializers.ModelSerializer):
    image_url = serializers.SerializerMethodField()
    created_by = serializers.CharField(source='created_by.username', read_only=True)

    class Meta:
        model = CustomEmoji
        fields = ['id', 'name', 'image_url', 'created_by', 'created_at']

    def get_image_url(self, obj):
        if obj.image:
            return obj.image.url  # relative path e.g. /media/emojis/...
        return ''
