"""Preserve inbound CRM hooks/history on nodes that already ran the flag cleanup."""
from django.db import migrations


def retain_crm_storage_flags(apps, schema_editor):
    alias = schema_editor.connection.alias
    installed = apps.get_model('sfera_modules', 'InstanceModule')
    for module_id in ('amocrm', 'bitrix', 'onec'):
        try:
            connection = apps.get_model('sfera_' + module_id, 'Connection')
        except LookupError:
            continue
        # No credentials, subscriptions or content are created or changed.
        # Existing legacy guards need this marker to read events and accept hooks.
        if connection.objects.using(alias).exists():
            installed.objects.using(alias).get_or_create(module_id=module_id)


class Migration(migrations.Migration):
    dependencies = [('sfera_modules', '0004_clear_legacy_installs')]
    operations = [migrations.RunPython(retain_crm_storage_flags, migrations.RunPython.noop)]
