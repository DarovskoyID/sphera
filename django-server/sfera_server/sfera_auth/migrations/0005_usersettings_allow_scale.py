from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('sfera_auth', '0004_user_phone'),
    ]

    operations = [
        migrations.AddField(
            model_name='usersettings',
            name='allow_scale',
            field=models.BooleanField(default=False),
        ),
    ]
