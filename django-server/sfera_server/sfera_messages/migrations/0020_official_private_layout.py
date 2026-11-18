import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    """Official servers, private diaries, and per-user server-bar layout (folders)."""

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("sfera_messages", "0019_rename_indexes_after_rebrand"),
    ]

    operations = [
        migrations.AddField(
            model_name="guild",
            name="is_official",
            field=models.BooleanField(db_index=True, default=False),
        ),
        migrations.AddField(
            model_name="guild",
            name="is_private",
            field=models.BooleanField(default=False),
        ),
        migrations.CreateModel(
            name="UserServerLayout",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("layout", models.JSONField(blank=True, default=list)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("user", models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name="server_layout", to=settings.AUTH_USER_MODEL)),
            ],
        ),
    ]
