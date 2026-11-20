from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    initial = True
    dependencies = [migrations.swappable_dependency(settings.AUTH_USER_MODEL), ('sfera_messages','0032_cipherreadreceipt')]
    operations = [
        migrations.CreateModel(name='ApplicationReplica', fields=[
            ('id',models.PositiveSmallIntegerField(default=1,primary_key=True,serialize=False)),
            ('network',models.CharField(max_length=64)),('genesis',models.CharField(max_length=64)),
            ('height',models.PositiveBigIntegerField(default=0)),('snapshot_digest',models.CharField(max_length=64))]),
        migrations.CreateModel(name='AccountProjection', fields=[
            ('owner',models.CharField(max_length=64,primary_key=True,serialize=False)),
            ('version',models.PositiveIntegerField()),('digest',models.CharField(max_length=64)),
            ('user',models.OneToOneField(on_delete=django.db.models.deletion.PROTECT,to=settings.AUTH_USER_MODEL))]),
        migrations.CreateModel(name='DialogProjection', fields=[
            ('identity',models.CharField(max_length=64,primary_key=True,serialize=False)),('digest',models.CharField(max_length=64)),
            ('conversation',models.OneToOneField(on_delete=django.db.models.deletion.PROTECT,to='sfera_messages.conversation'))]),
    ]
