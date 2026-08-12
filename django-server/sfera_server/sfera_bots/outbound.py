"""Sending messages *as* a bot, and queueing incoming events *for* a bot.

Everything here reuses the ordinary message models and the ordinary realtime
fanout, so a bot message is indistinguishable from a human one on the wire —
clients render it through the same path (and therefore through the same
client-side content filter).
"""

from django.db.models import Q

from sfera_messages.models import (
    Attachment, Conversation, ConversationParticipant, Message,
    GuildAttachment, GuildChannel, GuildMembership, GuildMessage,
    GuildMessageReaction,
)
from sfera_messages.encryption import encrypt_text
from sfera_messages.views import _fanout, _fanout_user_notifs

from .models import BotUpdate


def user_payload(u):
    return {
        'id': str(u.id),
        'username': u.username,
        'nickname': getattr(u, 'nickname', '') or '',
        'avatar': u.avatar.url if getattr(u, 'avatar', None) else '',
        'status': getattr(u, 'status', 'online'),
        'account_type': getattr(u, 'account_type', 'user'),
    }


def client_attachment_payload(att, is_guild):
    """Attachment as the *app* clients expect it, for the realtime fanout."""
    base = '/api/guild-attachments/' if is_guild else '/api/attachments/'
    return {
        'id': str(att.id),
        'filename': att.original_filename,
        'content_type': att.content_type,
        'file_size': att.file_size,
        'url': f'{base}{att.id}/',
    }


def bot_attachment_payload(att):
    """Attachment as a *bot* sees it.

    Bots hold an API key, not a JWT, and the app download endpoints also sit
    behind the X-Ionik-Client header — so they are pointed at the bot API's own
    file route instead. The id is the same either way.
    """
    return {
        'id': str(att.id),
        'filename': att.original_filename,
        'content_type': att.content_type,
        'file_size': att.file_size,
        'url': f'/api/bots/api/file/{att.id}/',
    }


def message_attachments(message, is_guild):
    model = GuildAttachment if is_guild else Attachment
    return [bot_attachment_payload(a) for a in model.objects.filter(message=message)]


def ensure_contact(user, bot_user):
    """Make a bot show up in the user's DM list.

    The list is built from accepted friendships, and a bot has nobody to accept
    a request on its behalf, so the link is created already accepted the moment
    a conversation with the bot starts. Removing the bot from the list stays a
    normal "remove friend" action.

    System bots (Сфероник) are excluded: they are tools reached from the server
    bar, and listing them among contacts only clutters the DM list.
    """
    from sfera_auth.models import Friendship
    from .models import BotAccount

    if BotAccount.objects.filter(user=bot_user, is_system=True).exists():
        return
    if Friendship.objects.filter(
        Q(from_user=user, to_user=bot_user) | Q(from_user=bot_user, to_user=user),
    ).exists():
        return
    Friendship.objects.create(from_user=user, to_user=bot_user, status='accepted')


def dm_conversation_for(user_a, user_b, create=True):
    """The 1-on-1 conversation between two users, created on demand."""
    convo = (
        Conversation.objects
        .filter(participants=user_a)
        .filter(participants=user_b)
        .first()
    )
    if convo is None and create:
        convo = Conversation.objects.create()
        ConversationParticipant.objects.create(conversation=convo, user=user_a)
        ConversationParticipant.objects.create(conversation=convo, user=user_b)
    if convo is not None:
        # Whichever side is the bot, the human gets the contact entry.
        if getattr(user_b, 'account_type', 'user') == 'bot' and getattr(user_a, 'account_type', 'user') != 'bot':
            ensure_contact(user_a, user_b)
        elif getattr(user_a, 'account_type', 'user') == 'bot' and getattr(user_b, 'account_type', 'user') != 'bot':
            ensure_contact(user_b, user_a)
    return convo


def _claim(model, bot_user, attachment_ids, message, **scope):
    """Attach previously uploaded files to the message that now carries them.

    Only the bot's own unclaimed uploads inside the same chat are eligible, so
    a bot cannot re-post someone else's file by guessing an id.
    """
    if not attachment_ids:
        return []
    qs = model.objects.filter(
        id__in=attachment_ids, uploader=bot_user, message__isnull=True, **scope,
    )
    rows = list(qs)
    if len(rows) != len(set(str(i) for i in attachment_ids)):
        raise ValueError('invalid attachment')
    qs.update(message=message)
    return rows


def send_dm(bot_user, conversation, content, reply_to=None, attachment_ids=None):
    msg = Message.objects.create(
        conversation=conversation,
        author=bot_user,
        encrypted_content=encrypt_text(content),
        reply_to=reply_to,
    )
    files = _claim(Attachment, bot_user, attachment_ids, msg, conversation=conversation)
    payload = {
        'id': str(msg.id),
        'author': user_payload(bot_user),
        'content': content,
        'created_at': msg.created_at.isoformat(),
        'attachments': [client_attachment_payload(a, False) for a in files],
        'reply_to': (
            {
                'id': str(reply_to.id),
                'author': user_payload(reply_to.author),
                'content': reply_to.content[:200],
            } if reply_to else None
        ),
        'is_pinned': False,
        'edited': False,
    }
    _fanout(f'chat_{conversation.id}', {'type': 'chat_message', 'message': payload}, payload)
    _fanout_user_notifs(
        list(conversation.participants.exclude(id=bot_user.id).values_list('id', flat=True)),
        {
            'type': 'new_message_notification',
            'sender_id': str(bot_user.id),
            'sender_name': bot_user.nickname or bot_user.username,
            'content': content or ('\U0001f4ce Attachment' if files else ''),
        },
    )
    return msg, _bot_view_of(payload, files)


def _bot_view_of(payload, files):
    """The same message, with attachment URLs a bot can actually fetch."""
    return {**payload, 'attachments': [bot_attachment_payload(a) for a in files]}


def send_channel(bot_user, channel, content, reply_to=None, attachment_ids=None):
    msg = GuildMessage.objects.create(
        channel=channel,
        author=bot_user,
        encrypted_content=encrypt_text(content),
        reply_to=reply_to,
    )
    files = _claim(GuildAttachment, bot_user, attachment_ids, msg, channel=channel)
    payload = {
        'id': str(msg.id),
        'author': user_payload(bot_user),
        'content': content,
        'created_at': msg.created_at.isoformat(),
        'is_pinned': False,
        'edited': False,
        'tags': [],
        'reply_to': (
            {
                'id': str(reply_to.id),
                'content': reply_to.content,
                'author': {'id': str(reply_to.author.id), 'username': reply_to.author.username},
            } if reply_to else None
        ),
        'attachments': [client_attachment_payload(a, True) for a in files],
        'reactions': [],
        'views': 0,
        'comments_count': 0,
    }
    _fanout(f'guild_channel_{channel.id}', {'type': 'chat_message', 'message': payload}, payload)
    return msg, _bot_view_of(payload, files)


def edit_message(bot_user, message_id, text):
    """Rewrite one of the bot's own messages, in a DM or a channel.

    Returns the payload the clients merge by id, or None when the message
    isn't the bot's. Broadcast shape matches the human edit path exactly."""
    from sfera_messages.views import _broadcast

    msg = Message.objects.filter(id=message_id, author=bot_user).first()
    if msg is not None:
        msg.content = text
        msg.edited = True
        msg.save(update_fields=['encrypted_content', 'edited'])
        payload = {'id': str(msg.id), 'content': text, 'edited': True}
        _broadcast(f'chat_{msg.conversation_id}', {'type': 'message_edited', 'message': payload})
        return payload

    guild_msg = GuildMessage.objects.filter(id=message_id, author=bot_user).first()
    if guild_msg is None:
        return None
    guild_msg.content = text
    guild_msg.edited = True
    guild_msg.save(update_fields=['encrypted_content', 'edited'])
    payload = {'id': str(guild_msg.id), 'content': text, 'edited': True}
    _broadcast(f'guild_channel_{guild_msg.channel_id}', {'type': 'message_edited', 'message': payload})
    return payload


def delete_message(bot_user, message_id):
    """Remove one of the bot's own messages."""
    from sfera_messages.views import _broadcast

    msg = Message.objects.filter(id=message_id, author=bot_user).first()
    if msg is not None:
        conversation_id = msg.conversation_id
        msg.delete()
        _broadcast(f'chat_{conversation_id}', {'type': 'message_deleted', 'id': str(message_id)})
        return True

    guild_msg = GuildMessage.objects.filter(id=message_id, author=bot_user).first()
    if guild_msg is None:
        return False
    channel_id = guild_msg.channel_id
    guild_msg.delete()
    _broadcast(f'guild_channel_{channel_id}', {'type': 'message_deleted', 'id': str(message_id)})
    return True


def parse_command(text):
    """'/ban @x 3d' -> ('ban', '@x 3d'); None when the text isn't a command."""
    text = (text or '').strip()
    if not text.startswith('/'):
        return None
    head, _, rest = text[1:].partition(' ')
    # '/help@my_bot' addresses one specific bot in a busy channel.
    name, _, mention = head.partition('@')
    if not name:
        return None
    return name.lower(), rest.strip(), (mention or '').lower()


def _queue(bot, update_type, payload):
    BotUpdate.objects.create(bot=bot, update_type=update_type, payload=payload)


def dispatch_dm_message(message):
    """Called after a human sends a DM: queue it for the bot on the other side."""
    from .models import BotAccount
    from .sferonik import handle_sferonik_message, is_sferonik

    author = message.author
    if getattr(author, 'account_type', 'user') == 'bot':
        return  # bots don't drive other bots
    others = message.conversation.participants.exclude(id=author.id)
    for other in others:
        bot = BotAccount.objects.select_related('user').filter(user=other, is_active=True).first()
        if bot is None:
            continue
        if is_sferonik(bot):
            handle_sferonik_message(bot, message)
            continue
        _queue(bot, _update_type(message.content), _message_update(message, chat_type='dm'))


def dispatch_channel_message(message):
    """Called after a human posts in a guild channel: queue it for member bots."""
    from .models import BotAccount

    author = message.author
    if getattr(author, 'account_type', 'user') == 'bot':
        return
    guild_id = message.channel.guild_id
    bot_user_ids = GuildMembership.objects.filter(
        guild_id=guild_id, user__account_type='bot',
    ).values_list('user_id', flat=True)
    if not bot_user_ids:
        return
    parsed = parse_command(message.content)
    for bot in BotAccount.objects.select_related('user').filter(user_id__in=list(bot_user_ids), is_active=True):
        # `/cmd@other_bot` in a shared channel is addressed to exactly one bot.
        if parsed and parsed[2] and parsed[2] != bot.user.username.lower():
            continue
        _queue(bot, _update_type(message.content), _message_update(message, chat_type='channel'))


def _update_type(content):
    return BotUpdate.UPDATE_COMMAND if parse_command(content) else BotUpdate.UPDATE_MESSAGE


def _message_update(message, chat_type):
    parsed = parse_command(message.content)
    data = {
        'chat_type': chat_type,
        'message': {
            'id': str(message.id),
            'content': message.content,
            'created_at': message.created_at.isoformat(),
            'from': user_payload(message.author),
            'attachments': message_attachments(message, chat_type == 'channel'),
        },
    }
    if chat_type == 'dm':
        data['chat_id'] = str(message.conversation_id)
    else:
        data['chat_id'] = str(message.channel_id)
        data['guild_id'] = str(message.channel.guild_id)
    if parsed:
        data['command'] = parsed[0]
        data['args'] = parsed[1]
    return data


def resolve_chat(bot_user, chat_id):
    """Find the DM conversation or guild channel a bot is allowed to post to."""
    convo = (
        Conversation.objects
        .filter(id=chat_id, participants=bot_user)
        .first()
    )
    if convo is not None:
        return 'dm', convo
    channel = GuildChannel.objects.filter(id=chat_id, channel_type='text').first()
    if channel is not None and GuildMembership.objects.filter(
        guild_id=channel.guild_id, user=bot_user,
    ).exists():
        return 'channel', channel
    return None, None


# ── reading a chat back ───────────────────────────────────────────────────────


def history(kind, target, limit, before=None):
    """The newest `limit` messages, oldest first.

    `before` is a message id: only messages older than it are returned, which
    is how a bot walks backwards through a long conversation one page at a
    time. An unknown id is ignored rather than treated as an error, so a bot
    paging past the start of a chat simply gets an empty list.
    """
    is_guild = kind == 'channel'
    model = GuildMessage if is_guild else Message
    scope = {'channel': target} if is_guild else {'conversation': target}
    qs = model.objects.filter(**scope).select_related('author')

    if before:
        anchor = model.objects.filter(id=before, **scope).first()
        if anchor is not None:
            qs = qs.filter(created_at__lt=anchor.created_at)

    rows = list(qs.order_by('-created_at')[:limit])
    rows.reverse()
    return [
        {
            'id': str(m.id),
            'content': m.content,
            'created_at': m.created_at.isoformat(),
            'edited': m.edited,
            'from': user_payload(m.author),
            'attachments': message_attachments(m, is_guild),
        }
        for m in rows
    ]


def members(kind, target):
    """Who is in the chat. A DM has exactly two sides; a channel has the guild."""
    if kind == 'dm':
        return [user_payload(u) for u in target.participants.all()]
    user_ids = GuildMembership.objects.filter(guild_id=target.guild_id).select_related('user')
    return [{**user_payload(m.user), 'role': m.role} for m in user_ids]


def react(bot_user, message_id, emoji, remove=False):
    """Add or drop one of the bot's reactions on a channel message.

    Returns the aggregated reaction list, or None when the message is not one
    the bot can see. DMs have no reactions in the data model, so this is
    channel-only.
    """
    from sfera_messages.views import _aggregate_reactions

    msg = (
        GuildMessage.objects
        .select_related('channel')
        .filter(id=message_id)
        .first()
    )
    if msg is None or not GuildMembership.objects.filter(
        guild_id=msg.channel.guild_id, user=bot_user,
    ).exists():
        return None

    existing = GuildMessageReaction.objects.filter(message=msg, user=bot_user)
    if remove:
        existing.filter(emoji=emoji).delete()
    elif not existing.filter(emoji=emoji).exists():
        # Same cap as a human: three distinct reactions per message.
        if existing.count() >= 3:
            raise ValueError('reaction limit reached')
        GuildMessageReaction.objects.create(message=msg, user=bot_user, emoji=emoji)

    reactions = _aggregate_reactions(msg.reactions.all(), bot_user)
    evt = {'type': 'reaction_update', 'message_id': str(msg.id), 'reactions': reactions}
    _fanout(f'guild_channel_{msg.channel_id}', evt, evt)
    return reactions


def visible_attachment(bot_user, attachment_id):
    """An attachment the bot is entitled to download, or None.

    Entitlement is chat membership, exactly as for a person: a DM the bot takes
    part in, or a channel in a guild the bot belongs to.
    """
    att = Attachment.objects.filter(
        id=attachment_id, conversation__participants=bot_user,
    ).first()
    if att is not None:
        return att
    guild_ids = GuildMembership.objects.filter(user=bot_user).values_list('guild_id', flat=True)
    return GuildAttachment.objects.filter(
        id=attachment_id, channel__guild_id__in=list(guild_ids),
    ).first()
