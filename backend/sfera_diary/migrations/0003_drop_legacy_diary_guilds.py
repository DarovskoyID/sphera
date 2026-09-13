"""Remove the legacy diary guilds copied by 0002.

Only guilds whose copy exists are deleted. Attachment rows go with them, but
the files are kept: they are now referenced by DiaryAttachment.
"""
from importlib import import_module

from django.db import migrations

_copy = import_module('sfera_diary.migrations.0002_copy_legacy_diaries')


def drop_legacy(apps, schema_editor):
    if not _copy._legacy_available(apps):
        return
    Guild = apps.get_model('sfera_messages', 'Guild')
    Diary = apps.get_model('sfera_diary', 'Diary')
    copied = Diary.objects.exclude(legacy_guild_id=None).values_list('legacy_guild_id', flat=True)
    # Historical models have no custom delete(), and FileField rows are removed
    # without touching storage — exactly what we want.
    Guild.objects.filter(is_private=True, id__in=list(copied)).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('sfera_diary', '0002_copy_legacy_diaries'),
    ]

    operations = [
        migrations.RunPython(drop_legacy, migrations.RunPython.noop),
    ]
