from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('sfera_servers', '0002_install_for_members'), ('sfera_messages', '0029_messagemeshwrite_source')]
    operations = [migrations.AddField(model_name='guildmessage', name='mesh_write_id', field=models.CharField(blank=True, default='', max_length=64))]
