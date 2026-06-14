"""Full-text search index for guild messages (channel posts & server messages).

Message bodies are encrypted at rest, so we can't index them with SQLite triggers
(those only see ciphertext). Instead we maintain an FTS5 table populated from Python
with the decrypted plaintext plus any #hashtags the author wrote in the post.
"""
import re
from django.db import connection

_HASHTAG_RE = re.compile(r'#(\w{1,32})', re.UNICODE)
_FTS_READY = None


def extract_hashtags(text):
    if not text:
        return []
    out = []
    for tag in _HASHTAG_RE.findall(text):
        t = tag.lower()
        if t not in out:
            out.append(t)
    return out[:20]


def _fts_ok():
    global _FTS_READY
    if _FTS_READY is not None:
        return _FTS_READY
    if connection.vendor != 'sqlite':
        _FTS_READY = False
        return False
    try:
        with connection.cursor() as c:
            c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_fts'")
            _FTS_READY = c.fetchone() is not None
    except Exception:
        _FTS_READY = False
    return _FTS_READY


def index_message(message):
    """(Re)index one GuildMessage. Safe to call after create/edit; never raises."""
    if not _fts_ok():
        return
    try:
        content = message.content or ''
        tags = ' '.join(extract_hashtags(content))
        guild_id = str(message.channel.guild_id)
        with connection.cursor() as c:
            c.execute("DELETE FROM message_fts WHERE message_id = %s", [str(message.id)])
            c.execute(
                "INSERT INTO message_fts(message_id, guild_id, channel_id, content, tags) "
                "VALUES (%s, %s, %s, %s, %s)",
                [str(message.id), guild_id, str(message.channel_id), content, tags],
            )
    except Exception:
        pass


def unindex_message(message_id):
    if not _fts_ok():
        return
    try:
        with connection.cursor() as c:
            c.execute("DELETE FROM message_fts WHERE message_id = %s", [str(message_id)])
    except Exception:
        pass


def search_messages(query, limit=100):
    """Return raw FTS hits as a list of (message_id, guild_id, channel_id).

    Caller is responsible for filtering to guilds the user may see. Returns None if
    FTS is unavailable so the caller can decide on a fallback.
    """
    if not _fts_ok():
        return None
    terms = [re.sub(r'[^\w]', '', t) for t in query.replace('#', ' ').split()]
    terms = [t for t in terms if t][:5]
    if not terms:
        return None
    match = ' '.join(f'{t}*' for t in terms)
    try:
        with connection.cursor() as c:
            c.execute(
                "SELECT message_id, guild_id, channel_id FROM message_fts "
                "WHERE message_fts MATCH %s LIMIT %s",
                [match, limit],
            )
            return c.fetchall()
    except Exception:
        return None
