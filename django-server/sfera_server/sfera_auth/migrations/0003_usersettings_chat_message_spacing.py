from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('sfera_auth', '0002_fcmtoken'),
    ]

    operations = [
        migrations.AddField(
            model_name='usersettings',
            name='chat_message_spacing',
            field=models.PositiveSmallIntegerField(default=4),
        ),
    ]
