"""Adopt the family tables that sfera_auth created (state only), add locations."""
import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('sfera_auth', '0020_move_family_to_module'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.CreateModel(
                    name='Family',
                    fields=[
                        ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                        ('name', models.CharField(max_length=60)),
                        ('invite_code', models.CharField(blank=True, max_length=16, unique=True)),
                        ('server_id', models.UUIDField(blank=True, null=True, db_column='guild_id')),
                        ('created_at', models.DateTimeField(auto_now_add=True)),
                        ('created_by', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL,
                                                         related_name='families_created', to=settings.AUTH_USER_MODEL)),
                    ],
                    options={'db_table': 'sfera_auth_family'},
                ),
                migrations.CreateModel(
                    name='FamilyMembership',
                    fields=[
                        ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                        ('role', models.CharField(choices=[('parent', 'Parent'), ('child', 'Child')], default='parent', max_length=6)),
                        ('birth_date', models.DateField(blank=True, null=True)),
                        ('joined_at', models.DateTimeField(auto_now_add=True)),
                        ('family', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='memberships',
                                                     to='sfera_family.family')),
                        ('user', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name='family_membership',
                                                      to=settings.AUTH_USER_MODEL)),
                    ],
                    options={'db_table': 'sfera_auth_familymembership'},
                ),
            ],
        ),
        migrations.CreateModel(
            name='FamilyLocation',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('lat', models.FloatField()),
                ('lng', models.FloatField()),
                ('label', models.CharField(blank=True, default='', max_length=120)),
                ('live_until', models.DateTimeField(db_index=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('family', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='locations', to='sfera_family.family')),
                ('user', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name='family_location', to=settings.AUTH_USER_MODEL)),
            ],
        ),
    ]
