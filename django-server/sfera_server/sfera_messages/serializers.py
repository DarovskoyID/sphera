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

    def to_representation(self, instance):
        from .mesh_delivery import enabled, visible
        if enabled() and not visible(Message.objects.using(instance._state.db).filter(pk=instance.pk)).exists():
            return None
        return super().to_representation(instance)


class MessageSerializer(serializers.ModelSerializer):
    author = UserSerializer(read_only=True)
    content = serializers.CharField(read_only=True)
    attachments = AttachmentSerializer(many=True, read_only=True)
    reply_to = ReplyPreviewSerializer(read_only=True)
    is_pinned = serializers.SerializerMethodField()
    message_type = serializers.CharField(read_only=True)
    payload = serializers.SerializerMethodField()
    publication_state = serializers.SerializerMethodField()
    cipher_read_receipt = serializers.SerializerMethodField()

    class Meta:
        model = Message
        fields = ['id', 'author', 'content', 'attachments', 'reply_to', 'is_pinned', 'edited', 'created_at', 'delivered_at', 'read_at', 'message_type', 'payload', 'publication_state', 'cipher_read_receipt']

    def get_cipher_read_receipt(self, obj):
        if obj.message_type != 'cipher': return None
        from django.core.exceptions import ObjectDoesNotExist
        try: return obj.cipher_receipt.receipt
        except ObjectDoesNotExist: return None

    def get_publication_state(self, obj):
        from .mesh_delivery import enabled
        if not enabled() or not obj.mesh_write_id:
            return 'local'
        from .models import MessageMeshWrite
        return 'confirmed' if MessageMeshWrite.objects.using(obj._state.db).filter(pk=obj.mesh_write_id, state='confirmed').exists() else 'pending'

    def get_is_pinned(self, obj):
        pinned_ids = self.context.get('pinned_ids')
        if pinned_ids is not None:
            return obj.id in pinned_ids
        return False

    def get_payload(self, obj):
        if obj.message_type == 'cipher':
            from .dm_cipher import parse
            return parse(obj.payload, obj.conversation_id, identity=obj.pk, author=obj.author_id)
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
        fields = ['id', 'participants', 'last_message', 'created_at', 'cipher_only']

    def get_last_message(self, obj):
        from .mesh_delivery import visible
        request = self.context.get('request')
        msg = visible(obj.messages.all(), getattr(request, 'user', None)).order_by('-created_at').first()
        if msg:
            from .mesh_history import enabled as history_enabled
            if history_enabled():
                payload = self.context.get('mesh_history_messages', {}).get(str(msg.pk))
                if payload is None or payload.get('mesh_write_id') != msg.mesh_write_id:
                    raise ValueError('message_mesh_history_changed_during_read')
                return payload
            return MessageSerializer(msg).data
        return None
