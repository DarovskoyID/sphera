"""Replace legacy installation flags with commercial entitlements; keep content."""
from django.db import migrations

IDS = ('amocrm', 'bitrix', 'onec', 'office', 'whiteboard', 'planner', 'conference',
       'servers', 'channels', 'bots', 'diary', 'family', 'legal', 'multiserver', 'totp')


def clear_legacy_flags(apps, schema_editor):
    alias = schema_editor.connection.alias
    for name in ('InstanceModule', 'UserModule'):
        apps.get_model('sfera_modules', name).objects.using(alias).filter(module_id__in=IDS).delete()


class Migration(migrations.Migration):
    dependencies = [('sfera_modules', '0003_commercialconnection')]
    operations = [migrations.RunPython(clear_legacy_flags, migrations.RunPython.noop)]
