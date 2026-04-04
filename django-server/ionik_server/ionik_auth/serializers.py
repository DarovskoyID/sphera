from rest_framework import serializers
from .models import User, Friendship, BlockedUser, UserDevice, UserSettings, CustomEmoji


class UserSerializer(serializers.ModelSerializer):
    avatar = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ['id', 'username', 'nickname', 'avatar', 'bio', 'status']

    def get_avatar(self, obj):
        if not obj.avatar:
            return ''
        request = self.context.get('request')
        if request:
            return request.build_absolute_uri(obj.avatar.url)
        return obj.avatar.url


class ProfileUpdateSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ['nickname', 'bio', 'avatar']
        extra_kwargs = {
            'nickname': {'required': False},
            'bio': {'required': False},
            'avatar': {'required': False},
        }


class RegisterSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, min_length=6)

    class Meta:
        model = User
        fields = ['username', 'password', 'nickname', 'avatar', 'bio']

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
            request = self.context.get('request')
            if request:
                return request.build_absolute_uri(obj.image.url)
            return obj.image.url
        return ''
