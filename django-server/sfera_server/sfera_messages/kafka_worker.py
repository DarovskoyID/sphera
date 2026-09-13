"""
Kafka consumer worker — run as a standalone management command:
    python manage.py kafka_worker

Reads chat.messages / chat.notifications, plus topics modules register (e.g. guild.*).
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


def _normalize_id_list(value):
    if not value:
        return []
    if not isinstance(value, list) or len(value) > 10:
        return None
    return [str(item) for item in value]


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
    from sfera_messages.models import Conversation, Message, Attachment
    from sfera_messages.encryption import encrypt_text

    content = data.get('content', '')
    author_id = data.get('author_id')
    conversation_id = data.get('conversation_id')
    attachment_ids = data.get('attachment_ids', [])
    reply_to_id = data.get('reply_to_id')
    msg_uuid = data.get('msg_id')

    if not conversation_id or not author_id:
        return
    attachment_ids = _normalize_id_list(attachment_ids)
    if attachment_ids is None:
        logger.warning('Rejected chat message with malformed attachment_ids')
        return
    if not Conversation.objects.filter(id=conversation_id, participants__id=author_id).exists():
        logger.warning('Rejected chat message for unauthorized conversation=%s author=%s', conversation_id, author_id)
        return

    if reply_to_id and not Message.objects.filter(id=reply_to_id, conversation_id=conversation_id).exists():
        logger.warning('Rejected chat message with invalid reply=%s conversation=%s', reply_to_id, conversation_id)
        return

    if attachment_ids:
        valid_count = Attachment.objects.filter(
            id__in=attachment_ids,
            conversation_id=conversation_id,
            uploader_id=author_id,
            message__isnull=True,
        ).count()
        if valid_count != len(set(attachment_ids)):
            logger.warning('Rejected chat message with invalid attachments conversation=%s author=%s', conversation_id, author_id)
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
        Attachment.objects.filter(
            id__in=attachment_ids,
            conversation_id=conversation_id,
            uploader_id=author_id,
            message__isnull=True,
        ).update(message=msg)

    _notify_bots('dm', msg)

    # Send FCM push to the other participants. DMs reach this worker via the Kafka
    # 'chat.messages' topic (published by the Rust ws-gateway), which bypasses the
    # Django ChatConsumer — so without this, closed apps never get notified.
    try:
        from sfera_auth.models import User
        from sfera_server.fcm import send_to_user
        recipient_ids = [
            str(pid) for pid in Conversation.objects.filter(id=conversation_id)
            .values_list('participants__id', flat=True)
            if pid is not None and str(pid) != str(author_id)
        ]
        if recipient_ids:
            author = User.objects.filter(id=author_id).first()
            sender_name = (author.nickname or author.username) if author else ''
            notif_content = content if content else ('\U0001f4ce Attachment' if attachment_ids else '')
            for rid in recipient_ids:
                send_to_user(rid, {
                    'type': 'message',
                    'sender_name': sender_name,
                    'content': notif_content,
                })
    except Exception as e:
        logger.warning('FCM push (chat) failed: %s', e)


def _notify_bots(kind: str, message):
    """Hand the stored message to the bot layer.

    Real clients send through the Rust ws-gateway, which publishes to Kafka and
    lands here — not in the Django view or consumer. Without this hook a bot
    would only ever hear messages posted over HTTP.
    """
    from sfera_messages.services import emit_message_created
    emit_message_created(kind, message)


def _process_notification(data: dict):
    try:
        from sfera_server.fcm import send_to_user
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
    'chat.notifications': _process_notification,
}


def _handlers():
    """Core topics plus whatever modules subscribe to (hooks.KAFKA_HANDLERS)."""
    from sfera_modules import hooks
    merged = dict(HANDLERS)
    for provided in hooks.collect(hooks.KAFKA_HANDLERS).values():
        merged.update(provided or {})
    return merged


def run_worker():
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    handlers = _handlers()
    topics = list(handlers.keys())
    consumer = _make_consumer('sfera-message-workers', topics)
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
            handler = handlers.get(topic)
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
