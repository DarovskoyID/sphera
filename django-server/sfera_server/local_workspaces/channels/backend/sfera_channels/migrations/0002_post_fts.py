from django.db import migrations

TABLE = 'sfera_channels_post_fts'


def create(apps, schema_editor):
    if schema_editor.connection.vendor != 'sqlite':
        return  # production indexes through Elasticsearch
    try:
        schema_editor.execute(
            f'CREATE VIRTUAL TABLE IF NOT EXISTS {TABLE} USING fts5('
            'post_id UNINDEXED, channel_id UNINDEXED, content, tags, tokenize="unicode61")'
        )
    except Exception:
        pass  # SQLite without FTS5: search degrades to "no results"


def drop(apps, schema_editor):
    if schema_editor.connection.vendor == 'sqlite':
        schema_editor.execute(f'DROP TABLE IF EXISTS {TABLE}')


class Migration(migrations.Migration):
    dependencies = [('sfera_channels', '0001_initial')]
    operations = [migrations.RunPython(create, drop)]
