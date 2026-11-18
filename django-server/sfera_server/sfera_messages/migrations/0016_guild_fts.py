from django.db import migrations


# SQLite FTS5 full-text index over guilds, kept in sync with triggers.
# This is the SQLite-native counterpart to Postgres full-text + GIN.
CREATE_SQL = r"""
CREATE VIRTUAL TABLE IF NOT EXISTS guild_fts USING fts5(
    guild_id UNINDEXED, name, description, tags, tag,
    tokenize = "unicode61 remove_diacritics 2"
);

INSERT INTO guild_fts (guild_id, name, description, tags, tag)
SELECT id, name, description, tags, tag FROM sfera_messages_guild;

CREATE TRIGGER IF NOT EXISTS guild_fts_ai AFTER INSERT ON sfera_messages_guild BEGIN
    INSERT INTO guild_fts(guild_id, name, description, tags, tag)
    VALUES (new.id, new.name, new.description, new.tags, new.tag);
END;

CREATE TRIGGER IF NOT EXISTS guild_fts_ad AFTER DELETE ON sfera_messages_guild BEGIN
    DELETE FROM guild_fts WHERE guild_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS guild_fts_au AFTER UPDATE ON sfera_messages_guild BEGIN
    DELETE FROM guild_fts WHERE guild_id = old.id;
    INSERT INTO guild_fts(guild_id, name, description, tags, tag)
    VALUES (new.id, new.name, new.description, new.tags, new.tag);
END;
"""

DROP_SQL = r"""
DROP TRIGGER IF EXISTS guild_fts_ai;
DROP TRIGGER IF EXISTS guild_fts_ad;
DROP TRIGGER IF EXISTS guild_fts_au;
DROP TABLE IF EXISTS guild_fts;
"""


def forwards(apps, schema_editor):
    # Only meaningful on SQLite; skip silently elsewhere so the migration stays portable.
    if schema_editor.connection.vendor != 'sqlite':
        return
    with schema_editor.connection.cursor() as cur:
        cur.executescript(CREATE_SQL)


def backwards(apps, schema_editor):
    if schema_editor.connection.vendor != 'sqlite':
        return
    with schema_editor.connection.cursor() as cur:
        cur.executescript(DROP_SQL)


class Migration(migrations.Migration):

    dependencies = [
        ("sfera_messages", "0015_guild_search_indexes"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
