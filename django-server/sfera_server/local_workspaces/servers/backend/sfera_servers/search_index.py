"""Full-text search index for guild messages (channel posts & server messages).

Message bodies are encrypted at rest, so we can't index them with SQLite triggers
(those only see ciphertext). Instead we maintain an FTS5 table populated from Python
with the decrypted plaintext plus any #hashtags the author wrote in the post.
"""
import os
import re
from django.db import connection

_HASHTAG_RE = re.compile(r'#(\w{1,32})', re.UNICODE)
_FTS_READY = None

# ── Elasticsearch backend ─────────────────────────────────────────────────────
# Если задан ELASTICSEARCH_URL — поиск идёт через ES (прод на Postgres, где
# sqlite-FTS недоступен). Иначе fallback на sqlite-FTS (локальная разработка).
_ES_URL = os.environ.get('ELASTICSEARCH_URL')
_ES_INDEX = os.environ.get('ELASTICSEARCH_INDEX', 'sfera_messages')
_es_client = None
_es_ready = None


def _es():
    """Ленивый ES-клиент; None если не настроен/недоступен. Никогда не бросает."""
    global _es_client, _es_ready
    if not _ES_URL or _es_ready is False:
        return None
    if _es_client is not None:
        return _es_client
    try:
        from elasticsearch import Elasticsearch
        # request_timeout щедрый: на нагруженном боксе ES отвечает медленно,
        # слишком жёсткий таймаут ронял _es() в fallback (и поиск ломался).
        cli = Elasticsearch(_ES_URL, request_timeout=10, max_retries=1, retry_on_timeout=False)
        if not cli.indices.exists(index=_ES_INDEX):
            cli.indices.create(index=_ES_INDEX, mappings={'properties': {
                'guild_id': {'type': 'keyword'},
                'channel_id': {'type': 'keyword'},
                'content': {'type': 'text'},
                'tags': {'type': 'text'},
            }})
        _es_client = cli
        _es_ready = True
        return cli
    except Exception:
        _es_ready = False
        return None


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
    content = message.content or ''
    tags = ' '.join(extract_hashtags(content))
    guild_id = str(message.channel.guild_id)

    es = _es()
    if es is not None:
        try:
            es.index(index=_ES_INDEX, id=str(message.id), document={
                'guild_id': guild_id,
                'channel_id': str(message.channel_id),
                'content': content,
                'tags': tags,
            })
        except Exception:
            pass
        return

    if not _fts_ok():
        return
    try:
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
    es = _es()
    if es is not None:
        try:
            es.delete(index=_ES_INDEX, id=str(message_id), ignore=[404])
        except Exception:
            pass
        return
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
    es = _es()
    if es is not None:
        q = query.replace('#', ' ').strip()
        if not q:
            return None
        try:
            res = es.search(
                index=_ES_INDEX, size=limit,
                source=['guild_id', 'channel_id'],
                query={'multi_match': {
                    'query': q, 'fields': ['content', 'tags^2'],
                    'operator': 'and', 'fuzziness': 'AUTO',
                }},
            )
            return [(h['_id'], h['_source'].get('guild_id'), h['_source'].get('channel_id'))
                    for h in res['hits']['hits']]
        except Exception:
            return None

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
