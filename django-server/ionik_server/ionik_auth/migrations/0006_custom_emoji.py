import django.db.models.deletion
import ionik_auth.models
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('ionik_auth', '0005_add_user_settings'),
    ]

    operations = [
        migrations.CreateModel(
            name='CustomEmoji',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.SlugField(max_length=50, unique=True)),
                ('image', models.ImageField(upload_to=ionik_auth.models._emoji_upload_path)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('created_by', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='custom_emojis',
                    to=settings.AUTH_USER_MODEL,
                )),
            ],
        ),
    ]
