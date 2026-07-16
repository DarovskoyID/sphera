import uuid
from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    """Rich messages: polls (guild channels), todo checklists, contacts and
    locations (incl. live sharing) for DMs and guild channels."""

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("sfera_messages", "0017_message_fts"),
    ]

    operations = [
        # ── Message (DM) ────────────────────────────────────────────────────
        migrations.AddField(
            model_name="message",
            name="message_type",
            field=models.CharField(
                choices=[
                    ("text", "Text"),
                    ("poll", "Poll"),
                    ("todo", "Todo"),
                    ("contact", "Contact"),
                    ("location", "Location"),
                ],
                db_index=True,
                default="text",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="message",
            name="encrypted_payload",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.AddField(
            model_name="message",
            name="live_until",
            field=models.DateTimeField(blank=True, null=True),
        ),
        # ── GuildMessage ────────────────────────────────────────────────────
        migrations.AddField(
            model_name="guildmessage",
            name="message_type",
            field=models.CharField(
                choices=[
                    ("text", "Text"),
                    ("poll", "Poll"),
                    ("todo", "Todo"),
                    ("contact", "Contact"),
                    ("location", "Location"),
                ],
                db_index=True,
                default="text",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="guildmessage",
            name="encrypted_payload",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.AddField(
            model_name="guildmessage",
            name="live_until",
            field=models.DateTimeField(blank=True, null=True),
        ),
        # ── Poll votes (guild only) ─────────────────────────────────────────
        migrations.CreateModel(
            name="GuildPollVote",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("option_id", models.CharField(max_length=32)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("message", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="poll_votes", to="sfera_messages.guildmessage")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="+", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "unique_together": {("message", "user", "option_id")},
            },
        ),
        # ── Todo checks (DM) ────────────────────────────────────────────────
        migrations.CreateModel(
            name="TodoCheck",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("item_id", models.CharField(max_length=32)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("message", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="todo_checks", to="sfera_messages.message")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="+", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "unique_together": {("message", "item_id")},
            },
        ),
        # ── Todo checks (guild) ─────────────────────────────────────────────
        migrations.CreateModel(
            name="GuildTodoCheck",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("item_id", models.CharField(max_length=32)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("message", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="todo_checks", to="sfera_messages.guildmessage")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="+", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "unique_together": {("message", "item_id")},
            },
        ),
    ]
