"""Family moves to the family module; first drop its database-level link to guilds.

The column (guild_id) and its data stay; it only stops being a foreign key, so
the family and servers modules no longer depend on each other's tables.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('sfera_auth', '0018_usersettings_onboarding_completed'),
    ]

    operations = [
        migrations.AlterField(
            model_name='family',
            name='guild',
            field=models.UUIDField(blank=True, null=True, db_column='guild_id'),
        ),
    ]
