"""Hash chain over the messages of a conversation.

Every message gets a link ``chain_hash = sha256(prev_hash + content_hash)``, so
a message edited, deleted or inserted afterwards breaks the chain and the break
is visible in the protocol. Only hashes are stored — never the text.

Load: the chain costs one insert per message. Three things keep it off the hot
path:

* it is off until the superuser turns it on (``LegalSettings.record_chain``);
* the signal is emitted by the core off the request thread, and here it only
  puts a small tuple into an in-memory queue;
* one writer thread drains the queue and writes whole batches per conversation
  in a single transaction, so a burst of a thousand messages is a handful of
  statements instead of a thousand.

The queue is in memory: a hard kill can lose the last few links. A missing link
shows in a protocol as a gap instead of a silent pass, which is the honest
behaviour for evidence.
"""
import hashlib
import json
import logging
import queue
import threading
import time

from django.db import close_old_connections, transaction
from django.utils import timezone

from .models import ChainEntry, ChainHead, LegalSettings

log = logging.getLogger('sfera.legal')


def _inc(name, amount=1):
    """Counters live in the core (Redis-backed, shared by worker processes)."""
    try:
        from sfera_server.metrics import inc

        inc(name, amount)
    except Exception:
        pass

QUEUE_MAX = 10_000
BATCH_MAX = 500
FLUSH_SECONDS = 1.0

_queue: 'queue.Queue[dict]' = queue.Queue(maxsize=QUEUE_MAX)
_worker: threading.Thread | None = None
_worker_lock = threading.Lock()
_settings_cache = {'at': 0.0, 'on': False}


def sha256(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode('utf-8')
    return hashlib.sha256(data).hexdigest()


def canonical(payload: dict) -> bytes:
    """Stable bytes for hashing: sorted keys, no spaces, UTF-8 as-is."""
    return json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def content_hash(*, message_id, author_id, sent_at, text, attachments=()) -> str:
    return sha256(canonical({
        'id': str(message_id),
        'author': str(author_id or ''),
        'sent_at': sent_at.isoformat() if hasattr(sent_at, 'isoformat') else str(sent_at),
        'text': sha256(text or ''),
        'attachments': sorted(str(a) for a in attachments),
    }))


def link_hash(prev_hash: str, entry_hash: str) -> str:
    return sha256(f'{prev_hash}|{entry_hash}')


def recording_enabled() -> bool:
    """Cached flag: the signal fires on every message."""
    now = time.monotonic()
    if now - _settings_cache['at'] > 30:
        try:
            _settings_cache['on'] = LegalSettings.load().record_chain
        except Exception:
            _settings_cache['on'] = False
        _settings_cache['at'] = now
    return _settings_cache['on']


def forget_settings():
    _settings_cache['at'] = 0.0


def dm_scope(conversation_id) -> str:
    return f'dm:{conversation_id}'


# ── Intake ───────────────────────────────────────────────────────────────────

def on_message_created(sender, kind=None, message=None, **kwargs):
    """``hooks.message_created`` receiver: queue the link, never block the sender."""
    if kind != 'dm' or message is None or not recording_enabled():
        return
    try:
        attachments = [a.id for a in message.attachments.all()] if hasattr(message, 'attachments') else []
        record(
            scope=dm_scope(message.conversation_id),
            message_id=message.id,
            author_id=message.author_id,
            sent_at=message.created_at or timezone.now(),
            text=message.content,
            attachments=attachments,
        )
    except Exception as e:  # never break message delivery because of the journal
        log.warning('legal: could not queue message %s: %s', getattr(message, 'id', '?'), e)


def record(*, scope, message_id, author_id, sent_at, text, attachments=()):
    item = {
        'scope': scope,
        'message_id': str(message_id),
        'author_id': str(author_id or ''),
        'sent_at': sent_at,
        'content_hash': content_hash(message_id=message_id, author_id=author_id, sent_at=sent_at, text=text, attachments=attachments),
    }
    try:
        _queue.put_nowait(item)
    except queue.Full:
        log.warning('legal: chain queue is full, link for %s dropped', message_id)
        _inc('legal_chain_dropped')
        return
    _ensure_worker()


def _ensure_worker():
    global _worker
    if _worker and _worker.is_alive():
        return
    with _worker_lock:
        if _worker and _worker.is_alive():
            return
        _worker = threading.Thread(target=_run, name='sfera-legal-chain', daemon=True)
        _worker.start()


def _run():
    while True:
        try:
            first = _queue.get(timeout=30)
        except queue.Empty:
            return
        batch = [first]
        deadline = time.monotonic() + FLUSH_SECONDS
        while len(batch) < BATCH_MAX:
            timeout = deadline - time.monotonic()
            if timeout <= 0:
                break
            try:
                batch.append(_queue.get(timeout=timeout))
            except queue.Empty:
                break
        try:
            flush(batch)
        except Exception as e:
            log.warning('legal: chain batch failed (%d links): %s', len(batch), e)
        finally:
            close_old_connections()


def flush(batch: list[dict]) -> int:
    """Write a batch; one transaction per conversation, head row locked."""
    by_scope: dict[str, list[dict]] = {}
    for item in batch:
        by_scope.setdefault(item['scope'], []).append(item)
    written = 0
    for scope, items in by_scope.items():
        items.sort(key=lambda i: (i['sent_at'], i['message_id']))
        with transaction.atomic():
            head, _ = ChainHead.objects.select_for_update().get_or_create(scope=scope)
            seq, prev = head.seq, head.last_hash
            rows = []
            for item in items:
                seq += 1
                chain = link_hash(prev, item['content_hash'])
                rows.append(ChainEntry(
                    scope=scope, seq=seq, message_id=item['message_id'], author_id=item['author_id'],
                    sent_at=item['sent_at'], content_hash=item['content_hash'], prev_hash=prev, chain_hash=chain,
                ))
                prev = chain
            created = ChainEntry.objects.bulk_create(rows, ignore_conflicts=True)
            # ignore_conflicts skips messages already in the chain (retries): if
            # anything was skipped the head must not move past what was written.
            stored = ChainEntry.objects.filter(scope=scope, seq__gt=head.seq).order_by('-seq').first()
            if stored:
                head.seq, head.last_hash = stored.seq, stored.chain_hash
                head.save(update_fields=['seq', 'last_hash', 'updated_at'])
            written += len(created)
    if written:
        _inc('legal_chain_links', written)
    return written


def flush_pending(timeout: float = 2.0) -> None:
    """Wait for the queue to drain (used before a protocol is sealed)."""
    _ensure_worker()
    deadline = time.monotonic() + timeout
    while not _queue.empty() and time.monotonic() < deadline:
        time.sleep(0.05)


# ── Verification ─────────────────────────────────────────────────────────────

def verify(scope: str, entries=None) -> tuple[bool | None, str]:
    """Recompute the chain of a conversation: (ok, human-readable note)."""
    rows = list(entries if entries is not None else ChainEntry.objects.filter(scope=scope).order_by('seq'))
    if not rows:
        return None, 'Цепочка по этой переписке не велась'
    prev = rows[0].prev_hash
    expected_seq = rows[0].seq
    for row in rows:
        if row.seq != expected_seq:
            return False, f'Пропущено звено №{expected_seq}'
        if row.prev_hash != prev or row.chain_hash != link_hash(prev, row.content_hash):
            return False, f'Звено №{row.seq} не сходится'
        prev = row.chain_hash
        expected_seq += 1
    return True, f'Проверено звеньев: {len(rows)}'
