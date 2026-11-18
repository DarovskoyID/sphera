import json
import uuid
from django.db import models, transaction, router
from django.conf import settings
from sfera_messages.encryption import encrypt_text, decrypt_text

# Rich message kinds. 'text' is the plain message every existing row already is.
MESSAGE_TYPE_TEXT = 'text'
MESSAGE_TYPE_POLL = 'poll'
MESSAGE_TYPE_TODO = 'todo'
MESSAGE_TYPE_CONTACT = 'contact'
MESSAGE_TYPE_LOCATION = 'location'
MESSAGE_TYPE_CHOICES = [
    (MESSAGE_TYPE_TEXT, 'Text'),
    (MESSAGE_TYPE_POLL, 'Poll'),
    (MESSAGE_TYPE_TODO, 'Todo'),
    (MESSAGE_TYPE_CONTACT, 'Contact'),
    (MESSAGE_TYPE_LOCATION, 'Location'),
]


class RichPayloadMixin(models.Model):
    """Structured body for non-text messages (poll/todo/contact/location).

    The payload is encrypted at rest like message content, because it can hold
    personal data (a shared phone number, GPS coordinates). `live_until` is kept
    as a real column so live-location expiry stays queryable.
    """
    message_type = models.CharField(
        max_length=16, choices=MESSAGE_TYPE_CHOICES, default=MESSAGE_TYPE_TEXT, db_index=True
    )
    encrypted_payload = models.TextField(blank=True, default='')
    live_until = models.DateTimeField(null=True, blank=True)

    class Meta:
        abstract = True

    @property
    def payload(self):
        if not self.encrypted_payload:
            return {}
        try:
            return json.loads(decrypt_text(self.encrypted_payload))
        except (ValueError, TypeError):
            return {}

    @payload.setter
    def payload(self, value):
        self.encrypted_payload = (
            encrypt_text(json.dumps(value, ensure_ascii=False)) if value else ''
        )


class Conversation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    participants = models.ManyToManyField(
        settings.AUTH_USER_MODEL,
        through='ConversationParticipant',
        related_name='conversations',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    cipher_only = models.BooleanField(default=False, editable=False)

    def __str__(self):
        names = ', '.join(u.username for u in self.participants.all()[:3])
        return f'Conversation({names})'


class ConversationParticipant(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name='+')
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')

    class Meta:
        unique_together = ('conversation', 'user')


class MessageQuerySet(models.QuerySet):
    def update(self, **kwargs):
        from .mesh_publication import enabled, CONTENT_FIELDS
        if (CONTENT_FIELDS | {'id', 'pk'}).intersection(kwargs) and (kwargs.get('message_type') == 'cipher' or self.filter(message_type='cipher').exists()):
            raise ValueError('cipher_message_is_immutable')
        if enabled() and {'id', 'pk'}.intersection(kwargs):
            raise ValueError('mesh_message_identity_is_immutable')
        if enabled() and CONTENT_FIELDS.intersection(kwargs):
            if any(hasattr(value, 'resolve_expression') for value in kwargs.values()):
                raise ValueError('mesh_content_expression_update_unsupported')
            with transaction.atomic(using=self.db):
                values = list(self.select_for_update()[:513])
                if len(values) > 512:
                    raise ValueError('mesh_content_update_batch_limit')
                for value in values:
                    for field, update in kwargs.items():
                        setattr(value, field, update)
                    value.save(using=self.db, update_fields=list(kwargs))
            return len(values)
        return super().update(**kwargs)

    def bulk_create(self, objs, **kwargs):
        from .mesh_publication import enabled
        values = list(objs)
        if not enabled() and not any(value.message_type == 'cipher' for value in values):
            return super().bulk_create(values, **kwargs)
        if kwargs.get('ignore_conflicts') or kwargs.get('update_conflicts'):
            raise ValueError('mesh_bulk_conflict_mode_unsupported')
        with transaction.atomic(using=self.db):
            for value in values:
                value.save(using=self.db, force_insert=True)
        return values

    def bulk_update(self, objs, fields, **kwargs):
        from .mesh_publication import enabled, CONTENT_FIELDS
        values = list(objs)
        if CONTENT_FIELDS.intersection(fields) and (any(value.message_type == 'cipher' for value in values) or
                self.filter(pk__in=[value.pk for value in values], message_type='cipher').exists()):
            raise ValueError('cipher_message_is_immutable')
        objs = values
        if enabled() and {'id', 'pk'}.intersection(fields):
            raise ValueError('mesh_message_identity_is_immutable')
        if enabled() and CONTENT_FIELDS.intersection(fields):
            values = list(objs)
            if len(values) > 512:
                raise ValueError('mesh_content_update_batch_limit')
            with transaction.atomic(using=self.db):
                for value in values:
                    value.save(using=self.db, update_fields=fields)
            return len(values)
        return super().bulk_update(objs, fields, **kwargs)


class Message(RichPayloadMixin):
    objects = MessageQuerySet.as_manager()
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name='messages')
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='sent_messages')
    encrypted_content = models.TextField()
    message_type = models.CharField(max_length=16, choices=MESSAGE_TYPE_CHOICES + [('cipher', 'Encrypted envelope')],
        default=MESSAGE_TYPE_TEXT, db_index=True)
    reply_to = models.ForeignKey('self', null=True, blank=True, on_delete=models.SET_NULL, related_name='replies')
    is_pinned = models.BooleanField(default=False)
    edited = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    # Receipt timestamps for the OTHER participant (DM is always 1-on-1).
    delivered_at = models.DateTimeField(null=True, blank=True)
    read_at = models.DateTimeField(null=True, blank=True)
    mesh_write_id = models.CharField(max_length=64, blank=True, default='')

    @property
    def mesh_deliveries(self):
        return MessageMeshDelivery.objects.using(self._state.db or 'default').filter(message_id=self.pk, write__source='dm')

    def save(self, *args, **kwargs):
        from .mesh_publication import enabled, capture, require_durable_database
        from .dm_cipher import validate_save
        using = kwargs.get('using') or self._state.db or router.db_for_write(type(self), instance=self)
        validate_save(self, using, kwargs.get('update_fields'))
        if not enabled():
            from .mesh_delivery import enabled as delivery_enabled
            delivery_enabled()
            return super().save(*args, **kwargs)
        if args:
            raise ValueError('mesh_message_save_requires_keyword_arguments')
        using = kwargs.get('using') or self._state.db or router.db_for_write(type(self), instance=self)
        kwargs['using'] = using
        require_durable_database(using)
        with transaction.atomic(using=using):
            previous = type(self).objects.using(using).select_for_update().filter(pk=self.pk).values_list('mesh_write_id', flat=True).first()
            result = super().save(**kwargs)
            # Reload persisted fields: update_fields must not publish unsaved
            # attributes attached to this Python instance.
            stored = type(self).objects.using(using).get(pk=self.pk)
            write = capture(stored, using)
            type(self).objects.using(using).filter(pk=self.pk).update(mesh_write_id=write.pk)
            self.mesh_write_id = write.pk
            from .mesh_delivery import enabled as delivery_enabled, enqueue
            if delivery_enabled() and previous != write.pk and not getattr(self, '_mesh_backfill', False):
                enqueue(stored, write, using, getattr(self, '_mesh_nonce', ''))
        return result

    class Meta:
        ordering = ['created_at']
        indexes = [
            models.Index(fields=['conversation', '-created_at']),
        ]

    @property
    def content(self):
        return decrypt_text(self.encrypted_content)

    @content.setter
    def content(self, value):
        self.encrypted_content = encrypt_text(value)

    def __str__(self):
        return f'{self.author.username}: {self.content[:40]}'


class CipherReadReceipt(models.Model):
    message = models.OneToOneField(Message, primary_key=True, on_delete=models.CASCADE, related_name='cipher_receipt')
    receipt = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)


def _attachment_upload_path(instance, filename):
    return f'attachments/{uuid.uuid4().hex}.enc'


class CipherMessageIdentity(models.Model):
    """A consumed client UUID survives deleting its message or conversation."""
    id = models.UUIDField(primary_key=True, editable=False)
    digest = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)


class MessageMeshWrite(models.Model):
    """Immutable encrypted snapshot; deliberately survives Message deletion."""
    id = models.CharField(max_length=64, primary_key=True)
    source = models.CharField(max_length=16, default='dm')
    message_id = models.UUIDField(db_index=True)
    conversation_id = models.UUIDField()
    cluster = models.CharField(max_length=64)
    genesis = models.CharField(max_length=64)
    snapshot_hash = models.CharField(max_length=64)
    ciphertext = models.BinaryField()
    state = models.CharField(max_length=12, default='pending', db_index=True)
    receipt = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    confirmed_at = models.DateTimeField(null=True)
    chunks = models.ManyToManyField('MessageMeshChunk', related_name='writes')
    format_version = models.PositiveSmallIntegerField(default=1)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['message_id', 'snapshot_hash'], name='mesh_message_snapshot_unique')]


class MessageMeshChunk(models.Model):
    id = models.CharField(max_length=64, primary_key=True)
    genesis = models.CharField(max_length=64)
    cluster = models.CharField(max_length=64)
    digest = models.CharField(max_length=64)
    ciphertext = models.BinaryField()
    state = models.CharField(max_length=12, default='pending')
    receipt = models.JSONField(default=dict)


class MessageMeshDelivery(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    message_id = models.UUIDField(db_column='message_id', db_index=True)
    write = models.ForeignKey(MessageMeshWrite, on_delete=models.CASCADE)
    nonce = models.CharField(max_length=128, blank=True, default='')
    state = models.CharField(max_length=12, default='pending', db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    sent_at = models.DateTimeField(null=True)


class AttachmentQuerySet(models.QuerySet):
    def update(self, **kwargs):
        from .mesh_publication import enabled
        if not enabled():
            return super().update(**kwargs)
        if any(hasattr(value, 'resolve_expression') for value in kwargs.values()):
            raise ValueError('mesh_attachment_expression_update_unsupported')
        with transaction.atomic(using=self.db):
            rows = list(self.values_list('id', 'message_id')[:65])
            if len(rows) > 64:
                raise ValueError('mesh_attachment_update_batch_limit')
            result = super().update(**kwargs)
            affected = {row[1] for row in rows if row[1] is not None}
            affected.update(Attachment.objects.using(self.db).filter(pk__in=[row[0] for row in rows])
                            .exclude(message_id=None).values_list('message_id', flat=True))
            for message in Message.objects.using(self.db).filter(pk__in=affected):
                message.save(using=self.db)
        return result

    def bulk_create(self, objs, **kwargs):
        from .mesh_publication import enabled
        if not enabled():
            return super().bulk_create(objs, **kwargs)
        if kwargs.get('ignore_conflicts') or kwargs.get('update_conflicts'):
            raise ValueError('mesh_bulk_conflict_mode_unsupported')
        values = list(objs)
        if len(values) > 64:
            raise ValueError('mesh_attachment_update_batch_limit')
        with transaction.atomic(using=self.db):
            for value in values:
                value.save(using=self.db, force_insert=True)
        return values

    def bulk_update(self, objs, fields, **kwargs):
        from .mesh_publication import enabled
        if not enabled():
            return super().bulk_update(objs, fields, **kwargs)
        values = list(objs)
        if len(values) > 64:
            raise ValueError('mesh_attachment_update_batch_limit')
        with transaction.atomic(using=self.db):
            for value in values:
                value.save(using=self.db, update_fields=fields)
        return len(values)


class Attachment(models.Model):
    objects = AttachmentQuerySet.as_manager()
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name='attachments')
    uploader = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    message = models.ForeignKey(
        Message, on_delete=models.SET_NULL, null=True, blank=True, related_name='attachments'
    )
    file = models.FileField(upload_to=_attachment_upload_path)
    original_filename = models.CharField(max_length=255)
    content_type = models.CharField(max_length=100)
    file_size = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    def save(self, *args, **kwargs):
        from .mesh_publication import enabled, require_durable_database
        if not enabled():
            return super().save(*args, **kwargs)
        if args:
            raise ValueError('mesh_attachment_save_requires_keyword_arguments')
        using = kwargs.get('using') or self._state.db or router.db_for_write(type(self), instance=self)
        kwargs['using'] = using
        require_durable_database(using)
        with transaction.atomic(using=using):
            prior = type(self).objects.using(using).filter(pk=self.pk).values_list('message_id', flat=True).first()
            result = super().save(**kwargs)
            current = type(self).objects.using(using).get(pk=self.pk).message_id
            for message in Message.objects.using(using).filter(pk__in={value for value in (prior, current) if value}):
                message.save(using=using)
        return result

    def __str__(self):
        return f'{self.original_filename} ({self.file_size} bytes)'


class MessagePin(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='pinned_messages')
    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name='pins')

    class Meta:
        unique_together = ('user', 'message')
        indexes = [
            models.Index(fields=['user', 'message']),
        ]


class MessageReport(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    reporter = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='reports')
    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name='reports')
    created_at = models.DateTimeField(auto_now_add=True)
    # Closed by the superuser in the admin panel.
    resolved_at = models.DateTimeField(null=True, blank=True)
    resolved_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    resolution = models.CharField(max_length=16, blank=True, default='')

    class Meta:
        unique_together = ('reporter', 'message')

    def __str__(self):
        return f'{self.reporter.username} reported msg {self.message_id}'


class ScheduledMessage(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name='scheduled_messages')
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    encrypted_content = models.TextField()
    send_at = models.DateTimeField(db_index=True)
    reply_to = models.ForeignKey(Message, null=True, blank=True, on_delete=models.SET_NULL)
    attachment_ids = models.JSONField(default=list)
    is_sent = models.BooleanField(default=False, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    @property
    def content(self):
        return decrypt_text(self.encrypted_content)

    def __str__(self):
        return f'Scheduled by {self.author.username} at {self.send_at}'


class TodoCheck(models.Model):
    """A ticked checklist item in a DM. Shared state: one row per item, and it
    records who ticked it (unique on message+item, not per user)."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name='todo_checks')
    item_id = models.CharField(max_length=32)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('message', 'item_id')


class ChatSafetySettings(models.Model):
    """Instance-wide chat safety switches, set by the superuser. Single row (pk=1)."""
    # Block any message that looks like a secret code (SMS/bank/app code),
    # not only one somebody in the chat has just asked for.
    block_all_codes = models.BooleanField(default=False)
    updated_at = models.DateTimeField(auto_now=True)

    @classmethod
    def get(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj
