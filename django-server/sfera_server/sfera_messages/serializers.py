from rest_framework import serializers
from .models import Conversation, Message, Attachment, MESSAGE_TYPE_TEXT
from .rich import rich_fields
from sfera_auth.serializers import UserSerializer


class AttachmentSerializer(serializers.ModelSerializer):
    filename = serializers.CharField(source='original_filename', read_only=True)
    url = serializers.SerializerMethodField()

    class Meta:
        model = Attachment
        fields = ['id', 'filename', 'content_type', 'file_size', 'url', 'created_at']

    def get_url(self, obj):
        return f'/api/attachments/{obj.id}/'


class ReplyPreviewSerializer(serializers.ModelSerializer):
    author = UserSerializer(read_only=True)
    content = serializers.CharField(read_only=True)

    class Meta:
        model = Message
        fields = ['id', 'author', 'content']


class MessageSerializer(serializers.ModelSerializer):
    author = UserSerializer(read_only=True)
    content = serializers.CharField(read_only=True)
    attachments = AttachmentSerializer(many=True, read_only=True)
    reply_to = ReplyPreviewSerializer(read_only=True)
    is_pinned = serializers.SerializerMethodField()
    message_type = serializers.CharField(read_only=True)
    payload = serializers.SerializerMethodField()

    class Meta:
        model = Message
        fields = ['id', 'author', 'content', 'attachments', 'reply_to', 'is_pinned', 'created_at', 'delivered_at', 'read_at', 'message_type', 'payload']

    def get_is_pinned(self, obj):
        pinned_ids = self.context.get('pinned_ids')
        if pinned_ids is not None:
            return obj.id in pinned_ids
        return False

    def get_payload(self, obj):
        # Plain text is the overwhelming majority — skip the work entirely.
        if (obj.message_type or MESSAGE_TYPE_TEXT) == MESSAGE_TYPE_TEXT:
            return None
        request = self.context.get('request')
        return rich_fields(obj, getattr(request, 'user', None))['payload']


class ConversationSerializer(serializers.ModelSerializer):
    participants = UserSerializer(many=True, read_only=True)
    last_message = serializers.SerializerMethodField()

    class Meta:
        model = Conversation
        fields = ['id', 'participants', 'last_message', 'created_at']

    def get_last_message(self, obj):
        msg = obj.messages.order_by('-created_at').first()
        if msg:
            return MessageSerializer(msg).data
        return None
