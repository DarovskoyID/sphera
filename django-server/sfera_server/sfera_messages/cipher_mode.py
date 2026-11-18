"""Database barrier for plaintext writers, including bulk/worker paths.

An accepted cipher INSERT latches the conversation in its own transaction.
Deleting messages never downgrades the surviving conversation. Existing history
remains readable; receipt/pin metadata can still change.
"""
from django.db import IntegrityError
from contextlib import contextmanager
from functools import wraps

ERROR = 'cipher_conversation_requires_envelope'
CONTENT = ('conversation_id', 'author_id', 'encrypted_content', 'encrypted_payload',
           'message_type', 'reply_to_id', 'live_until', 'edited', 'created_at')


def reject_plaintext(conversation_id, using='default'):
    from .models import Conversation
    if Conversation.objects.using(using).filter(pk=conversation_id, cipher_only=True).exists():
        raise IntegrityError(ERROR)


@contextmanager
def plaintext_write(conversation_id, using='default'):
    from django.db import transaction
    from .models import Conversation
    with transaction.atomic(using=using):
        conversation = Conversation.objects.using(using).select_for_update().get(pk=conversation_id)
        if conversation.cipher_only:
            raise IntegrityError(ERROR)
        # SQLite SELECT FOR UPDATE is a no-op. Acquire the write reservation
        # before touching uploads, Kafka or any other external side effect.
        if not Conversation.objects.using(using).filter(pk=conversation_id, cipher_only=False).update(cipher_only=False):
            raise IntegrityError(ERROR)
        yield


def plaintext_view(function):
    @wraps(function)
    def guarded(request, conversation_id, *args, **kwargs):
        from .models import Conversation
        from rest_framework.response import Response
        if not Conversation.objects.filter(pk=conversation_id, participants=request.user).exists():
            return Response({'error': 'not found'}, status=404)
        try:
            with plaintext_write(conversation_id):
                return function(request, conversation_id, *args, **kwargs)
        except IntegrityError as exc:
            if ERROR not in str(exc):
                raise
            return Response({'error': ERROR}, status=409)
    return guarded


def install(apps, schema_editor, *, app_label='sfera_messages',
            model_names=('Conversation', 'Message', 'Attachment', 'ScheduledMessage'),
            prefix='cipher_mode', parent_field='conversation_id', content_fields=CONTENT):
    # Quote identifiers independently of trigger bodies. Names are fixed by the
    # historical models, never from a request.
    quote = schema_editor.quote_name
    tables = {alias: quote(apps.get_model(app_label, name)._meta.db_table)
              for alias, name in zip(('Conversation', 'Message', 'Attachment', 'ScheduledMessage'), model_names)}
    conversation, message = tables['Conversation'], tables['Message']
    vendor = schema_editor.connection.vendor
    if vendor == 'sqlite':
        changed = ' OR '.join(f'NEW.{quote(field)} IS NOT OLD.{quote(field)}' for field in content_fields)
        statements = [
            f'''CREATE TRIGGER cipher_mode_no_downgrade BEFORE UPDATE OF cipher_only ON {conversation}
                WHEN OLD.cipher_only = 1 AND NEW.cipher_only != 1
                BEGIN SELECT RAISE(ABORT, '{ERROR}'); END''',
            f'''CREATE TRIGGER cipher_mode_message_insert BEFORE INSERT ON {message}
                BEGIN
                  SELECT CASE WHEN NEW.message_type != 'cipher' AND EXISTS (
                    SELECT 1 FROM {conversation} WHERE id = NEW.conversation_id AND cipher_only = 1)
                    THEN RAISE(ABORT, '{ERROR}') END;
                  UPDATE {conversation} SET cipher_only = 1
                    WHERE id = NEW.conversation_id AND NEW.message_type = 'cipher';
                END''',
            f'''CREATE TRIGGER cipher_mode_message_update BEFORE UPDATE ON {message}
                WHEN (({changed}) AND EXISTS (
                  SELECT 1 FROM {conversation} WHERE id IN (OLD.conversation_id, NEW.conversation_id) AND cipher_only = 1))
                  OR (NEW.message_type = 'cipher' AND OLD.message_type != 'cipher')
                BEGIN SELECT RAISE(ABORT, '{ERROR}'); END''',
        ]
        for model in ('Attachment', 'ScheduledMessage'):
            table = tables[model]
            name = model.lower()
            for event in ('INSERT', 'UPDATE'):
                condition = 'id = NEW.conversation_id' if event == 'INSERT' else 'id IN (OLD.conversation_id, NEW.conversation_id)'
                statements.append(f'''CREATE TRIGGER cipher_mode_{name}_{event.lower()} BEFORE {event} ON {table}
                    WHEN EXISTS (SELECT 1 FROM {conversation} WHERE {condition} AND cipher_only = 1)
                    BEGIN SELECT RAISE(ABORT, '{ERROR}'); END''')
    elif vendor == 'postgresql':
        # Parent-row lock serializes a legacy writer against the first cipher
        # insert. A plain EXISTS check alone would race under READ COMMITTED.
        changed = ' OR '.join(f'NEW.{quote(field)} IS DISTINCT FROM OLD.{quote(field)}' for field in content_fields)
        statements = [
            f'''CREATE FUNCTION cipher_mode_conversation_guard() RETURNS trigger AS $$
                BEGIN
                  IF OLD.cipher_only AND NOT NEW.cipher_only THEN RAISE EXCEPTION '{ERROR}' USING ERRCODE='23514'; END IF;
                  RETURN NEW;
                END; $$ LANGUAGE plpgsql''',
            f'''CREATE TRIGGER cipher_mode_no_downgrade BEFORE UPDATE ON {conversation}
                FOR EACH ROW EXECUTE FUNCTION cipher_mode_conversation_guard()''',
            f'''CREATE FUNCTION cipher_mode_message_guard() RETURNS trigger AS $$
                DECLARE locked boolean;
                BEGIN
                  IF TG_OP = 'UPDATE' THEN
                    IF NEW.message_type = 'cipher' AND OLD.message_type != 'cipher' THEN
                      RAISE EXCEPTION '{ERROR}' USING ERRCODE='23514';
                    END IF;
                    IF NOT ({changed}) THEN RETURN NEW; END IF;
                    PERFORM id FROM {conversation} WHERE id IN (OLD.conversation_id, NEW.conversation_id) ORDER BY id FOR UPDATE;
                    IF EXISTS (SELECT 1 FROM {conversation} WHERE id IN (OLD.conversation_id, NEW.conversation_id) AND cipher_only) THEN
                      RAISE EXCEPTION '{ERROR}' USING ERRCODE='23514';
                    END IF;
                  ELSE
                    SELECT cipher_only INTO locked FROM {conversation} WHERE id = NEW.conversation_id FOR UPDATE;
                    IF NEW.message_type = 'cipher' THEN
                      UPDATE {conversation} SET cipher_only = true WHERE id = NEW.conversation_id;
                    ELSIF locked THEN RAISE EXCEPTION '{ERROR}' USING ERRCODE='23514'; END IF;
                  END IF;
                  RETURN NEW;
                END; $$ LANGUAGE plpgsql''',
            f'''CREATE TRIGGER cipher_mode_message_insert BEFORE INSERT OR UPDATE ON {message}
                FOR EACH ROW EXECUTE FUNCTION cipher_mode_message_guard()''',
            f'''CREATE FUNCTION cipher_mode_aux_guard() RETURNS trigger AS $$
                BEGIN
                  IF TG_OP = 'UPDATE' THEN
                    PERFORM id FROM {conversation} WHERE id IN (OLD.conversation_id, NEW.conversation_id) ORDER BY id FOR UPDATE;
                    IF EXISTS (SELECT 1 FROM {conversation} WHERE id IN (OLD.conversation_id, NEW.conversation_id) AND cipher_only) THEN
                      RAISE EXCEPTION '{ERROR}' USING ERRCODE='23514'; END IF;
                  ELSE
                    PERFORM id FROM {conversation} WHERE id = NEW.conversation_id FOR UPDATE;
                    IF EXISTS (SELECT 1 FROM {conversation} WHERE id = NEW.conversation_id AND cipher_only) THEN
                      RAISE EXCEPTION '{ERROR}' USING ERRCODE='23514'; END IF;
                  END IF;
                  RETURN NEW;
                END; $$ LANGUAGE plpgsql''',
        ]
        for model in ('Attachment', 'ScheduledMessage'):
            statements.append(f'''CREATE TRIGGER cipher_mode_{model.lower()}_insert BEFORE INSERT OR UPDATE ON {tables[model]}
                FOR EACH ROW EXECUTE FUNCTION cipher_mode_aux_guard()''')
    else:
        raise RuntimeError('cipher_mode_database_not_supported')
    for statement in statements:
        schema_editor.execute(statement.replace('cipher_mode', prefix).replace('conversation_id', parent_field))


def uninstall(apps, schema_editor, *, prefix='cipher_mode'):
    vendor = schema_editor.connection.vendor
    if vendor == 'sqlite':
        names = ['cipher_mode_no_downgrade', 'cipher_mode_message_insert', 'cipher_mode_message_update']
        names += [f'cipher_mode_{model}_{event}' for model in ('attachment', 'scheduledmessage') for event in ('insert', 'update')]
        for name in names:
            schema_editor.execute('DROP TRIGGER IF EXISTS ' + schema_editor.quote_name(name.replace('cipher_mode', prefix)))
    elif vendor == 'postgresql':
        for name in ('conversation', 'message', 'aux'):
            schema_editor.execute(f'DROP FUNCTION IF EXISTS {prefix}_{name}_guard() CASCADE')
