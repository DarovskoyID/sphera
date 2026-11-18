from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('sfera_servers', '0004_guild_cipher')]
    operations = [migrations.AddField(model_name='guildciphermessageidentity', name='authorization', field=models.JSONField(default=dict))]
