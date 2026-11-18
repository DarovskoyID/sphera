"""Post search index for discoverable channels.

Post bodies are encrypted at rest, so the index is fed with plaintext from Python:
Elasticsearch when ELASTICSEARCH_URL is set (production), an SQLite FTS5 table
otherwise (local). Never raises; callers fall back to "no results".
"""
import os
import re

from django.db import connection

_HASHTAG_RE = re.compile(r'#(\w{1,32})', re.UNICODE)
_ES_URL = os.environ.get('ELASTICSEARCH_URL')
_ES_INDEX = os.environ.get('SFERA_CHANNELS_ES_INDEX', 'sfera_channel_posts')
FTS_TABLE = 'sfera_channels_post_fts'

_es_client = None
_es_ready = None
_fts_ready = None


def _es():
    global _es_client, _es_ready
    if not _ES_URL or _es_ready is False:
        return None
    if _es_client is not None:
        return _es_client
    try:
        from elasticsearch import Elasticsearch
        cli = Elasticsearch(_ES_URL, request_timeout=10, max_retries=1, retry_on_timeout=False)
        if not cli.indices.exists(index=_ES_INDEX):
            cli.indices.create(index=_ES_INDEX, mappings={'properties': {
                'channel_id': {'type': 'keyword'},
                'content': {'type': 'text'},
                'tags': {'type': 'text'},
            }})
        _es_client, _es_ready = cli, True
        return cli
    except Exception:
        _es_ready = False
        return None


def _fts():
    global _fts_ready
    if _fts_ready is None:
        try:
            with connection.cursor() as c:
                _fts_ready = connection.vendor == 'sqlite' and FTS_TABLE in connection.introspection.table_names(c)
        except Exception:
            _fts_ready = False
    return _fts_ready


def hashtags(text):
    out = []
    for tag in _HASHTAG_RE.findall(text or ''):
        t = tag.lower()
        if t not in out:
            out.append(t)
    return out[:20]


def index_post(post):
    index_raw(post.id, post.channel_id, post.content or '', post.tags)


def index_raw(post_id, channel_id, content, manual_tags=()):
    tags = ' '.join(hashtags(content) + [t.lower() for t in (manual_tags or [])])
    post_id, channel_id = str(post_id), str(channel_id)
    es = _es()
    if es is not None:
        try:
            es.index(index=_ES_INDEX, id=post_id, document={
                'channel_id': channel_id, 'content': content, 'tags': tags,
            })
        except Exception:
            pass
        return
    if not _fts():
        return
    try:
        with connection.cursor() as c:
            c.execute(f'DELETE FROM {FTS_TABLE} WHERE post_id = %s', [post_id])
            c.execute(
                f'INSERT INTO {FTS_TABLE}(post_id, channel_id, content, tags) VALUES (%s, %s, %s, %s)',
                [post_id, channel_id, content, tags],
            )
    except Exception:
        pass


def unindex_post(post_id):
    es = _es()
    if es is not None:
        try:
            es.delete(index=_ES_INDEX, id=str(post_id), ignore=[404])
        except Exception:
            pass
        return
    if not _fts():
        return
    try:
        with connection.cursor() as c:
            c.execute(f'DELETE FROM {FTS_TABLE} WHERE post_id = %s', [str(post_id)])
    except Exception:
        pass


def search(query, limit=120):
    """[(post_id, channel_id)] or None when no index is available."""
    q = query.replace('#', ' ').strip()
    if not q:
        return None
    es = _es()
    if es is not None:
        try:
            res = es.search(index=_ES_INDEX, size=limit, source=['channel_id'], query={'multi_match': {
                'query': q, 'fields': ['content', 'tags^2'], 'operator': 'and', 'fuzziness': 'AUTO',
            }})
            return [(h['_id'], h['_source'].get('channel_id')) for h in res['hits']['hits']]
        except Exception:
            return None
    if not _fts():
        return None
    terms = [re.sub(r'[^\w]', '', t) for t in q.split()]
    terms = [t for t in terms if t][:5]
    if not terms:
        return None
    try:
        with connection.cursor() as c:
            c.execute(
                f'SELECT post_id, channel_id FROM {FTS_TABLE} WHERE {FTS_TABLE} MATCH %s LIMIT %s',
                [' '.join(f'{t}*' for t in terms), limit],
            )
            return c.fetchall()
    except Exception:
        return None
