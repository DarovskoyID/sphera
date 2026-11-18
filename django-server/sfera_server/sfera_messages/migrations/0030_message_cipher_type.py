from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('sfera_messages', '0029_messagemeshwrite_source')]
    operations = [migrations.CreateModel(name='CipherMessageIdentity', fields=[
        ('id', models.UUIDField(primary_key=True, editable=False, serialize=False)),
        ('digest', models.CharField(max_length=64)), ('created_at', models.DateTimeField(auto_now_add=True))]),
        migrations.AlterField(model_name='message', name='message_type',
        field=models.CharField(max_length=16, db_index=True, default='text', choices=[('text', 'Text'),
            ('poll', 'Poll'), ('todo', 'Todo'), ('contact', 'Contact'), ('location', 'Location'), ('cipher', 'Encrypted envelope')]))]
