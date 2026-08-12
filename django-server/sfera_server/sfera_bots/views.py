"""Bot API.

Three audiences share this module:

* the **owner** (JWT) — creating bots, rotating keys, editing commands, saving
  node graphs, adding a bot to a guild;
* the **bot itself** (API key) — long-polling for updates and sending messages;
* the **client UI** (JWT) — reading the command list to draw the command button
  next to the composer.
"""

import time
import uuid

from rest_framework import status
from rest_framework.decorators import (
    api_view, authentication_classes, parser_classes, permission_classes,
)
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from django.core.files.base import ContentFile
from django.db.models import Q
from django.http import HttpResponse

from sfera_auth.models import Friendship
from sfera_messages.encryption import decrypt_bytes, encrypt_bytes
from sfera_messages.models import (
    Attachment, Conversation, Guild, GuildAttachment, GuildChannel,
    GuildMembership, GuildMessage, Message,
)
# Same ceiling as the app's own composer, so a bot cannot post a message the
# clients would refuse to accept.
from sfera_messages.views import MAX_ATTACHMENTS_PER_MESSAGE

from .auth import BotTokenAuthentication
from .models import BotAccount, BotFlow, BotUpdate
from . import outbound
from .sferonik import create_bot, delete_bot, ensure_sferonik, parse_command_list

# Long-poll ceiling. Kept below typical proxy read timeouts (60s) so a poll
# always returns a response rather than dying in a gateway.
MAX_POLL_SECONDS = 45
POLL_INTERVAL = 0.5
MAX_MESSAGE_LENGTH = 4000
MAX_HISTORY = 200


def _bot_view(account, token=None):
    data = {
        'id': str(account.id),
        'user_id': str(account.user.id),
        'username': account.user.username,
        'display_name': account.display_name,
        'description': account.description,
        'avatar': account.user.avatar.url if account.user.avatar else '',
        'commands': account.commands,
        'token_prefix': account.token_prefix,
        'is_active': account.is_active,
        'is_system': account.is_system,
        'created_at': account.created_at.isoformat(),
        'owner_id': str(account.owner_id),
    }
    if token:
        data['token'] = token
    return data


# ── owner-facing ──────────────────────────────────────────────────────────

@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def bots(request):
    if request.method == 'GET':
        qs = BotAccount.objects.select_related('user').filter(owner=request.user, is_active=True)
        return Response({'bots': [_bot_view(b) for b in qs]})

    display_name = (request.data.get('display_name') or '').strip()
    username = (request.data.get('username') or '').strip()
    if not username:
        return Response({'error': 'username required'}, status=status.HTTP_400_BAD_REQUEST)
    try:
        account, token = create_bot(request.user, display_name or username, username)
    except ValueError as exc:
        return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    description = (request.data.get('description') or '').strip()[:280]
    if description:
        account.description = description
        account.save(update_fields=['description'])
    return Response(_bot_view(account, token), status=status.HTTP_201_CREATED)


def _owned(request, bot_id):
    return (
        BotAccount.objects.select_related('user')
        .filter(id=bot_id, owner=request.user, is_active=True, is_system=False)
        .first()
    )


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def bot_delete(request, bot_id):
    """Revoke the key and retire the bot. Conversations are left untouched."""
    account = _owned(request, bot_id)
    if account is None:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    delete_bot(account)
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def bot_rotate_token(request, bot_id):
    account = _owned(request, bot_id)
    if account is None:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    token = account.set_token()
    account.save(update_fields=['token_hash', 'token_prefix'])
    return Response(_bot_view(account, token))


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def bot_set_commands(request, bot_id):
    account = _owned(request, bot_id)
    if account is None:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    account.commands = _clean_commands(request.data.get('commands'))
    account.save(update_fields=['commands'])
    return Response(_bot_view(account))


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def bot_add_to_guild(request, bot_id, guild_id):
    """Put the owner's bot on one of their servers (owner/admin only)."""
    account = _owned(request, bot_id)
    if account is None:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    guild = Guild.objects.filter(id=guild_id).first()
    if guild is None:
        return Response({'error': 'guild not found'}, status=status.HTTP_404_NOT_FOUND)
    membership = GuildMembership.objects.filter(guild=guild, user=request.user).first()
    if membership is None or membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    GuildMembership.objects.get_or_create(
        guild=guild, user=account.user, defaults={'role': 'member'},
    )
    return Response({'ok': True})


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def bot_remove_from_guild(request, bot_id, guild_id):
    account = _owned(request, bot_id)
    if account is None:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    membership = GuildMembership.objects.filter(guild_id=guild_id, user=request.user).first()
    if membership is None or membership.role not in ('owner', 'admin'):
        return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
    GuildMembership.objects.filter(guild_id=guild_id, user=account.user).delete()
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def bot_unlock(request):
    """Exchange a bot key for its profile — how the node editor is unlocked.

    The key must belong to a bot the requesting user owns, so a leaked key
    can't be used to edit someone else's flow from the UI.
    """
    from .auth import bot_from_token

    account = bot_from_token((request.data.get('token') or '').strip())
    if account is None or account.owner_id != request.user.id:
        return Response({'error': 'invalid key'}, status=status.HTTP_403_FORBIDDEN)
    flow = BotFlow.objects.filter(bot=account).first()
    data = _bot_view(account)
    data['flow'] = flow.graph if flow else None
    return Response(data)


@api_view(['GET', 'PUT'])
@permission_classes([IsAuthenticated])
def bot_flow(request, bot_id):
    account = _owned(request, bot_id)
    if account is None:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    if request.method == 'GET':
        flow = BotFlow.objects.filter(bot=account).first()
        return Response({'graph': flow.graph if flow else {}, 'commands': account.commands})

    graph = request.data.get('graph')
    if not isinstance(graph, dict):
        return Response({'error': 'graph must be an object'}, status=status.HTTP_400_BAD_REQUEST)
    BotFlow.objects.update_or_create(bot=account, defaults={'graph': graph})
    commands = request.data.get('commands')
    if isinstance(commands, list):
        account.commands = _clean_commands(commands)
        account.save(update_fields=['commands'])
    return Response({'ok': True, 'commands': account.commands})


# ── client-facing ─────────────────────────────────────────────────────────

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def sferonik_chat(request):
    """Open (creating if needed) the DM with Сфероник — the developer-tools entry."""
    bot = ensure_sferonik()
    convo = outbound.dm_conversation_for(request.user, bot.user)
    # Сфероник used to be added as a contact; drop the leftover link so it stops
    # showing up in the DM list of accounts that opened it earlier.
    Friendship.objects.filter(
        Q(from_user=request.user, to_user=bot.user) | Q(from_user=bot.user, to_user=request.user),
    ).delete()
    first_time = not Message.objects.filter(conversation=convo).exists()
    if first_time:
        from .sferonik import HELP
        outbound.send_dm(bot.user, convo, HELP)
    return Response({
        'conversation_id': str(convo.id),
        'bot': _bot_view(bot),
    })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def commands_for_chat(request):
    """Commands available at a composer.

    `?user_id=` for a DM, `?channel_id=` for a guild channel. Returns one entry
    per bot present, so a channel with several bots shows all of them.
    """
    user_id = request.GET.get('user_id')
    channel_id = request.GET.get('channel_id')
    accounts = []
    if user_id:
        accounts = list(
            BotAccount.objects.select_related('user')
            .filter(user_id=user_id, is_active=True)
        )
    elif channel_id:
        channel = GuildChannel.objects.filter(id=channel_id).first()
        if channel is None:
            return Response({'bots': []})
        if not GuildMembership.objects.filter(guild_id=channel.guild_id, user=request.user).exists():
            return Response({'error': 'forbidden'}, status=status.HTTP_403_FORBIDDEN)
        bot_user_ids = GuildMembership.objects.filter(
            guild_id=channel.guild_id, user__account_type='bot',
        ).values_list('user_id', flat=True)
        accounts = list(
            BotAccount.objects.select_related('user')
            .filter(user_id__in=list(bot_user_ids), is_active=True)
        )
    return Response({'bots': [
        {
            'user_id': str(a.user_id),
            'username': a.user.username,
            'display_name': a.display_name,
            'avatar': a.user.avatar.url if a.user.avatar else '',
            'commands': a.commands,
        }
        for a in accounts if a.commands
    ]})


# ── bot-facing (API key) ──────────────────────────────────────────────────

@api_view(['GET'])
@authentication_classes([BotTokenAuthentication])
@permission_classes([IsAuthenticated])
def me(request):
    return Response(_bot_view(request.bot_account))


@api_view(['POST'])
@authentication_classes([BotTokenAuthentication])
@permission_classes([IsAuthenticated])
def set_commands(request):
    account = request.bot_account
    account.commands = _clean_commands(request.data.get('commands'))
    account.save(update_fields=['commands'])
    return Response({'ok': True, 'commands': account.commands})


@api_view(['GET'])
@authentication_classes([BotTokenAuthentication])
@permission_classes([IsAuthenticated])
def get_updates(request):
    """Long-poll for events.

    `offset` is the id of the last update the bot processed: everything up to
    and including it is deleted, and anything newer is returned. `timeout`
    (seconds, 0–45) controls how long an empty queue is waited on.
    """
    account = request.bot_account
    try:
        offset = int(request.GET.get('offset') or 0)
    except ValueError:
        offset = 0
    try:
        timeout = min(max(int(request.GET.get('timeout') or 0), 0), MAX_POLL_SECONDS)
    except ValueError:
        timeout = 0
    limit = min(max(int(request.GET.get('limit') or 50), 1), 100)

    if offset:
        BotUpdate.objects.filter(bot=account, id__lte=offset).exclude(
            update_type='sferonik_state',
        ).delete()

    deadline = time.monotonic() + timeout
    while True:
        rows = list(
            BotUpdate.objects
            .filter(bot=account, id__gt=offset)
            .exclude(update_type='sferonik_state')
            .order_by('id')[:limit]
        )
        if rows or time.monotonic() >= deadline:
            break
        time.sleep(POLL_INTERVAL)

    return Response({'updates': [
        {
            'id': r.id,
            'type': r.update_type,
            'created_at': r.created_at.isoformat(),
            **r.payload,
        }
        for r in rows
    ]})


@api_view(['POST'])
@authentication_classes([BotTokenAuthentication])
@permission_classes([IsAuthenticated])
def send(request):
    """Post a message into a DM or a guild channel the bot belongs to.

    Either `text` or `attachment_ids` (from `/api/bots/api/upload/`) has to be
    present — a message may be a caption, a bare photo, or both.
    """
    account = request.bot_account
    chat_id = (request.data.get('chat_id') or '').strip()
    text = (request.data.get('text') or '').strip()
    reply_to_id = request.data.get('reply_to')
    try:
        attachment_ids = _attachment_ids(request.data.get('attachment_ids'))
    except ValueError as exc:
        return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    if not chat_id or (not text and not attachment_ids):
        return Response(
            {'error': 'chat_id and either text or attachment_ids are required'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    if len(text) > MAX_MESSAGE_LENGTH:
        return Response({'error': 'text too long'}, status=status.HTTP_400_BAD_REQUEST)

    try:
        kind, target = outbound.resolve_chat(account.user, chat_id)
    except (ValueError, TypeError):
        return Response({'error': 'bad chat_id'}, status=status.HTTP_400_BAD_REQUEST)
    if kind is None:
        return Response({'error': 'chat not found for this bot'}, status=status.HTTP_404_NOT_FOUND)

    try:
        if kind == 'dm':
            reply_to = Message.objects.filter(id=reply_to_id, conversation=target).first() if reply_to_id else None
            _msg, payload = outbound.send_dm(account.user, target, text, reply_to, attachment_ids)
        else:
            reply_to = GuildMessage.objects.filter(id=reply_to_id, channel=target).first() if reply_to_id else None
            _msg, payload = outbound.send_channel(account.user, target, text, reply_to, attachment_ids)
    except ValueError:
        return Response(
            {'error': 'attachment not found, already sent, or from another chat'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    return Response(payload, status=status.HTTP_201_CREATED)


def _attachment_ids(raw):
    """Normalise the `attachment_ids` field. Raises ValueError with a message
    fit to hand straight back to the caller."""
    if raw in (None, ''):
        return []
    if not isinstance(raw, list):
        raw = [raw]
    if len(raw) > MAX_ATTACHMENTS_PER_MESSAGE:
        raise ValueError(f'at most {MAX_ATTACHMENTS_PER_MESSAGE} attachments per message')
    out = []
    for item in raw:
        try:
            out.append(uuid.UUID(str(item)))
        except (TypeError, ValueError):
            raise ValueError('bad attachment id') from None
    return out


@api_view(['POST'])
@authentication_classes([BotTokenAuthentication])
@permission_classes([IsAuthenticated])
def edit(request):
    """Rewrite a message the bot sent earlier."""
    account = request.bot_account
    message_id = (request.data.get('message_id') or '').strip()
    text = (request.data.get('text') or '').strip()
    if not message_id or not text:
        return Response({'error': 'message_id and text are required'}, status=status.HTTP_400_BAD_REQUEST)
    if len(text) > MAX_MESSAGE_LENGTH:
        return Response({'error': 'text too long'}, status=status.HTTP_400_BAD_REQUEST)
    try:
        payload = outbound.edit_message(account.user, message_id, text)
    except (ValueError, TypeError):
        return Response({'error': 'bad message_id'}, status=status.HTTP_400_BAD_REQUEST)
    if payload is None:
        return Response({'error': 'message not found or not the bot\'s'}, status=status.HTTP_404_NOT_FOUND)
    return Response(payload)


@api_view(['POST'])
@authentication_classes([BotTokenAuthentication])
@permission_classes([IsAuthenticated])
def delete(request):
    """Delete a message the bot sent earlier."""
    account = request.bot_account
    message_id = (request.data.get('message_id') or '').strip()
    if not message_id:
        return Response({'error': 'message_id is required'}, status=status.HTTP_400_BAD_REQUEST)
    try:
        removed = outbound.delete_message(account.user, message_id)
    except (ValueError, TypeError):
        return Response({'error': 'bad message_id'}, status=status.HTTP_400_BAD_REQUEST)
    if not removed:
        return Response({'error': 'message not found or not the bot\'s'}, status=status.HTTP_404_NOT_FOUND)
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['GET'])
@authentication_classes([BotTokenAuthentication])
@permission_classes([IsAuthenticated])
def chats(request):
    """Where the bot currently lives: DM conversations and guild channels."""
    account = request.bot_account
    dms = []
    for convo in Conversation.objects.filter(participants=account.user).prefetch_related('participants'):
        peer = next((p for p in convo.participants.all() if p.id != account.user.id), None)
        dms.append({
            'chat_id': str(convo.id),
            'chat_type': 'dm',
            'peer': outbound.user_payload(peer) if peer else None,
        })
    channels = []
    guild_ids = GuildMembership.objects.filter(user=account.user).values_list('guild_id', flat=True)
    for ch in GuildChannel.objects.filter(guild_id__in=list(guild_ids), channel_type='text').select_related('guild'):
        channels.append({
            'chat_id': str(ch.id),
            'chat_type': 'channel',
            'name': ch.name,
            'guild_id': str(ch.guild_id),
            'guild_name': ch.guild.name,
        })
    return Response({'chats': dms + channels})


@api_view(['POST'])
@authentication_classes([BotTokenAuthentication])
@permission_classes([IsAuthenticated])
@parser_classes([MultiPartParser, FormParser])
def upload(request):
    """Stage a file for a later `send`.

    Upload and send are two steps, exactly as for a person: the file is stored
    unattached, and the id it returns is passed to `/send` as `attachment_ids`.
    That lets one message carry several files and keeps the send call plain
    JSON. The file is bound to the chat it was uploaded for and can only be
    sent there, once.
    """
    from sfera_messages.views import (
        MAX_UPLOAD_SIZE, _safe_upload, _scan_upload,
    )

    account = request.bot_account
    chat_id = (request.data.get('chat_id') or '').strip()
    uploaded = request.FILES.get('file')
    if not chat_id or not uploaded:
        return Response({'error': 'chat_id and file are required'}, status=status.HTTP_400_BAD_REQUEST)

    try:
        kind, target = outbound.resolve_chat(account.user, chat_id)
    except (ValueError, TypeError):
        return Response({'error': 'bad chat_id'}, status=status.HTTP_400_BAD_REQUEST)
    if kind is None:
        return Response({'error': 'chat not found for this bot'}, status=status.HTTP_404_NOT_FOUND)

    if uploaded.size > MAX_UPLOAD_SIZE:
        return Response({'error': 'file too large (max 50 MB)'}, status=status.HTTP_400_BAD_REQUEST)
    ok, content_type = _safe_upload(uploaded)
    if not ok:
        return Response({'error': 'file type not allowed'}, status=status.HTTP_400_BAD_REQUEST)
    raw = uploaded.read()
    if not _scan_upload(raw):
        return Response({'error': 'file rejected by scanner'}, status=status.HTTP_400_BAD_REQUEST)

    if kind == 'dm':
        att = Attachment(conversation=target, uploader=account.user)
    else:
        att = GuildAttachment(channel=target, uploader=account.user)
    att.original_filename = uploaded.name
    att.content_type = content_type
    att.file_size = len(raw)
    att.file.save(f'{uuid.uuid4().hex}.enc', ContentFile(encrypt_bytes(raw)), save=True)

    return Response(outbound.bot_attachment_payload(att), status=status.HTTP_201_CREATED)


@api_view(['GET'])
@authentication_classes([BotTokenAuthentication])
@permission_classes([IsAuthenticated])
def file(request, attachment_id):
    """Download an attachment from a chat the bot belongs to.

    The app's own `/api/attachments/` route needs a JWT and the app-only
    header, so bots read files through here instead.
    """
    att = outbound.visible_attachment(request.bot_account.user, attachment_id)
    if att is None:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)
    try:
        with att.file.open('rb') as fh:
            encrypted = fh.read()
    except FileNotFoundError:
        return Response({'error': 'not found'}, status=status.HTTP_404_NOT_FOUND)

    response = HttpResponse(decrypt_bytes(encrypted), content_type=att.content_type)
    filename = att.original_filename.replace('"', '\\"')
    response['Content-Disposition'] = f'attachment; filename="{filename}"'
    response['Content-Length'] = att.file_size
    response['X-Content-Type-Options'] = 'nosniff'
    return response


@api_view(['GET'])
@authentication_classes([BotTokenAuthentication])
@permission_classes([IsAuthenticated])
def history(request):
    """Read a chat back: `?chat_id=&limit=&before=`.

    Unlike `/updates`, this does not consume anything — it is for bots that
    need context (a summariser, a moderator) rather than a live feed.
    """
    account = request.bot_account
    chat_id = (request.GET.get('chat_id') or '').strip()
    if not chat_id:
        return Response({'error': 'chat_id is required'}, status=status.HTTP_400_BAD_REQUEST)
    try:
        kind, target = outbound.resolve_chat(account.user, chat_id)
    except (ValueError, TypeError):
        return Response({'error': 'bad chat_id'}, status=status.HTTP_400_BAD_REQUEST)
    if kind is None:
        return Response({'error': 'chat not found for this bot'}, status=status.HTTP_404_NOT_FOUND)

    try:
        limit = min(max(int(request.GET.get('limit') or 50), 1), MAX_HISTORY)
    except ValueError:
        limit = 50
    before = (request.GET.get('before') or '').strip() or None
    try:
        messages = outbound.history(kind, target, limit, before)
    except (ValueError, TypeError):
        return Response({'error': 'bad before'}, status=status.HTTP_400_BAD_REQUEST)
    return Response({'chat_id': chat_id, 'chat_type': kind, 'messages': messages})


@api_view(['GET'])
@authentication_classes([BotTokenAuthentication])
@permission_classes([IsAuthenticated])
def members(request):
    """Who else is in the chat: `?chat_id=`."""
    account = request.bot_account
    chat_id = (request.GET.get('chat_id') or '').strip()
    if not chat_id:
        return Response({'error': 'chat_id is required'}, status=status.HTTP_400_BAD_REQUEST)
    try:
        kind, target = outbound.resolve_chat(account.user, chat_id)
    except (ValueError, TypeError):
        return Response({'error': 'bad chat_id'}, status=status.HTTP_400_BAD_REQUEST)
    if kind is None:
        return Response({'error': 'chat not found for this bot'}, status=status.HTTP_404_NOT_FOUND)
    return Response({'chat_id': chat_id, 'chat_type': kind, 'members': outbound.members(kind, target)})


@api_view(['POST'])
@authentication_classes([BotTokenAuthentication])
@permission_classes([IsAuthenticated])
def react(request):
    """React to a channel message, or take the reaction back with `remove`.

    Channel-only: direct messages carry no reactions in the data model.
    """
    account = request.bot_account
    message_id = (request.data.get('message_id') or '').strip()
    emoji = (request.data.get('emoji') or '').strip()[:50]
    if not message_id or not emoji:
        return Response({'error': 'message_id and emoji are required'}, status=status.HTTP_400_BAD_REQUEST)
    try:
        uuid.UUID(message_id)
    except ValueError:
        return Response({'error': 'bad message_id'}, status=status.HTTP_400_BAD_REQUEST)
    try:
        reactions = outbound.react(account.user, message_id, emoji, bool(request.data.get('remove')))
    except ValueError as exc:
        return Response({'error': str(exc)}, status=status.HTTP_409_CONFLICT)
    if reactions is None:
        return Response(
            {'error': 'message not found, or not in a channel the bot belongs to'},
            status=status.HTTP_404_NOT_FOUND,
        )
    return Response({'message_id': message_id, 'reactions': reactions})


def _clean_commands(raw):
    """Accept either the structured list or the plain `cmd - description` text."""
    if isinstance(raw, str):
        return parse_command_list(raw)
    if not isinstance(raw, list):
        return []
    lines = []
    for item in raw:
        if isinstance(item, dict):
            lines.append(f"{item.get('command', '')} - {item.get('description', '')}")
        elif isinstance(item, str):
            lines.append(item)
    return parse_command_list('\n'.join(lines))
