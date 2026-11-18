"""Hand Family / FamilyMembership over to the family module (state only).

The tables keep their names (sfera_auth_family, sfera_auth_familymembership);
sfera_family adopts them. Without the module they simply stay untouched.
"""
from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('sfera_auth', '0019_family_guild_plain_uuid'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.DeleteModel(name='FamilyMembership'),
                migrations.DeleteModel(name='Family'),
            ],
            database_operations=[],
        ),
    ]
