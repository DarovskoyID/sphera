from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('sfera_messages', '0025_report_resolution')]

    operations = [migrations.CreateModel(
        name='MessageMeshWrite',
        fields=[
            ('id', models.CharField(max_length=64, primary_key=True, serialize=False)),
            ('message_id', models.UUIDField(db_index=True)),
            ('conversation_id', models.UUIDField()),
            ('cluster', models.CharField(max_length=64)),
            ('genesis', models.CharField(max_length=64)),
            ('snapshot_hash', models.CharField(max_length=64)),
            ('ciphertext', models.BinaryField()),
            ('state', models.CharField(db_index=True, default='pending', max_length=12)),
            ('receipt', models.JSONField(default=dict)),
            ('created_at', models.DateTimeField(auto_now_add=True)),
            ('confirmed_at', models.DateTimeField(null=True)),
        ],
        options={'constraints': [models.UniqueConstraint(fields=('message_id', 'snapshot_hash'), name='mesh_message_snapshot_unique')]},
    ), migrations.AddField(model_name='message', name='mesh_write_id',
                          field=models.CharField(blank=True, default='', max_length=64))]
