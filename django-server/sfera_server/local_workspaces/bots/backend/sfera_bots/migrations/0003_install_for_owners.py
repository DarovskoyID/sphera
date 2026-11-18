from django.db import migrations


def install(apps, schema_editor):
    BotAccount = apps.get_model('sfera_bots', 'BotAccount')
    UserModule = apps.get_model('sfera_modules', 'UserModule')
    owners = set(BotAccount.objects.exclude(owner_id=None).values_list('owner_id', flat=True))
    UserModule.objects.bulk_create(
        [UserModule(user_id=uid, module_id='bots') for uid in owners], ignore_conflicts=True,
    )


class Migration(migrations.Migration):
    dependencies = [
        ('sfera_bots', '0002_botaccount_api_tier'),
        ('sfera_modules', '0001_initial'),
    ]
    operations = [migrations.RunPython(install, migrations.RunPython.noop)]
