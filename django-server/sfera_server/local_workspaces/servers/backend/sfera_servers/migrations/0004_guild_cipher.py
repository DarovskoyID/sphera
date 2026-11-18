from django.db import migrations, models


def install(apps, schema_editor):
    from sfera_servers.cipher_messages import install as install_guards
    channel, message = apps.get_model('sfera_servers', 'GuildChannel'), apps.get_model('sfera_servers', 'GuildMessage')
    channel.objects.using(schema_editor.connection.alias).filter(
        pk__in=message.objects.using(schema_editor.connection.alias).filter(message_type='cipher').values('channel_id')).update(cipher_only=True)
    install_guards(apps, schema_editor)


def uninstall(apps, schema_editor):
    from sfera_servers.cipher_messages import uninstall as uninstall_guards
    uninstall_guards(apps, schema_editor)


class Migration(migrations.Migration):
    dependencies = [('sfera_servers', '0003_guildmessage_mesh_write_id'), ('sfera_messages', '0032_cipherreadreceipt')]
    operations = [
        migrations.AddField(model_name='guildchannel', name='cipher_only', field=models.BooleanField(default=False)),
        migrations.AlterField(model_name='guildmessage', name='message_type', field=models.CharField(max_length=16,
            choices=[('text', 'Text'), ('poll', 'Poll'), ('todo', 'Todo'), ('contact', 'Contact'), ('location', 'Location'), ('cipher', 'Encrypted envelope')],
            default='text', db_index=True)),
        migrations.CreateModel(name='GuildCipherMessageIdentity', fields=[
            ('id', models.UUIDField(primary_key=True, serialize=False)), ('digest', models.CharField(max_length=64)),
            ('created_at', models.DateTimeField(auto_now_add=True))]),
        migrations.RunPython(install, uninstall),
    ]
