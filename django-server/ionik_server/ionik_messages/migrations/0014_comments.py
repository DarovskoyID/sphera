import uuid
from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("ionik_messages", "0013_guild_message_view"),
    ]

    operations = [
        migrations.AddField(
            model_name="guild",
            name="comments_enabled",
            field=models.BooleanField(default=True),
        ),
        migrations.CreateModel(
            name="GuildPostComment",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("encrypted_content", models.TextField()),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("author", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="+", to=settings.AUTH_USER_MODEL)),
                ("message", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="comments", to="ionik_messages.guildmessage")),
            ],
            options={
                "ordering": ["created_at"],
            },
        ),
    ]
