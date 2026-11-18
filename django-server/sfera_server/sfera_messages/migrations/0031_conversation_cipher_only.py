from django.db import migrations, models


def forwards(apps, schema_editor):
    from sfera_messages.cipher_mode import install
    Conversation = apps.get_model('sfera_messages', 'Conversation')
    Message = apps.get_model('sfera_messages', 'Message')
    alias = schema_editor.connection.alias
    Conversation.objects.using(alias).filter(pk__in=Message.objects.using(alias)
        .filter(message_type='cipher').values('conversation_id')).update(cipher_only=True)
    install(apps, schema_editor)


def backwards(apps, schema_editor):
    from sfera_messages.cipher_mode import uninstall
    uninstall(apps, schema_editor)


class Migration(migrations.Migration):
    dependencies = [('sfera_messages', '0030_message_cipher_type')]
    operations = [migrations.AddField(model_name='conversation', name='cipher_only',
        field=models.BooleanField(default=False, editable=False)), migrations.RunPython(forwards, backwards)]
