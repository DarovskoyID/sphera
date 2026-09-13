from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('sfera_bots', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='botaccount',
            name='api_tier',
            field=models.CharField(
                choices=[('standard', 'Standard'), ('premium', 'Premium')],
                default='standard',
                max_length=16,
            ),
        ),
    ]
