import ujson
import logging
from confluent_kafka import Producer

logger = logging.getLogger(__name__)

_producer: Producer | None = None


def get_producer() -> Producer:
    global _producer
    if _producer is None:
        from django.conf import settings
        _producer = Producer({
            'bootstrap.servers': getattr(settings, 'KAFKA_BOOTSTRAP_SERVERS', 'localhost:9092'),
            'linger.ms': 5,
            'batch.num.messages': 1000,
            'queue.buffering.max.messages': 100000,
            'compression.type': 'lz4',
            'acks': 'all',
            'retries': 3,
            'retry.backoff.ms': 100,
        })
    return _producer


def _delivery_report(err, msg):
    if err:
        logger.error('Kafka delivery failed: %s', err)


def _safe_produce(topic: str, value: bytes, key: bytes | None = None) -> bool:
    """Produce без падений и без блокировки event-loop.

    Эти функции вызываются синхронно из async-консьюмеров (consumers.py).
    Если брокер недоступен, внутренняя очередь librdkafka переполняется и
    ``produce()`` бросает ``BufferError``. Раньше это исключение не
    обрабатывалось и могло сломать/подвесить корутину Daphne (см. инцидент
    с зависанием Daphne). Теперь любой сбой Kafka просто логируется и
    сообщение тихо отбрасывается — WS-доставка через Redis уже произошла.
    """
    try:
        producer = get_producer()
    except Exception:  # noqa: BLE001 — Kafka недоступен на этапе подключения
        logger.warning('Kafka producer unavailable, dropping message for %s', topic)
        return False

    try:
        producer.produce(topic=topic, key=key, value=value, callback=_delivery_report)
        # poll(0) неблокирующий: обслуживает колбэки доставки без ожидания
        producer.poll(0)
        return True
    except BufferError:
        # Очередь переполнена (брокер недоступен/медленный) — дренируем и бросаем
        logger.warning('Kafka local queue full, dropping message for %s', topic)
        try:
            producer.poll(0)
        except Exception:  # noqa: BLE001
            pass
        return False
    except Exception as exc:  # noqa: BLE001 — никогда не валим консьюмер из-за Kafka
        logger.error('Kafka produce failed for %s: %s', topic, exc)
        return False


def publish_chat_message(conversation_id: str, payload: dict):
    _safe_produce('chat.messages', ujson.dumps(payload).encode(), str(conversation_id).encode())


def publish_chat_notification(payload: dict):
    _safe_produce('chat.notifications', ujson.dumps(payload).encode())


def publish_guild_message(channel_id: str, payload: dict):
    _safe_produce('guild.messages', ujson.dumps(payload).encode(), str(channel_id).encode())


def publish_guild_notification(payload: dict):
    _safe_produce('guild.notifications', ujson.dumps(payload).encode())


def flush():
    if _producer:
        _producer.flush(timeout=5)
