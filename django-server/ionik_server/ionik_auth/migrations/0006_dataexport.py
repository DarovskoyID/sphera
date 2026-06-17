import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('ionik_auth', '0005_usersettings_allow_scale'),
    ]

    operations = [
        migrations.CreateModel(
            name='DataExport',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('status', models.CharField(choices=[('pending', 'Pending'), ('ready', 'Ready'), ('failed', 'Failed')], default='pending', max_length=10)),
                ('file', models.FileField(blank=True, null=True, upload_to='data_exports/')),
                ('item_count', models.PositiveIntegerField(default=0)),
                ('error', models.TextField(blank=True, default='')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('completed_at', models.DateTimeField(null=True, blank=True)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='data_exports', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
    ]
