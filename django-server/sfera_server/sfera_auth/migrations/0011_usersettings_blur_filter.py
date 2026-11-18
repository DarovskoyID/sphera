from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('sfera_auth', '0010_securityauditlog'),
    ]

    operations = [
        migrations.AddField(
            model_name='usersettings',
            name='blur_enabled',
            field=models.BooleanField(default=True),
        ),
        migrations.AddField(
            model_name='usersettings',
            name='blur_profanity',
            field=models.BooleanField(default=True),
        ),
        migrations.AddField(
            model_name='usersettings',
            name='blur_explicit',
            field=models.BooleanField(default=True),
        ),
        migrations.AddField(
            model_name='usersettings',
            name='blur_calls_to_action',
            field=models.BooleanField(default=True),
        ),
        migrations.AddField(
            model_name='usersettings',
            name='blur_code_requests',
            field=models.BooleanField(default=True),
        ),
        migrations.AddField(
            model_name='usersettings',
            name='blur_disable_requests',
            field=models.BooleanField(default=True),
        ),
    ]
