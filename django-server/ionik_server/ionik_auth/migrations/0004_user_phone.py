from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('ionik_auth', '0003_usersettings_chat_message_spacing'),
    ]

    operations = [
        migrations.AddField(
            model_name='user',
            name='phone',
            field=models.CharField(blank=True, default='', max_length=32),
        ),
    ]
