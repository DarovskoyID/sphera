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
        # Deliberately lean: this is embedded in every message, member list and
        # friend entry, so anything added here is paid for thousands of times
        # over. The profile-only fields live in ProfileSerializer below.
        fields = [
            'id', 'username', 'nickname', 'avatar', 'bio', 'status',
            'account_type', 'is_superuser', 'verification_level', 'verification',
        ]
        read_only_fields = ['is_superuser']

    def _image(self, image):
        if not image:
            return ''
        request = self.context.get('request')
        if request:
            return request.build_absolute_uri(image.url)
        return image.url

    def get_avatar(self, obj):
        return self._image(obj.avatar)

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


class ProfileSerializer(UserSerializer):
    """Everything the profile screen shows, and nothing that belongs in a list.

    Fetched one user at a time, so it can afford the banner, the links and the
    join date that UserSerializer cannot.
    """

    banner = serializers.SerializerMethodField()

    def get_banner(self, obj):
        return self._image(obj.banner)

    class Meta(UserSerializer.Meta):
        fields = UserSerializer.Meta.fields + [
            'banner', 'status_text', 'links', 'date_joined',
        ]


class MeSerializer(ProfileSerializer):
    """Like ProfileSerializer but exposes the owner's private fields."""

    # Whether a parent manages this account. The client hides what a child must
    # not reach — paid pages, bot creation — and shows the content filter as
    # locked rather than absent. None of that is the enforcement, which lives
    # on the server; it is so the screens tell the truth about themselves.
    is_child = serializers.SerializerMethodField()

    def get_is_child(self, obj):
        from .models import is_child
        return is_child(obj)

    class Meta(ProfileSerializer.Meta):
        fields = ProfileSerializer.Meta.fields + ['email', 'phone', 'is_child']


#: Most links a profile may carry. Enough for the places people actually are.
MAX_PROFILE_LINKS = 5
MAX_LINK_LABEL = 30
MAX_LINK_URL = 200


class ProfileUpdateSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = [
            # `status` is presence, and the owner is the one who decides what
            # it says — including staying on "offline" while connected. The
            # model's choices are the whole validation it needs.
            'nickname', 'bio', 'avatar', 'banner', 'status', 'status_text',
            'links', 'email', 'phone',
        ]
        extra_kwargs = {
            name: {'required': False} for name in fields
        }

    def validate_email(self, value):
        """An address may move to another account, but never be shared."""
        value = (value or '').strip().lower()
        if not value:
            return value
        taken = User.objects.filter(email__iexact=value)
        if self.instance is not None:
            taken = taken.exclude(pk=self.instance.pk)
        if taken.exists():
            raise serializers.ValidationError('A user with that email already exists.')
        return value

    def validate_links(self, value):
        """Links are free text from the profile owner and end up as anchors.

        So they are checked here rather than trusted at render time: the shape
        must be right, the scheme must be one a browser will not execute, and
        the whole thing must stay small. `javascript:` in an href is the reason
        this method exists.
        """
        if value in (None, ''):
            return []
        if not isinstance(value, list):
            raise serializers.ValidationError('links must be a list')
        if len(value) > MAX_PROFILE_LINKS:
            raise serializers.ValidationError(
                f'at most {MAX_PROFILE_LINKS} links'
            )

        cleaned = []
        for entry in value:
            if not isinstance(entry, dict):
                raise serializers.ValidationError('each link must be an object')
            url = str(entry.get('url', '')).strip()
            label = str(entry.get('label', '')).strip()
            if not url:
                continue
            if not url.startswith(('http://', 'https://')):
                raise serializers.ValidationError(
                    'links must start with http:// or https://'
                )
            cleaned.append({
                'label': label[:MAX_LINK_LABEL],
                'url': url[:MAX_LINK_URL],
            })
        return cleaned


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
