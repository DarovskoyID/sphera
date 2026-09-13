"""Kafka topics for servers: guild messages published by the Rust ws-gateway."""
import logging

from sfera_messages.kafka_worker import _normalize_id_list, _notify_bots, _process_notification

logger = logging.getLogger(__name__)


def _process_guild_message(data: dict):
    from .models import GuildChannel, GuildMembership, GuildMessage, GuildAttachment
    from sfera_messages.encryption import encrypt_text

    content = data.get('content', '')
    author_id = data.get('author_id')
    channel_id = data.get('channel_id')
    attachment_ids = data.get('attachment_ids', [])
    reply_to_id = data.get('reply_to_id')
    msg_uuid = data.get('msg_id')

    if not channel_id or not author_id:
        return
    attachment_ids = _normalize_id_list(attachment_ids)
    if attachment_ids is None:
        logger.warning('Rejected guild message with malformed attachment_ids')
        return
    channel = GuildChannel.objects.filter(id=channel_id).only('id', 'guild_id').first()
    if not channel or not GuildMembership.objects.filter(guild_id=channel.guild_id, user_id=author_id).exists():
        logger.warning('Rejected guild message for unauthorized channel=%s author=%s', channel_id, author_id)
        return

    if reply_to_id and not GuildMessage.objects.filter(id=reply_to_id, channel_id=channel_id).exists():
        logger.warning('Rejected guild message with invalid reply=%s channel=%s', reply_to_id, channel_id)
        return

    if attachment_ids:
        valid_count = GuildAttachment.objects.filter(
            id__in=attachment_ids,
            channel_id=channel_id,
            uploader_id=author_id,
            message__isnull=True,
        ).count()
        if valid_count != len(set(attachment_ids)):
            logger.warning('Rejected guild message with invalid attachments channel=%s author=%s', channel_id, author_id)
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
        GuildAttachment.objects.filter(
            id__in=attachment_ids,
            channel_id=channel_id,
            uploader_id=author_id,
            message__isnull=True,
        ).update(message=msg)

    from .search_index import index_message
    index_message(msg)

    _notify_bots('channel', msg)


def handlers():
    return {
        'guild.messages': _process_guild_message,
        'guild.notifications': _process_notification,
    }
