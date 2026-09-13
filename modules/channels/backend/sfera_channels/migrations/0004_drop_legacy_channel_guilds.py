"""Remove the legacy personal-channel guilds copied by 0003 (files are kept)."""
from importlib import import_module

from django.db import migrations

_copy = import_module('sfera_channels.migrations.0003_copy_legacy_channels')


def drop_legacy(apps, schema_editor):
    if not _copy._legacy_available(apps):
        return
    Guild = apps.get_model('sfera_messages', 'Guild')
    Channel = apps.get_model('sfera_channels', 'Channel')
    copied = list(Channel.objects.exclude(legacy_guild_id=None).values_list('legacy_guild_id', flat=True))
    for i in range(0, len(copied), 500):
        Guild.objects.filter(is_personal_channel=True, id__in=copied[i:i + 500]).delete()


class Migration(migrations.Migration):
    dependencies = [('sfera_channels', '0003_copy_legacy_channels')]
    operations = [migrations.RunPython(drop_legacy, migrations.RunPython.noop)]
