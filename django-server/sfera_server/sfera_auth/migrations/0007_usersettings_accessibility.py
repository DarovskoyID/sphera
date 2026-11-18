from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('sfera_auth', '0006_dataexport'),
    ]

    operations = [
        migrations.AddField(
            model_name='usersettings',
            name='high_contrast',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='usersettings',
            name='screen_reader',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='usersettings',
            name='reduce_motion',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='usersettings',
            name='large_text',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='usersettings',
            name='keyboard_outlines',
            field=models.BooleanField(default=False),
        ),
    ]
