"""Sending messages *as* a bot, and queueing incoming events *for* a bot.

Everything here reuses the ordinary message models and the ordinary realtime
fanout, so a bot message is indistinguishable from a human one on the wire —
clients render it through the same path (and therefore through the same
client-side content filter).
"""

from django.db.models import Q

from sfera_messages.models import (
    Conversation, ConversationParticipant, Message,
    GuildChannel, GuildMembership, GuildMessage,
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


def ensure_contact(user, bot_user):
    """Make a bot show up in the user's DM list.

    The list is built from accepted friendships, and a bot has nobody to accept
    a request on its behalf, so the link is created already accepted the moment
    a conversation with the bot starts. Removing the bot from the list stays a
    normal "remove friend" action.
    """
    from sfera_auth.models import Friendship

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


def send_dm(bot_user, conversation, content, reply_to=None):
    msg = Message.objects.create(
        conversation=conversation,
        author=bot_user,
        encrypted_content=encrypt_text(content),
        reply_to=reply_to,
    )
    payload = {
        'id': str(msg.id),
        'author': user_payload(bot_user),
        'content': content,
        'created_at': msg.created_at.isoformat(),
        'attachments': [],
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
            'content': content,
        },
    )
    return msg, payload


def send_channel(bot_user, channel, content, reply_to=None):
    msg = GuildMessage.objects.create(
        channel=channel,
        author=bot_user,
        encrypted_content=encrypt_text(content),
        reply_to=reply_to,
    )
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
        'attachments': [],
        'reactions': [],
        'views': 0,
        'comments_count': 0,
    }
    _fanout(f'guild_channel_{channel.id}', {'type': 'chat_message', 'message': payload}, payload)
    return msg, payload


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
