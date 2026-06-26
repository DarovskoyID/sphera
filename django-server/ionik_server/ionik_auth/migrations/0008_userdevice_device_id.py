from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('ionik_auth', '0007_usersettings_accessibility'),
    ]

    operations = [
        migrations.AddField(
            model_name='userdevice',
            name='device_id',
            field=models.CharField(blank=True, db_index=True, max_length=128, null=True),
        ),
    ]
