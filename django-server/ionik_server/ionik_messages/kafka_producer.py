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


def publish_chat_message(conversation_id: str, payload: dict):
    producer = get_producer()
    producer.produce(
        topic='chat.messages',
        key=str(conversation_id).encode(),
        value=ujson.dumps(payload).encode(),
        callback=_delivery_report,
    )
    producer.poll(0)


def publish_chat_notification(payload: dict):
    producer = get_producer()
    producer.produce(
        topic='chat.notifications',
        value=ujson.dumps(payload).encode(),
        callback=_delivery_report,
    )
    producer.poll(0)


def publish_guild_message(channel_id: str, payload: dict):
    producer = get_producer()
    producer.produce(
        topic='guild.messages',
        key=str(channel_id).encode(),
        value=ujson.dumps(payload).encode(),
        callback=_delivery_report,
    )
    producer.poll(0)


def publish_guild_notification(payload: dict):
    producer = get_producer()
    producer.produce(
        topic='guild.notifications',
        value=ujson.dumps(payload).encode(),
        callback=_delivery_report,
    )
    producer.poll(0)


def flush():
    if _producer:
        _producer.flush(timeout=5)
