"""
Генератор тестовой нагрузки для базы данных Ionik.

Создаёт:
  N аккаунтов          (--accounts)
  M серверов (гильдий)  (--servers)
  H каналов             (--channels)            — текстовые каналы, распределяются по серверам
  J постов в каналах    (--posts)               — посты в личных каналах (лента)
  K сообщений в серверах(--server-messages)     — сообщения в текстовых каналах серверов
  G личных сообщений    (--dm-messages)         — сообщения в личных перепиской (DM)

Все шесть чисел можно передать флагами или ввести интерактивно (если флаг не задан).

Примеры:
  python manage.py seed_load --accounts 100 --servers 10 --channels 50 \
      --posts 500 --server-messages 5000 --dm-messages 2000

  python manage.py seed_load            # спросит каждое число в консоли

Очистка ранее созданных тестовых данных (всё с префиксом loadtest_):
  python manage.py seed_load --purge
"""
import random
import time
import uuid

from django.core.management.base import BaseCommand
from django.db import transaction

from ionik_messages.encryption import encrypt_text

USER_PREFIX = 'loadtest_'
GUILD_PREFIX = '[LT] '
DEFAULT_PASSWORD = 'loadtest123'

_WORDS = (
    'привет всем как дела сегодня отличный день погода хорошая работа кипит '
    'релиз скоро тесты зелёные деплой прошёл успешно команда молодцы спринт '
    'идея фича баг фикс ревью мерж пуш коммит ветка main статус сервер канал'
).split()


def _sentence():
    n = random.randint(3, 14)
    return ' '.join(random.choice(_WORDS) for _ in range(n)).capitalize()


class Command(BaseCommand):
    help = 'Создаёт тестовую нагрузку: аккаунты, серверы, каналы, посты и сообщения'

    def add_arguments(self, parser):
        parser.add_argument('--accounts', type=int, default=None, help='N — число аккаунтов')
        parser.add_argument('--servers', type=int, default=None, help='M — число серверов')
        parser.add_argument('--channels', type=int, default=None, help='H — число каналов (всего)')
        parser.add_argument('--posts', type=int, default=None, help='J — число постов в личных каналах (всего)')
        parser.add_argument('--server-messages', type=int, default=None, help='K — сообщений в серверах (всего)')
        parser.add_argument('--dm-messages', type=int, default=None, help='G — личных сообщений (всего)')
        parser.add_argument('--batch', type=int, default=2000, help='размер пачки для bulk_create')
        parser.add_argument('--purge', action='store_true', help='удалить ранее созданные тестовые данные и выйти')

    # ── helpers ──────────────────────────────────────────────────────────────

    def _ask(self, label, value):
        if value is not None:
            return max(0, value)
        while True:
            raw = input(f'  {label}: ').strip()
            try:
                return max(0, int(raw))
            except ValueError:
                self.stdout.write(self.style.ERROR('  Введите целое число.'))

    # ── purge ────────────────────────────────────────────────────────────────

    def _purge(self):
        from ionik_auth.models import User
        from ionik_messages.models import Guild

        self.stdout.write('Удаление тестовых данных...')
        g = Guild.objects.filter(name__startswith=GUILD_PREFIX).delete()
        u = User.objects.filter(username__startswith=USER_PREFIX).delete()
        self.stdout.write(self.style.SUCCESS(f'  Удалено серверов/связей: {g[0]}, пользователей/связей: {u[0]}'))

    # ── main ─────────────────────────────────────────────────────────────────

    def handle(self, *args, **opts):
        if opts['purge']:
            self._purge()
            return

        self.stdout.write(self.style.MIGRATE_HEADING('Параметры нагрузки (Enter после флага не нужен):'))
        N = self._ask('N аккаунтов', opts['accounts'])
        M = self._ask('M серверов', opts['servers'])
        H = self._ask('H каналов', opts['channels'])
        J = self._ask('J постов в каналах', opts['posts'])
        K = self._ask('K сообщений в серверах', opts['server_messages'])
        G = self._ask('G личных сообщений', opts['dm_messages'])
        batch = opts['batch']

        if N == 0:
            self.stdout.write(self.style.ERROR('Нужен хотя бы 1 аккаунт (N > 0).'))
            return

        t0 = time.time()
        users = self._make_users(N, batch)
        servers = self._make_servers(M, users)
        channels = self._make_channels(H, servers, users)
        self._make_server_messages(K, channels, servers, users, batch)
        personal_channels = self._make_personal_channels(users)
        self._make_posts(J, personal_channels, users, batch)
        self._make_dms(G, users, batch)

        dt = time.time() - t0
        self.stdout.write(self.style.SUCCESS(
            f'\nГотово за {dt:.1f}с. Логин для созданных аккаунтов: пароль "{DEFAULT_PASSWORD}".'
        ))

    # ── users ────────────────────────────────────────────────────────────────

    def _make_users(self, N, batch):
        from django.contrib.auth.hashers import make_password
        from ionik_auth.models import User, UserSettings

        self.stdout.write(f'1/6  Создаю {N} аккаунтов...')
        pwd = make_password(DEFAULT_PASSWORD)
        suffix = uuid.uuid4().hex[:6]
        users = [
            User(username=f'{USER_PREFIX}{suffix}_{i:06d}',
                 nickname=f'Load #{i}', password=pwd, status='offline')
            for i in range(N)
        ]
        User.objects.bulk_create(users, batch_size=batch)
        UserSettings.objects.bulk_create(
            [UserSettings(user=u) for u in users], batch_size=batch
        )
        self.stdout.write(self.style.SUCCESS(f'     +{len(users)} пользователей'))
        return users

    # ── servers ──────────────────────────────────────────────────────────────

    def _make_servers(self, M, users):
        from ionik_messages.models import Guild, GuildMembership

        self.stdout.write(f'2/6  Создаю {M} серверов...')
        servers = []
        memberships = []
        for i in range(M):
            owner = random.choice(users)
            g = Guild(name=f'{GUILD_PREFIX}Server {i:05d}', owner=owner,
                      is_personal_channel=False, is_discoverable=True)
            g.save()  # invite_code генерируется в save()
            servers.append(g)
            memberships.append(GuildMembership(guild=g, user=owner, role='owner'))
            # подмешиваем случайных участников
            for member in random.sample(users, min(len(users), random.randint(1, 8))):
                if member != owner:
                    memberships.append(GuildMembership(guild=g, user=member, role='member'))
        GuildMembership.objects.bulk_create(memberships, batch_size=2000, ignore_conflicts=True)
        self.stdout.write(self.style.SUCCESS(f'     +{len(servers)} серверов, {len(memberships)} участников'))
        return servers

    # ── channels ─────────────────────────────────────────────────────────────

    def _make_channels(self, H, servers, users):
        from ionik_messages.models import GuildChannel

        if not servers:
            self.stdout.write('3/6  Серверов нет — каналы пропущены.')
            return []
        self.stdout.write(f'3/6  Создаю {H} каналов...')
        channels = []
        for i in range(H):
            guild = servers[i % len(servers)]
            channels.append(GuildChannel(
                guild=guild,
                name=f'channel-{i:05d}',
                channel_type='voice' if i % 7 == 0 else 'text',
                position=i,
            ))
        GuildChannel.objects.bulk_create(channels, batch_size=2000)
        self.stdout.write(self.style.SUCCESS(f'     +{len(channels)} каналов'))
        return channels

    # ── server messages ──────────────────────────────────────────────────────

    def _make_server_messages(self, K, channels, servers, users, batch):
        from ionik_messages.models import GuildMessage

        text_channels = [c for c in channels if c.channel_type == 'text']
        if K == 0 or not text_channels:
            self.stdout.write('4/6  Сообщений в серверах нет — пропуск.')
            return
        self.stdout.write(f'4/6  Создаю {K} сообщений в серверах...')
        # участники сервера = автор берётся из членов гильдии канала
        members_by_guild = self._members_by_guild(servers, users)
        buf = []
        created = 0
        for i in range(K):
            ch = random.choice(text_channels)
            authors = members_by_guild.get(ch.guild_id) or users
            buf.append(GuildMessage(
                channel=ch, author=random.choice(authors),
                encrypted_content=encrypt_text(_sentence()),
            ))
            if len(buf) >= batch:
                GuildMessage.objects.bulk_create(buf, batch_size=batch)
                created += len(buf); buf = []
        if buf:
            GuildMessage.objects.bulk_create(buf, batch_size=batch); created += len(buf)
        self.stdout.write(self.style.SUCCESS(f'     +{created} сообщений в серверах'))

    def _members_by_guild(self, servers, users):
        from ionik_messages.models import GuildMembership
        by_id = {u.id: u for u in users}
        out = {}
        ids = [g.id for g in servers]
        for guild_id, user_id in GuildMembership.objects.filter(
            guild_id__in=ids
        ).values_list('guild_id', 'user_id'):
            user = by_id.get(user_id)
            if user is not None:
                out.setdefault(guild_id, []).append(user)
        return out

    # ── personal channels + posts ────────────────────────────────────────────

    def _make_personal_channels(self, users):
        """Личный канал = Guild(is_personal_channel=True) с одним текстовым каналом-лентой."""
        from ionik_messages.models import Guild, GuildChannel, GuildMembership

        n = max(1, min(len(users), max(1, len(users) // 10)))
        owners = random.sample(users, n)
        pcs = []
        for owner in owners:
            g = Guild(name=f'{GUILD_PREFIX}Channel {owner.nickname}', owner=owner,
                      is_personal_channel=True, comments_enabled=True)
            g.save()
            ch = GuildChannel.objects.create(guild=g, name='posts', channel_type='text')
            GuildMembership.objects.create(guild=g, user=owner, role='owner')
            pcs.append((g, ch, owner))
        return pcs

    def _make_posts(self, J, personal_channels, users, batch):
        from ionik_messages.models import GuildMessage

        if J == 0 or not personal_channels:
            self.stdout.write('5/6  Постов в каналах нет — пропуск.')
            return
        self.stdout.write(f'5/6  Создаю {J} постов в {len(personal_channels)} личных каналах...')
        buf = []
        created = 0
        for i in range(J):
            _, ch, owner = personal_channels[i % len(personal_channels)]
            buf.append(GuildMessage(
                channel=ch, author=owner,
                encrypted_content=encrypt_text(_sentence()),
            ))
            if len(buf) >= batch:
                GuildMessage.objects.bulk_create(buf, batch_size=batch)
                created += len(buf); buf = []
        if buf:
            GuildMessage.objects.bulk_create(buf, batch_size=batch); created += len(buf)
        self.stdout.write(self.style.SUCCESS(f'     +{created} постов'))

    # ── DM messages ──────────────────────────────────────────────────────────

    def _make_dms(self, G, users, batch):
        from ionik_messages.models import Conversation, ConversationParticipant, Message

        if G == 0 or len(users) < 2:
            self.stdout.write('6/6  Личных сообщений нет — пропуск.')
            return
        self.stdout.write(f'6/6  Создаю {G} личных сообщений...')
        # создаём пул диалогов (≈ 1 диалог на 20 сообщений, но не больше N*4)
        n_conv = max(1, min(G // 20 + 1, len(users) * 4))
        convs = []
        for _ in range(n_conv):
            a, b = random.sample(users, 2)
            c = Conversation.objects.create()
            ConversationParticipant.objects.bulk_create([
                ConversationParticipant(conversation=c, user=a),
                ConversationParticipant(conversation=c, user=b),
            ])
            convs.append((c, [a, b]))

        buf = []
        created = 0
        for i in range(G):
            conv, pair = random.choice(convs)
            buf.append(Message(
                conversation=conv, author=random.choice(pair),
                encrypted_content=encrypt_text(_sentence()),
            ))
            if len(buf) >= batch:
                Message.objects.bulk_create(buf, batch_size=batch)
                created += len(buf); buf = []
        if buf:
            Message.objects.bulk_create(buf, batch_size=batch); created += len(buf)
        self.stdout.write(self.style.SUCCESS(f'     +{created} личных сообщений в {len(convs)} диалогах'))
