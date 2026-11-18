"""Opaque Guild text messages and immutable channel mode; no plaintext keys."""
from functools import wraps
from contextlib import contextmanager
from django.db import IntegrityError, transaction
from sfera_messages.dm_cipher import KIND, parse

ERROR = 'cipher_channel_requires_envelope'
CONTENT = ('id', 'channel_id', 'author_id', 'encrypted_content', 'encrypted_payload',
           'message_type', 'reply_to_id', 'live_until', 'edited', 'created_at', 'tags')


def validate_save(message, using, update_fields=None):
    old = type(message).objects.using(using).filter(pk=message.pk).values(*CONTENT).first()
    was_cipher = old is not None and old['message_type'] == KIND
    if was_cipher and (update_fields is None or set(update_fields).intersection(CONTENT)):
        if any(getattr(message, field) != old[field] for field in CONTENT):
            raise ValueError('cipher_guild_message_is_immutable')
    if message.message_type != KIND:
        if was_cipher:
            raise ValueError('cipher_guild_message_is_immutable')
        return
    if old is not None and not was_cipher:
        raise ValueError('cipher_guild_message_is_immutable')
    if message.content or message.reply_to_id or message.live_until or message.edited or message.tags:
        raise ValueError('cipher_guild_plaintext_metadata_forbidden')
    parse(message.payload, message.channel_id, identity=message.pk, author=message.author_id,
          source='guild', guild=message.channel.guild_id)


@contextmanager
def plaintext_write(channel_id, using='default'):
    from .models import GuildChannel
    with transaction.atomic(using=using):
        channel = GuildChannel.objects.using(using).select_for_update().get(pk=channel_id)
        if channel.cipher_only or not GuildChannel.objects.using(using).filter(pk=channel_id, cipher_only=False).update(cipher_only=False):
            raise IntegrityError(ERROR)
        yield


def plaintext_view(function):
    @wraps(function)
    def guarded(request, guild_id, channel_id, *args, **kwargs):
        from .models import GuildChannel, GuildMembership
        from rest_framework.response import Response
        if not GuildChannel.objects.filter(pk=channel_id, guild_id=guild_id).exists() or not GuildMembership.objects.filter(guild_id=guild_id, user=request.user).exists():
            return Response({'error': 'not found'}, status=404)
        try:
            with plaintext_write(channel_id):
                return function(request, guild_id, channel_id, *args, **kwargs)
        except IntegrityError as exc:
            if 'cipher_conversation_requires_envelope' not in str(exc) and ERROR not in str(exc):
                raise
            return Response({'error': ERROR}, status=409)
    return guarded


def plaintext_message_view(function):
    @wraps(function)
    def guarded(request, guild_id, message_id, *args, **kwargs):
        if request.method not in ('POST', 'PATCH'):
            return function(request, guild_id, message_id, *args, **kwargs)
        from .models import GuildMessage, GuildMembership
        from rest_framework.response import Response
        message = GuildMessage.objects.filter(pk=message_id, channel__guild_id=guild_id).first()
        if message is None or not GuildMembership.objects.filter(guild_id=guild_id, user=request.user).exists():
            return Response({'error': 'not found'}, status=404)
        try:
            with plaintext_write(message.channel_id):
                return function(request, guild_id, message_id, *args, **kwargs)
        except IntegrityError as exc:
            if ERROR not in str(exc) and 'cipher_conversation_requires_envelope' not in str(exc):
                raise
            return Response({'error': ERROR}, status=409)
    return guarded


def install(apps, schema_editor):
    from sfera_messages.cipher_mode import install as shared_install
    shared_install(apps, schema_editor, app_label='sfera_servers',
        model_names=('GuildChannel', 'GuildMessage', 'GuildAttachment', 'GuildScheduledMessage'),
        prefix='guild_cipher_mode', parent_field='channel_id', content_fields=CONTENT)
    q = schema_editor.quote_name
    channel, guild, message, comment = [q(apps.get_model('sfera_servers', name)._meta.db_table)
        for name in ('GuildChannel', 'Guild', 'GuildMessage', 'GuildPostComment')]
    if schema_editor.connection.vendor == 'sqlite':
        for event in ('INSERT', 'UPDATE'):
            schema_editor.execute(f'''CREATE TRIGGER guild_cipher_private_{event.lower()} BEFORE {event} ON {channel}
                WHEN NEW.cipher_only = 1 AND (NEW.channel_type != 'text' OR EXISTS
                (SELECT 1 FROM {guild} WHERE id = NEW.guild_id AND is_discoverable = 1))
                BEGIN SELECT RAISE(ABORT, 'cipher_guild_requires_private_text_channel'); END''')
            condition = 'id = NEW.message_id' if event == 'INSERT' else 'id IN (OLD.message_id, NEW.message_id)'
            schema_editor.execute(f'''CREATE TRIGGER guild_cipher_comment_{event.lower()} BEFORE {event} ON {comment}
                WHEN EXISTS (SELECT 1 FROM {message} m JOIN {channel} c ON c.id = m.channel_id
                WHERE m.{condition} AND c.cipher_only = 1)
                BEGIN SELECT RAISE(ABORT, '{ERROR}'); END''')
        schema_editor.execute(f'''CREATE TRIGGER guild_cipher_no_public BEFORE UPDATE OF is_discoverable ON {guild}
            WHEN NEW.is_discoverable = 1 AND EXISTS (SELECT 1 FROM {channel} WHERE guild_id = NEW.id AND cipher_only = 1)
            BEGIN SELECT RAISE(ABORT, 'cipher_guild_requires_private_text_channel'); END''')
        schema_editor.execute(f'''CREATE TRIGGER guild_cipher_no_move BEFORE UPDATE OF guild_id ON {channel}
            WHEN OLD.cipher_only = 1 AND NEW.guild_id IS NOT OLD.guild_id
            BEGIN SELECT RAISE(ABORT, '{ERROR}'); END''')
    elif schema_editor.connection.vendor == 'postgresql':
        schema_editor.execute(f'''CREATE FUNCTION guild_cipher_private_guard() RETURNS trigger AS $$
            BEGIN
              IF TG_OP = 'UPDATE' AND OLD.cipher_only AND NEW.guild_id IS DISTINCT FROM OLD.guild_id THEN
                RAISE EXCEPTION '{ERROR}' USING ERRCODE='23514';
              END IF;
              PERFORM id FROM {guild} WHERE id = NEW.guild_id FOR UPDATE;
              IF NEW.cipher_only AND (NEW.channel_type != 'text' OR EXISTS
                (SELECT 1 FROM {guild} WHERE id = NEW.guild_id AND is_discoverable)) THEN
                RAISE EXCEPTION 'cipher_guild_requires_private_text_channel' USING ERRCODE='23514';
              END IF; RETURN NEW;
            END; $$ LANGUAGE plpgsql''')
        schema_editor.execute(f'''CREATE TRIGGER guild_cipher_private BEFORE INSERT OR UPDATE ON {channel}
            FOR EACH ROW EXECUTE FUNCTION guild_cipher_private_guard()''')
        schema_editor.execute(f'''CREATE FUNCTION guild_cipher_public_guard() RETURNS trigger AS $$
            BEGIN
              IF NEW.is_discoverable AND EXISTS (SELECT 1 FROM {channel} WHERE guild_id = NEW.id AND cipher_only) THEN
                RAISE EXCEPTION 'cipher_guild_requires_private_text_channel' USING ERRCODE='23514';
              END IF; RETURN NEW;
            END; $$ LANGUAGE plpgsql''')
        schema_editor.execute(f'''CREATE TRIGGER guild_cipher_no_public BEFORE UPDATE ON {guild}
            FOR EACH ROW EXECUTE FUNCTION guild_cipher_public_guard()''')
        schema_editor.execute(f'''CREATE FUNCTION guild_cipher_comment_guard() RETURNS trigger AS $$
            DECLARE channel_uuid uuid;
            BEGIN
              FOR channel_uuid IN SELECT channel_id FROM {message} WHERE id = NEW.message_id
                UNION SELECT channel_id FROM {message} WHERE TG_OP = 'UPDATE' AND id = OLD.message_id LOOP
                PERFORM id FROM {channel} WHERE id = channel_uuid FOR UPDATE;
                IF EXISTS (SELECT 1 FROM {channel} WHERE id = channel_uuid AND cipher_only) THEN
                  RAISE EXCEPTION '{ERROR}' USING ERRCODE='23514';
                END IF;
              END LOOP; RETURN NEW;
            END; $$ LANGUAGE plpgsql''')
        schema_editor.execute(f'''CREATE TRIGGER guild_cipher_comment BEFORE INSERT OR UPDATE ON {comment}
            FOR EACH ROW EXECUTE FUNCTION guild_cipher_comment_guard()''')


def uninstall(apps, schema_editor):
    from sfera_messages.cipher_mode import uninstall as shared_uninstall
    shared_uninstall(apps, schema_editor, prefix='guild_cipher_mode')
    if schema_editor.connection.vendor == 'sqlite':
        for name in ('private_insert', 'private_update', 'comment_insert', 'comment_update', 'no_public', 'no_move'):
            schema_editor.execute('DROP TRIGGER IF EXISTS guild_cipher_' + name)
    elif schema_editor.connection.vendor == 'postgresql':
        for name in ('private', 'public', 'comment'):
            schema_editor.execute(f'DROP FUNCTION IF EXISTS guild_cipher_{name}_guard() CASCADE')
