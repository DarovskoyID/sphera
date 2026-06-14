import uuid
from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("ionik_messages", "0011_add_tags_to_guild"),
    ]

    operations = [
        migrations.AddField(
            model_name="guild",
            name="is_personal_channel",
            field=models.BooleanField(default=False),
        ),
        migrations.CreateModel(
            name="GuildMessageReaction",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("emoji", models.CharField(max_length=50)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("message", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="reactions", to="ionik_messages.guildmessage")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="+", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "unique_together": {("message", "user", "emoji")},
            },
        ),
    ]
