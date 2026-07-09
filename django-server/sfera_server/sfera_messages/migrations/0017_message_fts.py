from django.db import migrations


CREATE_SQL = r"""
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
    message_id UNINDEXED, guild_id UNINDEXED, channel_id UNINDEXED,
    content, tags,
    tokenize = "unicode61 remove_diacritics 2"
);
"""

DROP_SQL = "DROP TABLE IF EXISTS message_fts;"


def forwards(apps, schema_editor):
    if schema_editor.connection.vendor != 'sqlite':
        return
    with schema_editor.connection.cursor() as cur:
        cur.executescript(CREATE_SQL)

    # Backfill existing messages (decrypt in Python, then index).
    from sfera_messages.search_index import index_message
    import sfera_messages.search_index as si
    si._FTS_READY = True  # table just created
    GuildMessage = apps.get_model('sfera_messages', 'GuildMessage')
    # The historical model lacks the decrypt property/relations we need, so use the
    # real model for indexing.
    from sfera_messages.models import GuildMessage as RealGuildMessage
    ids = GuildMessage.objects.values_list('id', flat=True)
    for mid in ids.iterator(chunk_size=500):
        try:
            index_message(RealGuildMessage.objects.select_related('channel').get(id=mid))
        except Exception:
            pass


def backwards(apps, schema_editor):
    if schema_editor.connection.vendor != 'sqlite':
        return
    with schema_editor.connection.cursor() as cur:
        cur.executescript(DROP_SQL)


class Migration(migrations.Migration):

    dependencies = [
        ("sfera_messages", "0016_guild_fts"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
