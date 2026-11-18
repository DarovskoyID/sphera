from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('sfera_messages', '0026_messagemeshwrite')]
    operations = [
        migrations.CreateModel(name='MessageMeshChunk', fields=[
            ('id', models.CharField(max_length=64, primary_key=True, serialize=False)),
            ('genesis', models.CharField(max_length=64)),
            ('cluster', models.CharField(max_length=64)),
            ('digest', models.CharField(max_length=64)),
            ('ciphertext', models.BinaryField()),
            ('state', models.CharField(default='pending', max_length=12)),
            ('receipt', models.JSONField(default=dict)),
        ]),
        migrations.AddField(model_name='messagemeshwrite', name='chunks',
                            field=models.ManyToManyField(related_name='writes', to='sfera_messages.messagemeshchunk')),
        migrations.AddField(model_name='messagemeshwrite', name='format_version', field=models.PositiveSmallIntegerField(default=1)),
    ]
