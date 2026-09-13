"""Сфероник — the system bot that registers other bots.

It is a real bot account (so the DM with it looks and behaves like any other
chat), but its logic runs in-process instead of over the public bot API: the
key it would need to talk to itself is exactly what it hands out.

Conversation flow is deliberately BotFather-like and stateless apart from one
pending-registration marker kept per owner in the DB-less sense — the state is
derived from the last question asked, stored on the bot's own update queue.
"""

import re

from django.db import transaction
from django.utils import timezone

from sfera_auth.models import User
from .models import BotAccount, BotFlow, BotUpdate, BOT_USERNAME_SUFFIX

SFERONIK_USERNAME = 'sferonik_bot'
SFERONIK_NAME = 'Сфероник'
SFERONIK_BIO = 'Регистрирую ботов и выдаю ключи. Напишите /newbot.'

MAX_BOTS_PER_OWNER = 20
USERNAME_RE = re.compile(r'^[a-z0-9_]{4,28}$')

HELP = (
    '# Сфероник\n'
    'Через меня создаются боты Сферы.\n\n'
    '**Создание**\n'
    '- `/newbot` — создать бота и получить ключ\n'
    '  При создании выбирается тип API: **стандартный** (обычный лимит) или '
    '**продвинутый** (премиум, повышенная пропускная способность).\n'
    '- `/mybots` — список ваших ботов\n\n'
    '**Настройка**\n'
    '- `/setcommands <бот>` — команды, которые видны у поля ввода\n'
    '- `/token <бот>` — выпустить новый ключ (старый перестанет работать)\n\n'
    '**Серверы**\n'
    '- `/addbot <бот>` — добавить бота на свой сервер\n'
    '- `/removebot <бот>` — убрать бота с сервера\n\n'
    '**Прочее**\n'
    '- `/deletebot <бот>` — удалить бота: ключ перестаёт работать, переписки остаются\n'
    '- `/help` — эта справка'
)


def ensure_sferonik():
    """Get (or lazily create) the Сфероник bot account."""
    bot = BotAccount.objects.select_related('user').filter(user__username=SFERONIK_USERNAME).first()
    if bot is not None:
        return bot
    with transaction.atomic():
        user, _ = User.objects.get_or_create(
            username=SFERONIK_USERNAME,
            defaults={
                'nickname': SFERONIK_NAME,
                'bio': SFERONIK_BIO,
                'account_type': 'bot',
                'status': 'online',
                'is_active': False,  # cannot be logged into
            },
        )
        if user.account_type != 'bot':
            user.account_type = 'bot'
            user.save(update_fields=['account_type'])
        bot, _ = BotAccount.objects.get_or_create(
            user=user,
            defaults={
                'owner': user,
                'display_name': SFERONIK_NAME,
                'description': SFERONIK_BIO,
                'is_system': True,
                'token_hash': f'system:{user.id}',
                'commands': [
                    {'command': 'newbot', 'description': 'Создать бота и получить ключ'},
                    {'command': 'mybots', 'description': 'Мои боты'},
                    {'command': 'token', 'description': 'Выпустить новый ключ'},
                    {'command': 'setcommands', 'description': 'Задать команды бота'},
                    {'command': 'addbot', 'description': 'Добавить бота на свой сервер'},
                    {'command': 'removebot', 'description': 'Убрать бота с сервера'},
                    {'command': 'deletebot', 'description': 'Удалить бота'},
                    {'command': 'help', 'description': 'Справка'},
                ],
            },
        )
    return bot


def is_sferonik(bot):
    return bot.user.username == SFERONIK_USERNAME


# ── pending-question state ────────────────────────────────────────────────
# Сфероник asks one question at a time. The outstanding question is stored as
# an update row on its own queue keyed by the asking user, so no extra table is
# needed and the state disappears with the bot.

_STATE_TYPE = 'sferonik_state'


def _get_state(bot, user_id):
    row = (
        BotUpdate.objects
        .filter(bot=bot, update_type=_STATE_TYPE, payload__user_id=str(user_id))
        .order_by('-id').first()
    )
    return row.payload if row else None


def _set_state(bot, user_id, state):
    BotUpdate.objects.filter(
        bot=bot, update_type=_STATE_TYPE, payload__user_id=str(user_id),
    ).delete()
    if state:
        payload = dict(state)
        payload['user_id'] = str(user_id)
        BotUpdate.objects.create(bot=bot, update_type=_STATE_TYPE, payload=payload)


def handle_sferonik_message(bot, message):
    """Entry point called for every DM sent to Сфероник."""
    from .outbound import send_dm, parse_command

    author = message.author
    convo = message.conversation
    text = (message.content or '').strip()
    parsed = parse_command(text)
    state = _get_state(bot, author.id)

    if parsed:
        command, args, _mention = parsed
        _set_state(bot, author.id, None)
        reply = _run_command(bot, author, command, args)
    elif state:
        reply = _continue(bot, author, state, text)
    else:
        reply = HELP

    send_dm(bot.user, convo, reply)


def _run_command(bot, author, command, args):
    if command in ('start', 'help'):
        return HELP
    if command == 'newbot':
        if BotAccount.objects.filter(owner=author, is_active=True).count() >= MAX_BOTS_PER_OWNER:
            return f'Достигнут лимит: {MAX_BOTS_PER_OWNER} активных ботов на аккаунт.'
        if args:
            return _ask_username(bot, author, args)
        _set_state(bot, author.id, {'step': 'name'})
        return 'Как назвать бота? Пришлите отображаемое имя (например: Погода).'
    if command == 'mybots':
        return _list_bots(author)
    if command == 'token':
        return _reissue(author, args) if args else _need_name('/token')
    if command == 'setcommands':
        if not args:
            return _need_name('/setcommands')
        target = _find_bot(author, args)
        if target is None:
            return _not_found(args)
        _set_state(bot, author.id, {'step': 'commands', 'bot_id': str(target.id)})
        return (
            f'Пришлите список команд для @{target.user.username}, по одной в строке '
            'в формате `команда - описание`. Например:\n'
            'start - Запустить бота\nhelp - Справка\n\n'
            'Чтобы убрать все команды, пришлите `-`.'
        )
    if command in ('addbot', 'removebot'):
        if not args:
            return _need_name(f'/{command}')
        target = _find_bot(author, args)
        if target is None:
            return _not_found(args)
        return _ask_server(bot, author, target, adding=(command == 'addbot'))
    if command == 'deletebot':
        if not args:
            return _need_name('/deletebot')
        target = _find_bot(author, args)
        if target is None:
            return _not_found(args)
        _set_state(bot, author.id, {'step': 'confirm_delete', 'bot_id': str(target.id)})
        return (
            f'Удалить @{target.user.username}? Ключ перестанет работать, бот пропадёт '
            'с серверов, но переписки с ним сохранятся.\n'
            f'Для подтверждения пришлите: {target.user.username}'
        )
    return f'Не знаю команду /{command}. Наберите /help.'


def _continue(bot, author, state, text):
    step = state.get('step')
    if step == 'name':
        display_name = text[:64].strip()
        if not display_name:
            return 'Имя не может быть пустым. Пришлите имя ещё раз.'
        _set_state(bot, author.id, {'step': 'username', 'display_name': display_name})
        return (
            'Теперь придумайте юзернейм. Латиница, цифры и «_», 4–28 символов. '
            'Окончание `_bot` добавится автоматически, если его нет.'
        )
    if step == 'username':
        name = normalize_username(text)
        if name is None:
            return (
                'Юзернейм не подходит. Латиница, цифры и «_», 4–28 символов вместе '
                'с окончанием `_bot`. Пришлите другой.'
            )
        if User.objects.filter(username__iexact=name).exists():
            return 'Такой юзернейм уже занят. Пришлите другой.'
        _set_state(bot, author.id, {
            'step': 'tier',
            'display_name': state.get('display_name') or name,
            'username': name,
        })
        return _ask_tier(name)
    if step == 'tier':
        tier = _parse_tier(text)
        if tier is None:
            return (
                'Не понял тип. Пришлите «1» — стандартный, или «2» — продвинутый '
                '(премиум).'
            )
        return _create(bot, author, state.get('display_name'), state.get('username'), tier)
    if step == 'commands':
        target = BotAccount.objects.filter(id=state.get('bot_id'), owner=author).first()
        if target is None:
            return 'Бот не найден.'
        commands = [] if text.strip() == '-' else parse_command_list(text)
        target.commands = commands
        target.save(update_fields=['commands'])
        if not commands:
            return f'Команды @{target.user.username} очищены.'
        listing = '\n'.join(f'/{c["command"]} — {c["description"]}' for c in commands)
        return f'Команды @{target.user.username} обновлены:\n{listing}'
    if step in ('addbot_server', 'removebot_server'):
        target = BotAccount.objects.filter(id=state.get('bot_id'), owner=author).first()
        if target is None:
            return 'Бот не найден.'
        guild = _pick_guild(state.get('guild_ids') or [], text)
        if guild is None:
            return 'Не понял, какой сервер. Пришлите номер из списка или точное название.'
        return (
            _add_to_guild(target, guild) if step == 'addbot_server'
            else _remove_from_guild(target, guild)
        )
    if step == 'confirm_delete':
        target = BotAccount.objects.filter(id=state.get('bot_id'), owner=author).first()
        if target is None:
            return 'Бот не найден.'
        if text.strip().lower() != target.user.username.lower():
            return 'Не совпало — удаление отменено.'
        delete_bot(target)
        return (
            f'@{target.user.username} удалён. Ключ отозван, бот больше не отвечает. '
            'Переписки с ним остались на месте.'
        )
    return HELP


def _ask_username(bot, author, display_name):
    _set_state(bot, author.id, {'step': 'username', 'display_name': display_name[:64]})
    return (
        f'Имя: {display_name[:64]}\nТеперь пришлите юзернейм (латиница, цифры и «_», '
        '4–28 символов). Окончание `_bot` добавится автоматически.'
    )


def normalize_username(raw):
    """'Weather' -> 'weather_bot'. Returns None when it can't be made valid."""
    name = (raw or '').strip().lstrip('@').lower()
    name = re.sub(r'[^a-z0-9_]', '_', name).strip('_')
    if not name:
        return None
    if not name.endswith(BOT_USERNAME_SUFFIX):
        name = f'{name}{BOT_USERNAME_SUFFIX}'
    if not USERNAME_RE.match(name):
        return None
    return name


def parse_command_list(text):
    """Parse the `command - description` block into the stored command list."""
    commands = []
    for line in (text or '').splitlines():
        line = line.strip().lstrip('/')
        if not line:
            continue
        name, _, description = line.partition('-')
        name = re.sub(r'[^a-z0-9_]', '', name.strip().lower())[:32]
        if not name:
            continue
        commands.append({'command': name, 'description': description.strip()[:120]})
        if len(commands) >= 40:
            break
    return commands


def create_bot(owner, display_name, username, api_tier=BotAccount.TIER_STANDARD):
    """Create the bot user + account. Returns (bot, plain_token) or raises ValueError."""
    name = normalize_username(username)
    if name is None:
        raise ValueError('bad username')
    if User.objects.filter(username__iexact=name).exists():
        raise ValueError('username taken')
    if api_tier not in (BotAccount.TIER_STANDARD, BotAccount.TIER_PREMIUM):
        api_tier = BotAccount.TIER_STANDARD
    with transaction.atomic():
        bot_user = User.objects.create(
            username=name,
            nickname=(display_name or name)[:50],
            account_type='bot',
            status='online',
            is_active=False,  # bots authenticate by key, never by password
        )
        bot_user.set_unusable_password()
        bot_user.save(update_fields=['password'])
        account = BotAccount(
            user=bot_user, owner=owner,
            display_name=(display_name or name)[:64],
            api_tier=api_tier,
        )
        token = account.set_token()
        account.save()
    return account, token


def _ask_tier(username):
    return (
        f'Юзернейм: @{username}\n\n'
        'Выберите тип бота — это влияет на пропускную способность его API:\n'
        '**1. Стандартный** — обычный лимит запросов, подходит большинству ботов.\n'
        '**2. Продвинутый** (премиум) — повышенный лимит для больших нагрузок '
        '(платный тариф).\n\n'
        'Пришлите «1» или «2».'
    )


def _parse_tier(text):
    t = (text or '').strip().lower().lstrip('#').strip()
    if t in ('1', 'стандарт', 'стандартный', 'standard', 'обычный', 'обычная', 'basic'):
        return BotAccount.TIER_STANDARD
    if t in ('2', 'премиум', 'premium', 'продвинутый', 'pro', 'про', 'advanced'):
        return BotAccount.TIER_PREMIUM
    return None


def _tier_label(account):
    return 'Продвинутый (премиум)' if account.api_tier == BotAccount.TIER_PREMIUM else 'Стандартный'


def _create(bot, author, display_name, username, api_tier=BotAccount.TIER_STANDARD):
    try:
        account, token = create_bot(author, display_name, username, api_tier)
    except ValueError as exc:
        if str(exc) == 'username taken':
            return 'Такой юзернейм уже занят. Пришлите другой.'
        return (
            'Юзернейм не подходит. Латиница, цифры и «_», 4–28 символов вместе '
            'с окончанием `_bot`. Пришлите другой.'
        )
    _set_state(bot, author.id, None)
    username = account.user.username
    fence = '```'
    return (
        f'# Бот @{username} создан\n'
        f'**{account.display_name}** готов к работе.\n'
        f'Тип API: **{_tier_label(account)}**.\n\n'
        '**Ключ** — нажмите «Копировать» справа сверху:\n'
        f'{fence}\n{token}\n{fence}\n'
        '> Второй раз я его не покажу. Если ключ потерян — `/token '
        f'{username}` выпустит новый, а старый перестанет работать.\n\n'
        '**Что дальше**\n'
        f'- `/setcommands {username}` — команды, которые увидят пользователи\n'
        f'- `/addbot {username}` — добавить бота на свой сервер\n'
        '- Нодовый редактор в «Инструментах от разработчика» — вставьте туда ключ\n'
        '- Библиотеки для C++, Python и Rust читают ключ из `SFERA_BOT_TOKEN`'
    )


def _manageable_guilds(user):
    """Servers where the user may add a bot — their own, as owner or admin.

    Personal channels and the private diary are excluded: they are single-author
    spaces, so a bot there would have nothing to do.
    """
    from sfera_messages.models import Guild, GuildMembership

    guild_ids = GuildMembership.objects.filter(
        user=user, role__in=('owner', 'admin'),
    ).values_list('guild_id', flat=True)
    return list(
        Guild.objects.filter(id__in=list(guild_ids), is_personal_channel=False, is_private=False)
        .order_by('name')
    )


def _ask_server(bot, author, target, adding):
    from sfera_messages.models import Guild, GuildMembership

    guilds = _manageable_guilds(author)
    if adding:
        joined = set(
            GuildMembership.objects.filter(user=target.user).values_list('guild_id', flat=True)
        )
        guilds = [g for g in guilds if g.id not in joined]
        if not guilds:
            return (
                'Нет серверов, куда можно добавить бота. Добавлять можно только на свои '
                'серверы — те, где вы владелец или админ.'
            )
        title = f'На какой сервер добавить **@{target.user.username}**?'
    else:
        guild_ids = GuildMembership.objects.filter(user=target.user).values_list('guild_id', flat=True)
        manageable = {g.id for g in guilds}
        guilds = [g for g in Guild.objects.filter(id__in=list(guild_ids)) if g.id in manageable]
        if not guilds:
            return f'Бот @{target.user.username} не добавлен ни на один ваш сервер.'
        title = f'С какого сервера убрать **@{target.user.username}**?'

    _set_state(bot, author.id, {
        'step': 'addbot_server' if adding else 'removebot_server',
        'bot_id': str(target.id),
        'guild_ids': [str(g.id) for g in guilds],
    })
    listing = '\n'.join(f'{i + 1}. {g.name}' for i, g in enumerate(guilds))
    return f'{title}\n\n{listing}\n\nПришлите номер или название.'


def _pick_guild(guild_ids, text):
    from sfera_messages.models import Guild

    choice = (text or '').strip()
    guilds = list(Guild.objects.filter(id__in=guild_ids))
    # Keep the order the numbers were shown in.
    ordered = [g for gid in guild_ids for g in guilds if str(g.id) == gid]
    if choice.isdigit():
        index = int(choice) - 1
        return ordered[index] if 0 <= index < len(ordered) else None
    for guild in ordered:
        if guild.name.lower() == choice.lower():
            return guild
    return None


def _add_to_guild(target, guild):
    from sfera_messages.models import GuildMembership

    GuildMembership.objects.get_or_create(
        guild=guild, user=target.user, defaults={'role': 'member'},
    )
    return (
        f'@{target.user.username} добавлен на сервер **{guild.name}**.\n\n'
        'В текстовых каналах этого сервера у поля ввода появится кнопка команд бота. '
        'Команды задаются через `/setcommands`.'
    )


def _remove_from_guild(target, guild):
    from sfera_messages.models import GuildMembership

    GuildMembership.objects.filter(guild=guild, user=target.user).delete()
    return f'@{target.user.username} убран с сервера **{guild.name}**. Сообщения бота остались.'


def _list_bots(author):
    bots = BotAccount.objects.filter(owner=author, is_active=True).select_related('user')
    if not bots:
        return 'У вас пока нет ботов. Создайте первого: /newbot'
    lines = []
    for b in bots:
        cmds = ', '.join('`/' + c['command'] + '`' for c in b.commands) or '_команд нет_'
        lines.append(f'- **@{b.user.username}** — {b.display_name} · API: {_tier_label(b)}\n  {cmds}')
    return '# Ваши боты\n' + '\n'.join(lines)


def _reissue(author, args):
    target = _find_bot(author, args)
    if target is None:
        return _not_found(args)
    token = target.set_token()
    target.save(update_fields=['token_hash', 'token_prefix'])
    fence = '```'
    return (
        f'**Новый ключ для @{target.user.username}**\n'
        f'{fence}\n{token}\n{fence}\n'
        '> Старый ключ отозван — обновите его в запущенных копиях бота.'
    )


def delete_bot(account):
    """Revoke the key and retire the bot, keeping every conversation intact."""
    from sfera_messages.models import GuildMembership

    account.is_active = False
    account.revoked_at = timezone.now()
    # Overwrite the digest so the old key can never match again, even if the
    # row is somehow reactivated later.
    account.token_hash = f'revoked:{account.id}'
    account.token_prefix = ''
    account.save(update_fields=['is_active', 'revoked_at', 'token_hash', 'token_prefix'])
    BotUpdate.objects.filter(bot=account).delete()
    BotFlow.objects.filter(bot=account).delete()
    GuildMembership.objects.filter(user=account.user).delete()
    user = account.user
    user.status = 'offline'
    user.is_active = False
    user.save(update_fields=['status', 'is_active'])


def _find_bot(owner, name):
    name = (name or '').strip().lstrip('@').lower()
    qs = BotAccount.objects.select_related('user').filter(owner=owner, is_active=True)
    return (
        qs.filter(user__username__iexact=name).first()
        or qs.filter(user__username__iexact=f'{name}{BOT_USERNAME_SUFFIX}').first()
        or qs.filter(display_name__iexact=name).first()
    )


def _need_name(command):
    return f'Укажите бота: `{command} имя_бота`. Список: /mybots'


def _not_found(name):
    return f'Бот «{name}» не найден среди ваших. Список: /mybots'
