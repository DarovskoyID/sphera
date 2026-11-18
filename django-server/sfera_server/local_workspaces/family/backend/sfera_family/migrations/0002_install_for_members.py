from django.db import migrations


def install(apps, schema_editor):
    FamilyMembership = apps.get_model('sfera_family', 'FamilyMembership')
    UserModule = apps.get_model('sfera_modules', 'UserModule')
    UserModule.objects.bulk_create(
        [UserModule(user_id=uid, module_id='family')
         for uid in FamilyMembership.objects.values_list('user_id', flat=True)],
        ignore_conflicts=True,
    )


class Migration(migrations.Migration):
    dependencies = [
        ('sfera_family', '0001_adopt_family_tables'),
        ('sfera_modules', '0001_initial'),
    ]
    operations = [migrations.RunPython(install, migrations.RunPython.noop)]
