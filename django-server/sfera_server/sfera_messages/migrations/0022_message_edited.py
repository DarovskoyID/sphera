from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('sfera_messages', '0021_guildmessage_tags'),
    ]

    operations = [
        migrations.AddField(
            model_name='message',
            name='edited',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='guildmessage',
            name='edited',
            field=models.BooleanField(default=False),
        ),
    ]
