import uuid
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [('sfera_messages', '0027_messagemeshchunk')]
    operations = [migrations.CreateModel(name='MessageMeshDelivery', fields=[
        ('id', models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False, serialize=False)),
        ('nonce', models.CharField(max_length=128, blank=True, default='')),
        ('state', models.CharField(max_length=12, default='pending', db_index=True)),
        ('created_at', models.DateTimeField(auto_now_add=True)),
        ('sent_at', models.DateTimeField(null=True)),
        ('message', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='mesh_deliveries', to='sfera_messages.message')),
        ('write', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to='sfera_messages.messagemeshwrite')),
    ])]
