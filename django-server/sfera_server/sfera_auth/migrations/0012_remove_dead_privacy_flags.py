from django.db import migrations


class Migration(migrations.Migration):
    """Drop two privacy flags that no longer back any UI.

    `safe_dm_filter` was a checkbox that never had an implementation.
    `blur_explicit` was superseded by the scan_messages_* scope, which already
    existed and now drives the explicit-content filter.
    """

    dependencies = [
        ('sfera_auth', '0011_usersettings_blur_filter'),
    ]

    operations = [
        migrations.RemoveField(model_name='usersettings', name='safe_dm_filter'),
        migrations.RemoveField(model_name='usersettings', name='blur_explicit'),
    ]
