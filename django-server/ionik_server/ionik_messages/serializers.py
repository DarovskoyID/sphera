from rest_framework import serializers
from .models import Conversation, Message
from ionik_auth.serializers import UserSerializer


class MessageSerializer(serializers.ModelSerializer):
    author = UserSerializer(read_only=True)
    content = serializers.CharField(read_only=True)

    class Meta:
        model = Message
        fields = ['id', 'author', 'content', 'created_at']


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
