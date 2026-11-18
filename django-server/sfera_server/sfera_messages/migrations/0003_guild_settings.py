import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('sfera_messages', '0002_conversationparticipant'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # New fields on Guild
        migrations.AddField('Guild', 'tag', models.CharField(blank=True, default='', max_length=8)),
        migrations.AddField('Guild', 'boost_level', models.PositiveIntegerField(default=0)),
        migrations.AddField('Guild', 'verification_level', models.CharField(default='none', max_length=20)),
        migrations.AddField('Guild', 'default_notifications', models.CharField(default='all', max_length=20)),
        migrations.AddField('Guild', 'explicit_content_filter', models.CharField(default='disabled', max_length=30)),
        migrations.AddField('Guild', 'require_2fa', models.BooleanField(default=False)),

        # GuildEmoji
        migrations.CreateModel(
            name='GuildEmoji',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('name', models.CharField(max_length=50)),
                ('image', models.ImageField(upload_to='guild_emojis/')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('guild', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='emojis', to='sfera_messages.guild')),
                ('uploader', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={'unique_together': {('guild', 'name')}},
        ),

        # GuildSticker
        migrations.CreateModel(
            name='GuildSticker',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('name', models.CharField(max_length=50)),
                ('description', models.CharField(blank=True, max_length=200)),
                ('image', models.ImageField(upload_to='guild_stickers/')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('guild', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='stickers', to='sfera_messages.guild')),
                ('uploader', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
        ),

        # GuildSound
        migrations.CreateModel(
            name='GuildSound',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('name', models.CharField(max_length=50)),
                ('file', models.FileField(upload_to='guild_sounds/')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('guild', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='sounds', to='sfera_messages.guild')),
                ('uploader', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
        ),

        # GuildRole
        migrations.CreateModel(
            name='GuildRole',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('name', models.CharField(max_length=50)),
                ('color', models.CharField(default='#99aab5', max_length=7)),
                ('permissions', models.JSONField(default=list)),
                ('position', models.PositiveIntegerField(default=0)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('guild', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='custom_roles', to='sfera_messages.guild')),
            ],
            options={'ordering': ['position', 'created_at']},
        ),

        # GuildMemberRole
        migrations.CreateModel(
            name='GuildMemberRole',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('membership', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='custom_role_assignments', to='sfera_messages.guildmembership')),
                ('role', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='member_assignments', to='sfera_messages.guildrole')),
            ],
            options={'unique_together': {('membership', 'role')}},
        ),

        # GuildInvite
        migrations.CreateModel(
            name='GuildInvite',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('code', models.CharField(blank=True, max_length=16, unique=True)),
                ('max_uses', models.PositiveIntegerField(blank=True, null=True)),
                ('uses', models.PositiveIntegerField(default=0)),
                ('expires_at', models.DateTimeField(blank=True, null=True)),
                ('is_active', models.BooleanField(default=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('guild', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='invites', to='sfera_messages.guild')),
                ('creator', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
        ),

        # GuildAuditLog
        migrations.CreateModel(
            name='GuildAuditLog',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('action', models.CharField(max_length=50)),
                ('actor_id', models.CharField(max_length=40)),
                ('actor_username', models.CharField(max_length=150)),
                ('target_id', models.CharField(blank=True, max_length=40)),
                ('target_username', models.CharField(blank=True, max_length=150)),
                ('details', models.JSONField(default=dict)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('guild', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='audit_logs', to='sfera_messages.guild')),
            ],
            options={'ordering': ['-created_at']},
        ),
    ]
