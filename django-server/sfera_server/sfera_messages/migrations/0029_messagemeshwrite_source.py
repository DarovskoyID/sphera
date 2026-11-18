from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('sfera_messages', '0028_messagemeshdelivery')]
    operations = [
        migrations.AddField(model_name='messagemeshwrite', name='source', field=models.CharField(default='dm', max_length=16)),
        migrations.AlterField(model_name='messagemeshdelivery', name='message', field=models.UUIDField(db_column='message_id', db_index=True)),
        migrations.RenameField(model_name='messagemeshdelivery', old_name='message', new_name='message_id'),
    ]
