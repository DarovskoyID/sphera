from django.db import migrations, models


class Migration(migrations.Migration):
    """Manual tags on guild messages (for the private diary's search)."""

    dependencies = [
        ("sfera_messages", "0020_official_private_layout"),
    ]

    operations = [
        migrations.AddField(
            model_name="guildmessage",
            name="tags",
            field=models.JSONField(blank=True, default=list),
        ),
    ]
