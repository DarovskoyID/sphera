from rest_framework import serializers
from .models import Conversation, Message, Attachment
from ionik_auth.serializers import UserSerializer


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

    class Meta:
        model = Message
        fields = ['id', 'author', 'content', 'attachments', 'reply_to', 'is_pinned', 'created_at']


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
