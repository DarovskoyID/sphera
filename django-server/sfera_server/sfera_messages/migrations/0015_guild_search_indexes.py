from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sfera_messages", "0014_comments"),
    ]

    operations = [
        migrations.AlterField(
            model_name="guild",
            name="name",
            field=models.CharField(db_index=True, max_length=100),
        ),
        migrations.AlterField(
            model_name="guild",
            name="tag",
            field=models.CharField(blank=True, db_index=True, default="", max_length=8),
        ),
        migrations.AddIndex(
            model_name="guild",
            index=models.Index(fields=["is_discoverable", "name"], name="guild_disc_name_idx"),
        ),
    ]
