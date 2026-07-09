from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('sfera_messages', '0005_add_messagepin'),
    ]

    operations = [
        migrations.AddField(
            model_name='guildmembership',
            name='muted_until',
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
