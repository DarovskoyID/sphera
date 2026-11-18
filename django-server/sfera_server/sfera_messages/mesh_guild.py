"""Guild adapter for the shared immutable publication and verified read pipeline."""
from django.apps import apps
from django.utils import timezone

from .mesh_sources import source_current
from .mesh_history import read_messages, recover_messages


def save_message(channel_id, author_id, content, *, attachments=(), reply_to=None, nonce='', identity=None, using='default'):
    from django.db import transaction
    from .encryption import encrypt_text
    from .mesh_delivery import client_nonce
    from .services import _id_list
    model = apps.get_model('sfera_servers.GuildMessage')
    membership_model = apps.get_model('sfera_servers.GuildMembership')
    attachment_model = apps.get_model('sfera_servers.GuildAttachment')
    channel_model = apps.get_model('sfera_servers.GuildChannel')
    ids = _id_list(list(attachments) if isinstance(attachments, tuple) else attachments)
    if len(ids) > 15 or not isinstance(content, str) or len(content) > 20000 or (not content.strip() and not ids):
        raise ValueError('invalid_mesh_guild_message')
    nonce = client_nonce(nonce)
    with transaction.atomic(using=using):
        channel = channel_model.objects.using(using).select_related('guild').get(pk=channel_id)
        member = membership_model.objects.using(using).select_for_update().select_related('user').filter(guild_id=channel.guild_id, user_id=author_id).first()
        if (member is None or not can_read(member.user, channel) or
                (member.muted_until and member.muted_until > timezone.now()) or
                (channel.guild.is_personal_channel and channel.guild.owner_id != member.user_id)):
            raise ValueError('mesh_guild_write_forbidden')
        if identity:
            existing = model.objects.using(using).filter(pk=identity).first()
            if existing:
                if (existing.channel_id != channel.pk or existing.author_id != member.user_id or existing.content != content
                        or set(str(pk) for pk in existing.attachments.values_list('pk', flat=True)) != set(str(pk) for pk in ids)):
                    raise ValueError('mesh_guild_message_identity_conflict')
                return existing
        if reply_to and not model.objects.using(using).filter(pk=reply_to, channel=channel).exists():
            raise ValueError('mesh_guild_reply_forbidden')
        files = attachment_model.objects.using(using).select_for_update().filter(pk__in=ids, channel=channel,
            uploader_id=author_id, message__isnull=True)
        if files.count() != len(set(ids)):
            raise ValueError('mesh_guild_attachment_forbidden')
        message = model(channel=channel, author=member.user, encrypted_content=encrypt_text(content), reply_to_id=reply_to)
        if identity:
            message.pk = identity
        message._mesh_nonce = nonce
        message.save(using=using)
        files.update(message=message)
        message.save(using=using, update_fields=['encrypted_content'])
        return message


def can_read(user, channel):
    from sfera_auth import bans
    from sfera_modules import hooks
    if not user.is_active or bans.is_banned(user.pk) or hooks.access_block(user.pk):
        return False
    membership = apps.get_model('sfera_servers.GuildMembership')
    return channel.guild.is_discoverable or membership.objects.using(channel._state.db).filter(guild_id=channel.guild_id, user=user).exists()


def recover_for_user(messages, user, **kwargs):
    if any(not can_read(user, message.channel) for message in messages):
        raise ValueError('mesh_guild_read_forbidden')
    result = recover_messages(messages, user.pk, **kwargs)
    if any(not can_read(user, message.channel) for message in messages):
        raise ValueError('mesh_guild_read_forbidden')
    return result


def event_payload(event, user, channel_id):
    from sfera_mesh.directory import digest64
    data = event.get('message')
    if not isinstance(data, dict) or not digest64(data.get('mesh_write_id')):
        raise ValueError('mesh_guild_event_unconfirmed')
    model = apps.get_model('sfera_servers.GuildMessage')
    message = model.objects.select_related('author', 'channel__guild').filter(pk=data.get('id'), channel_id=channel_id).first()
    if message is None:
        raise ValueError('mesh_guild_event_unavailable')
    payload = recover_for_user([message], user)[0]
    if payload['mesh_write_id'] != data['mesh_write_id'] or payload['consensus_committed'] is not True:
        raise ValueError('mesh_guild_event_revision_changed')
    for key in ('nonce', 'mesh_event_id', 'mesh_revision'):
        if key in data:
            payload[key] = data[key]
    return payload


def dispatch_event(writer, event, *, using='default', emit=None):
    from sfera_auth.models import UserBan
    from sfera_messages.models import MessageMeshDelivery
    message = source_current(event.write).select_for_update().select_related('author', 'channel__guild').first()
    if message is None or message.mesh_write_id != event.write_id:
        event.state = 'superseded'; event.save(update_fields=['state']); return 0
    membership_model = apps.get_model('sfera_servers.GuildMembership')
    membership = membership_model.objects.using(using).filter(guild_id=message.channel.guild_id, user_id=message.author_id).first()
    guild = message.channel.guild
    if (membership is None or not message.author.is_active or UserBan.objects.using(using).filter(user_id=message.author_id).exists()
            or (membership.muted_until and membership.muted_until > timezone.now())
            or (guild.is_personal_channel and guild.owner_id != message.author_id)):
        event.state = 'cancelled'; event.save(update_fields=['state']); return 0
    payload = read_messages(writer, [message], message.author_id)[0]
    if payload['consensus_committed'] is not True:
        raise ValueError('mesh_guild_delivery_unconfirmed')
    payload.update(nonce=event.nonce, mesh_event_id=str(event.pk), mesh_revision=event.created_at.isoformat())
    edited = MessageMeshDelivery.objects.using(using).filter(message_id=message.pk, write__source='guild', state__in=['sent', 'legacy']).exists()
    recipients = list(membership_model.objects.using(using).filter(guild_id=guild.pk).exclude(user_id=message.author_id).values_list('user_id', flat=True))
    finality = writer.publication.directory.anchor()
    (emit or emit_event)(message, payload, edited, recipients, finality)
    event.state, event.sent_at = 'sent', timezone.now()
    event.save(update_fields=['state', 'sent_at'])
    return 1


def emit_event(message, payload, edited, recipients, finality):
    from asgiref.sync import async_to_sync
    from channels.layers import get_channel_layer
    from .services import _gw_broadcast, notify_message_created, _fanout_user_notifs
    group = 'guild_channel_' + str(message.channel_id)
    event = {'type': 'message_edited' if edited else 'chat_message', 'message': payload}
    async_to_sync(get_channel_layer().group_send)(group, event)
    _gw_broadcast(group, {'type': 'message_edited', 'message': payload} if edited else payload, strict=True)
    # Index only the verified revision after transport enqueue. Redis text and
    # a mutable source cache cannot introduce a different search preview.
    from sfera_servers.search_index import index_message
    from .encryption import encrypt_text
    message.encrypted_content = encrypt_text(payload['content'])
    index_message(message)
    if not edited:
        notify_message_created('channel', message, mesh_confirmed=True)
        _fanout_user_notifs([str(user) for user in recipients], {'type': 'new_message_notification',
            'sender_id': str(message.author_id), 'sender_name': message.author.nickname or message.author.username,
            'content': payload['content'], 'guild_id': str(message.channel.guild_id), 'channel_id': str(message.channel_id)})
        try:
            from sfera_server.fcm import send_to_user
            for recipient in recipients:
                send_to_user(str(recipient), {'type': 'message', 'sender_name': message.author.nickname or message.author.username,
                    'content': payload['content'], 'guild_id': str(message.channel.guild_id), 'channel_id': str(message.channel_id)})
        except Exception:
            pass
