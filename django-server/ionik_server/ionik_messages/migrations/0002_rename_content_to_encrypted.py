from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('ionik_messages', '0001_initial'),
    ]

    operations = [
        migrations.RenameField(
            model_name='message',
            old_name='content',
            new_name='encrypted_content',
        ),
    ]
