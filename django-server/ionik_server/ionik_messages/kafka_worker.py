"""
Kafka consumer worker — run as a standalone management command:
    python manage.py kafka_worker

Reads from chat.messages / guild.messages topics and persists to DB.
Reads from chat.notifications / guild.notifications and sends push notifications.
"""
import ujson
import logging
import signal
import threading
from confluent_kafka import Consumer, KafkaError

logger = logging.getLogger(__name__)

_shutdown = threading.Event()


def _handle_signal(*_):
    _shutdown.set()


def _make_consumer(group_id: str, topics: list[str]) -> Consumer:
    from django.conf import settings
    c = Consumer({
        'bootstrap.servers': getattr(settings, 'KAFKA_BOOTSTRAP_SERVERS', 'localhost:9092'),
        'group.id': group_id,
        'auto.offset.reset': 'latest',
        'enable.auto.commit': True,
        'auto.commit.interval.ms': 1000,
        'max.poll.interval.ms': 300000,
        'session.timeout.ms': 30000,
        'fetch.min.bytes': 1,
        'fetch.wait.max.ms': 100,
    })
    c.subscribe(topics)
    return c


def _process_chat_message(data: dict):
    from ionik_messages.models import Message, Attachment
    from ionik_messages.encryption import encrypt_text

    content = data.get('content', '')
    author_id = data.get('author_id')
    conversation_id = data.get('conversation_id')
    attachment_ids = data.get('attachment_ids', [])
    reply_to_id = data.get('reply_to_id')
    msg_uuid = data.get('msg_id')

    if not conversation_id or not author_id:
        return

    if msg_uuid:
        if Message.objects.filter(id=msg_uuid).exists():
            return

    msg = Message(
        conversation_id=conversation_id,
        author_id=author_id,
        encrypted_content=encrypt_text(content or ''),
        reply_to_id=reply_to_id,
    )
    if msg_uuid:
        msg.id = msg_uuid
    msg.save()

    if attachment_ids:
        Attachment.objects.filter(id__in=attachment_ids).update(message=msg)


def _process_guild_message(data: dict):
    from ionik_messages.models import GuildMessage, GuildAttachment
    from ionik_messages.encryption import encrypt_text

    content = data.get('content', '')
    author_id = data.get('author_id')
    channel_id = data.get('channel_id')
    attachment_ids = data.get('attachment_ids', [])
    reply_to_id = data.get('reply_to_id')
    msg_uuid = data.get('msg_id')

    if not channel_id or not author_id:
        return

    if msg_uuid:
        if GuildMessage.objects.filter(id=msg_uuid).exists():
            return

    msg = GuildMessage(
        channel_id=channel_id,
        author_id=author_id,
        encrypted_content=encrypt_text(content or ''),
        reply_to_id=reply_to_id,
    )
    if msg_uuid:
        msg.id = msg_uuid
    msg.save()

    if attachment_ids:
        GuildAttachment.objects.filter(id__in=attachment_ids).update(message=msg)

    from .search_index import index_message
    index_message(msg)


def _process_notification(data: dict):
    try:
        from ionik_server.fcm import send_to_user
    except Exception:
        return

    user_ids = data.get('user_ids', [])
    payload = data.get('payload', {})
    for uid in user_ids:
        try:
            send_to_user(uid, payload)
        except Exception as e:
            logger.warning('FCM push failed for user %s: %s', uid, e)


HANDLERS = {
    'chat.messages': _process_chat_message,
    'guild.messages': _process_guild_message,
    'chat.notifications': _process_notification,
    'guild.notifications': _process_notification,
}


def run_worker():
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    topics = list(HANDLERS.keys())
    consumer = _make_consumer('ionik-message-workers', topics)
    logger.info('Kafka worker started, topics: %s', topics)

    try:
        while not _shutdown.is_set():
            msg = consumer.poll(timeout=0.2)
            if msg is None:
                continue
            if msg.error():
                if msg.error().code() == KafkaError._PARTITION_EOF:
                    continue
                logger.error('Kafka error: %s', msg.error())
                continue

            topic = msg.topic()
            handler = HANDLERS.get(topic)
            if not handler:
                continue

            try:
                data = ujson.loads(msg.value())
                handler(data)
            except Exception:
                logger.exception('Failed to process message from %s', topic)
    finally:
        consumer.close()
        logger.info('Kafka worker stopped')
