from django.db import migrations


def install(apps, schema_editor):
    GuildMembership = apps.get_model('sfera_servers', 'GuildMembership')
    UserModule = apps.get_model('sfera_modules', 'UserModule')
    user_ids = set(GuildMembership.objects.values_list('user_id', flat=True))
    UserModule.objects.bulk_create(
        [UserModule(user_id=uid, module_id='servers') for uid in user_ids], ignore_conflicts=True,
    )


class Migration(migrations.Migration):
    dependencies = [
        ('sfera_servers', '0001_initial'),
        ('sfera_modules', '0001_initial'),
    ]
    operations = [migrations.RunPython(install, migrations.RunPython.noop)]
