from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import ionik_messages.models


class Migration(migrations.Migration):

    dependencies = [
        ('ionik_messages', '0004_rename_ionik_msg_conv_created_idx_ionik_messa_convers_014240_idx_and_more'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='Attachment',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('file', models.FileField(upload_to=ionik_messages.models._attachment_upload_path)),
                ('original_filename', models.CharField(max_length=255)),
                ('content_type', models.CharField(max_length=100)),
                ('file_size', models.PositiveIntegerField()),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('conversation', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='attachments',
                    to='ionik_messages.conversation',
                )),
                ('message', models.ForeignKey(
                    blank=True,
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='attachments',
                    to='ionik_messages.message',
                )),
                ('uploader', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    to=settings.AUTH_USER_MODEL,
                )),
            ],
        ),
    ]
