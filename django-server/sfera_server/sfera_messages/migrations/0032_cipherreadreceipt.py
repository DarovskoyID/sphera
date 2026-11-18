from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [('sfera_messages', '0031_conversation_cipher_only')]
    operations = [migrations.CreateModel(name='CipherReadReceipt', fields=[
        ('message', models.OneToOneField(primary_key=True, serialize=False,
            on_delete=django.db.models.deletion.CASCADE, related_name='cipher_receipt', to='sfera_messages.message')),
        ('receipt', models.JSONField()), ('created_at', models.DateTimeField(auto_now_add=True)),
    ])]
