"""Local SQL is a repairable projection of SDK-signed ciphertext operations."""
from hashlib import sha256
from django.db import transaction
from sfera_mesh.storage import canonical


def project(directory,record):
    from .projection import synchronize
    from sfera_messages.models import Message,CipherMessageIdentity,Conversation
    from sfera_messages.encryption import encrypt_text
    from sfera_auth.models import User
    operation=record['body'];body=__import__('json').loads(operation['request']['body'])
    value=body['cipher'];digest=sha256(canonical(value)).hexdigest()
    if not Conversation.objects.filter(pk=value['scope'],cipher_only=True).exists():
        synchronize(directory)
    with transaction.atomic():
        old=CipherMessageIdentity.objects.select_for_update().filter(pk=value['id']).first()
        row=Message.objects.select_for_update().filter(pk=value['id']).first()
        if old and old.digest!=digest:raise ValueError('replicated_message_identity_conflict')
        if row:
            if row.message_type!='cipher' or canonical(row.payload)!=canonical(value):raise ValueError('replicated_message_projection_conflict')
            return
        if old:raise ValueError('replicated_message_deleted')
        conversation=Conversation.objects.get(pk=value['scope'],cipher_only=True)
        author=User.objects.get(pk=value['sender']['user'])
        if not conversation.participants.filter(pk=author.pk).exists():raise ValueError('replicated_message_membership')
        CipherMessageIdentity.objects.create(id=value['id'],digest=digest)
        message=Message(id=value['id'],conversation=conversation,author=author,message_type='cipher',encrypted_content=encrypt_text(''))
        message.payload=value;message.save(force_insert=True)
