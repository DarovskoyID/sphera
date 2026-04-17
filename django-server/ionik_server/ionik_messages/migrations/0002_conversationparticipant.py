import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


def migrate_participants(apps, schema_editor):
    ConversationParticipant = apps.get_model('ionik_messages', 'ConversationParticipant')
    cursor = schema_editor.connection.cursor()
    cursor.execute(
        'SELECT conversation_id, user_id FROM ionik_messages_conversation_participants'
    )
    for conversation_id, user_id in cursor.fetchall():
        ConversationParticipant.objects.create(
            id=uuid.uuid4(),
            conversation_id=conversation_id,
            user_id=user_id,
        )


class Migration(migrations.Migration):

    dependencies = [
        ('ionik_messages', '0001_initial'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='ConversationParticipant',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('conversation', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='+', to='ionik_messages.conversation')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'unique_together': {('conversation', 'user')},
            },
        ),
        migrations.RunPython(migrate_participants, migrations.RunPython.noop),
        migrations.RemoveField(
            model_name='conversation',
            name='participants',
        ),
        migrations.AddField(
            model_name='conversation',
            name='participants',
            field=models.ManyToManyField(
                related_name='conversations',
                through='ionik_messages.ConversationParticipant',
                to=settings.AUTH_USER_MODEL,
            ),
        ),
    ]
