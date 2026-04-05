from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('ionik_messages', '0002_rename_content_to_encrypted'),
    ]

    operations = [
        migrations.AddIndex(
            model_name='message',
            index=models.Index(
                fields=['conversation', '-created_at'],
                name='ionik_msg_conv_created_idx',
            ),
        ),
    ]
