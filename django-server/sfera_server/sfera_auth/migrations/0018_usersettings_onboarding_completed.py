from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sfera_auth", "0017_family_guild"),
    ]

    operations = [
        migrations.AddField(
            model_name="usersettings",
            name="onboarding_completed",
            field=models.BooleanField(default=False),
        ),
    ]
