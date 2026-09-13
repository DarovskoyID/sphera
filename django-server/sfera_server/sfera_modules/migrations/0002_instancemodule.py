from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


def per_user_to_instance(apps, schema_editor):
    """Modules become instance-wide: anything any user had stays installed."""
    UserModule = apps.get_model('sfera_modules', 'UserModule')
    InstanceModule = apps.get_model('sfera_modules', 'InstanceModule')
    for mid in UserModule.objects.values_list('module_id', flat=True).distinct():
        InstanceModule.objects.get_or_create(module_id=mid)


class Migration(migrations.Migration):

    dependencies = [
        ('sfera_modules', '0001_initial'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='InstanceModule',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('module_id', models.CharField(max_length=64, unique=True)),
                ('installed_at', models.DateTimeField(auto_now_add=True)),
                ('installed_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.RunPython(per_user_to_instance, migrations.RunPython.noop),
    ]
