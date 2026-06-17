"""
Генератор тестовой нагрузки для базы данных Ionik.

Создаёт:
  N аккаунтов          (--accounts)
  M серверов (гильдий)  (--servers)
  H каналов             (--channels)            — текстовые каналы, распределяются по серверам
  J постов в каналах    (--posts)               — посты в личных каналах (лента)
  K сообщений в серверах(--server-messages)     — сообщения в текстовых каналах серверов
  G личных сообщений    (--dm-messages)         — сообщения в личных перепиской (DM), пишутся прямо в БД
  T отправленных ЛС     (--send-dm)             — РЕАЛЬНО отправляются через HTTP API работающего
                                                  сервера (логин → создание диалога → send), создают
                                                  живую нагрузку на HTTP/WS/Kafka, видны в Grafana
  I активных звонков    (--active-calls)        — РЕАЛЬНЫЕ WebRTC-звонки через TURN (медиапоток между
                                                  пирами) на время --call-duration (5m / 1h / 300s);
                                                  поднимают метрику active_dm_calls и грузят TURN

Звонкам нужны пакеты aiortc и websockets:  pip install -r load-tests/requirements-loadtest.txt

Числа можно передать флагами или ввести интерактивно (если флаг не задан).

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

# AppOnlyMiddleware блокирует HTTP-запросы без этого заголовка.
CLIENT_HEADER = {'X-Ionik-Client': '1'}

# TURN/STUN по умолчанию — совпадают с src/config/network.ts
DEFAULT_TURN_PORT = 3478
DEFAULT_TURN_USER = 'ionikuser'
DEFAULT_TURN_CRED = 'ionikturn123'


def _parse_duration(s):
    """'300' / '300s' / '5m' / '1h' / '1h30m' -> секунды (int)."""
    s = str(s).strip().lower()
    if not s:
        return 0
    if s.isdigit():
        return int(s)
    import re
    total = 0
    for num, unit in re.findall(r'(\d+)\s*([hms])', s):
        total += int(num) * {'h': 3600, 'm': 60, 's': 1}[unit]
    return total

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
        parser.add_argument('--dm-messages', type=int, default=None, help='G — личных сообщений в БД (всего)')
        parser.add_argument('--send-dm', type=int, default=None,
                            help='T — РЕАЛЬНО отправить столько ЛС через HTTP API сервера')
        parser.add_argument('--base-url', default='https://127.0.0.1:8000',
                            help='базовый URL сервера для --send-dm (по умолчанию https://127.0.0.1:8000)')
        parser.add_argument('--verify-tls', action='store_true',
                            help='проверять TLS-сертификат при --send-dm (по умолчанию выключено)')
        parser.add_argument('--concurrency', type=int, default=8,
                            help='число параллельных отправителей для --send-dm')
        # ── Активные WebRTC-звонки через TURN ──
        parser.add_argument('--active-calls', type=int, default=None,
                            help='I — сколько одновременных РЕАЛЬНЫХ WebRTC-звонков через TURN держать')
        parser.add_argument('--call-duration', default=None,
                            help='сколько держать звонки: 300 / 300s / 5m / 1h / 1h30m')
        parser.add_argument('--signaling-url', default=None,
                            help='WS сигналинга (по умолчанию выводится из --base-url: wss://host:port/ws/signaling/)')
        parser.add_argument('--with-video', action='store_true',
                            help='добавить видеодорожку в звонки (по умолчанию только аудио)')
        parser.add_argument('--turn-host', default=None, help='TURN/STUN хост (по умолчанию хост из --base-url)')
        parser.add_argument('--turn-port', type=int, default=DEFAULT_TURN_PORT, help=f'TURN порт ({DEFAULT_TURN_PORT})')
        parser.add_argument('--turn-user', default=DEFAULT_TURN_USER, help='TURN username')
        parser.add_argument('--turn-cred', default=DEFAULT_TURN_CRED, help='TURN credential')
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
        G = self._ask('G личных сообщений (в БД)', opts['dm_messages'])
        T = self._ask('T отправленных ЛС (через сервер)', opts['send_dm'])
        I = self._ask('I активных WebRTC-звонков (через TURN)', opts['active_calls'])
        call_duration = 0
        if I > 0:
            raw_dur = opts['call_duration']
            if raw_dur is None:
                raw_dur = input('  Длительность звонков (напр. 5m, 1h, 300s): ').strip()
            call_duration = _parse_duration(raw_dur)
        batch = opts['batch']

        # N=0 допустимо, если используем уже существующие аккаунты для T/I.
        if N == 0 and not (T or I):
            self.stdout.write(self.style.ERROR('Нечего делать: задайте N > 0 либо T/I (с уже созданными аккаунтами).'))
            return

        t0 = time.time()
        users = self._make_users(N, batch) if N else []
        servers = self._make_servers(M, users) if (M and users) else []
        channels = self._make_channels(H, servers, users)
        self._make_server_messages(K, channels, servers, users, batch)
        personal_channels = self._make_personal_channels(users) if users else []
        self._make_posts(J, personal_channels, users, batch)
        self._make_dms(G, users, batch)
        self._send_dms(T, opts['base_url'], opts['verify_tls'], opts['concurrency'])
        self._run_calls(I, call_duration, opts)

        dt = time.time() - t0
        self.stdout.write(self.style.SUCCESS(
            f'\nГотово за {dt:.1f}с. Логин для созданных аккаунтов: пароль "{DEFAULT_PASSWORD}".'
        ))

    # ── users ────────────────────────────────────────────────────────────────

    def _make_users(self, N, batch):
        from django.contrib.auth.hashers import make_password
        from ionik_auth.models import User, UserSettings

        self.stdout.write(f'1/8  Создаю {N} аккаунтов...')
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

        self.stdout.write(f'2/8  Создаю {M} серверов...')
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
            self.stdout.write('3/8  Серверов нет — каналы пропущены.')
            return []
        self.stdout.write(f'3/8  Создаю {H} каналов...')
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
            self.stdout.write('4/8  Сообщений в серверах нет — пропуск.')
            return
        self.stdout.write(f'4/8  Создаю {K} сообщений в серверах...')
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
            self.stdout.write('5/8  Постов в каналах нет — пропуск.')
            return
        self.stdout.write(f'5/8  Создаю {J} постов в {len(personal_channels)} личных каналах...')
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
            self.stdout.write('6/8  Личных сообщений нет — пропуск.')
            return
        self.stdout.write(f'6/8  Создаю {G} личных сообщений...')
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

    # ── Реальная отправка ЛС через HTTP API (живая нагрузка) ──────────────────

    def _send_dms(self, T, base_url, verify_tls, concurrency):
        if T == 0:
            self.stdout.write('7/8  Отправка ЛС через сервер не запрошена — пропуск.')
            return

        try:
            import requests
        except ImportError:
            self.stdout.write(self.style.ERROR('7/8  Нужен пакет requests (pip install requests).'))
            return
        try:
            from urllib3.exceptions import InsecureRequestWarning
            requests.packages.urllib3.disable_warnings(InsecureRequestWarning)
        except Exception:
            pass

        from concurrent.futures import ThreadPoolExecutor
        from ionik_auth.models import User

        base = base_url.rstrip('/')
        verify = bool(verify_tls)
        self.stdout.write(f'7/8  Отправляю {T} ЛС через {base} (потоков: {concurrency})...')

        # Берём готовый пул тестовых аккаунтов (пароль известен — DEFAULT_PASSWORD)
        pool = list(User.objects.filter(username__startswith=USER_PREFIX)
                    .values_list('username', 'id')[:max(2, concurrency * 4)])
        if len(pool) < 2:
            self.stdout.write(self.style.ERROR(
                '     Недостаточно тестовых аккаунтов. Сначала создайте их (--accounts > 1).'))
            return

        # 1) Логинимся, получаем JWT для каждого аккаунта пула
        tokens = {}  # username -> (token, user_id)
        for username, uid in pool:
            try:
                r = requests.post(f'{base}/api/auth/login/',
                                  json={'username': username, 'password': DEFAULT_PASSWORD},
                                  headers=CLIENT_HEADER, verify=verify, timeout=15)
                if r.status_code == 200:
                    tokens[username] = (r.json()['access'], str(uid))
            except requests.RequestException as e:
                self.stdout.write(self.style.ERROR(f'     Сервер недоступен: {e}'))
                return
        if len(tokens) < 2:
            self.stdout.write(self.style.ERROR(
                f'     Не удалось залогиниться (получено {len(tokens)} токенов). '
                f'Проверьте --base-url и что сервер запущен.'))
            return

        senders = list(tokens.items())  # [(username, (token, uid)), ...]

        # 2) Заводим пул диалогов между парами через API (создаются по-настоящему)
        n_conv = max(1, min(len(senders), T))
        convos = []  # [(conv_id, sender_token), ...]
        for i in range(n_conv):
            (_, (tok_a, _)), (_, (_, uid_b)) = senders[i % len(senders)], senders[(i + 1) % len(senders)]
            try:
                r = requests.post(f'{base}/api/conversations/create/',
                                  json={'user_id': uid_b},
                                  headers={**CLIENT_HEADER, 'Authorization': f'Bearer {tok_a}'},
                                  verify=verify, timeout=15)
                if r.status_code in (200, 201):
                    convos.append((r.json()['id'], tok_a))
            except requests.RequestException:
                pass
        if not convos:
            self.stdout.write(self.style.ERROR('     Не удалось создать ни одного диалога через API.'))
            return

        # 3) Шлём T сообщений, раскидывая по диалогам, параллельно
        ok = [0]
        fail = [0]

        def _send(i):
            conv_id, tok = convos[i % len(convos)]
            try:
                r = requests.post(f'{base}/api/conversations/{conv_id}/messages/send/',
                                  json={'content': _sentence()},
                                  headers={**CLIENT_HEADER, 'Authorization': f'Bearer {tok}'},
                                  verify=verify, timeout=15)
                if r.status_code in (200, 201):
                    ok[0] += 1
                else:
                    fail[0] += 1
            except requests.RequestException:
                fail[0] += 1

        with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool_exec:
            list(pool_exec.map(_send, range(T)))

        style = self.style.SUCCESS if fail[0] == 0 else self.style.WARNING
        self.stdout.write(style(
            f'     Отправлено: {ok[0]}, ошибок: {fail[0]} (диалогов: {len(convos)})'))

    # ── Активные WebRTC-звонки через TURN (живая медианагрузка) ───────────────

    def _run_calls(self, I, duration, opts):
        if not I:
            self.stdout.write('8/8  Активные звонки не запрошены — пропуск.')
            return

        try:
            import asyncio, ssl, json as _json, fractions
            import requests
            import websockets
            from aiortc import (RTCPeerConnection, RTCConfiguration,
                                RTCIceServer, RTCSessionDescription)
            from aiortc.mediastreams import MediaStreamTrack
            import av
        except ImportError as e:
            self.stdout.write(self.style.ERROR(
                '8/8  Нужны пакеты aiortc и websockets. Установите:\n'
                '       pip install -r load-tests/requirements-loadtest.txt\n'
                f'     ({e})'))
            return

        try:
            from urllib3.exceptions import InsecureRequestWarning
            requests.packages.urllib3.disable_warnings(InsecureRequestWarning)
        except Exception:
            pass

        from urllib.parse import urlparse
        from ionik_auth.models import User

        base = opts['base_url'].rstrip('/')
        verify = bool(opts['verify_tls'])
        with_video = bool(opts['with_video'])
        parsed = urlparse(base)
        host = parsed.hostname or '127.0.0.1'
        turn_host = opts['turn_host'] or host
        turn_port = opts['turn_port']
        turn_user, turn_cred = opts['turn_user'], opts['turn_cred']

        # Сигналинг: по умолчанию тот же хост/порт, что и API (Daphne), путь /ws/signaling/
        sig_url = opts['signaling_url']
        if not sig_url:
            scheme = 'wss' if parsed.scheme == 'https' else 'ws'
            port = f':{parsed.port}' if parsed.port else ''
            sig_url = f'{scheme}://{host}{port}/ws/signaling/'

        media = 'аудио+видео' if with_video else 'аудио'
        self.stdout.write(
            f'8/8  Поднимаю {I} WebRTC-звонков ({media}) через TURN {turn_host}:{turn_port}, '
            f'длительность {duration}с...')
        self.stdout.write(f'     сигналинг: {sig_url}')

        # Нужно 2*I аккаунтов; логинимся через HTTP, получаем JWT (для ?token= в WS)
        need = 2 * I
        pool = list(User.objects.filter(username__startswith=USER_PREFIX)
                    .values_list('username', 'id')[:need])
        if len(pool) < need:
            self.stdout.write(self.style.ERROR(
                f'     Нужно {need} тестовых аккаунтов, есть {len(pool)}. Создайте больше (--accounts).'))
            return

        creds = []  # (token, user_id)
        for username, uid in pool:
            try:
                r = requests.post(f'{base}/api/auth/login/',
                                  json={'username': username, 'password': DEFAULT_PASSWORD},
                                  headers=CLIENT_HEADER, verify=verify, timeout=15)
                if r.status_code == 200:
                    creds.append((r.json()['access'], str(uid)))
            except requests.RequestException as e:
                self.stdout.write(self.style.ERROR(f'     Сервер недоступен: {e}'))
                return
        if len(creds) < need:
            self.stdout.write(self.style.ERROR(
                f'     Залогинились только {len(creds)}/{need}. Проверьте --base-url.'))
            return

        ice_config = RTCConfiguration(iceServers=[
            RTCIceServer(urls=f'stun:{turn_host}:{turn_port}'),
            RTCIceServer(
                urls=[f'turn:{turn_host}:{turn_port}?transport=udp',
                      f'turn:{turn_host}:{turn_port}?transport=tcp'],
                username=turn_user, credential=turn_cred),
        ])

        ssl_ctx = None
        if sig_url.startswith('wss'):
            ssl_ctx = ssl.create_default_context()
            if not verify:
                ssl_ctx.check_hostname = False
                ssl_ctx.verify_mode = ssl.CERT_NONE

        # ── Медиадорожки: тишина (аудио) и чёрный кадр (видео) ──
        class _SilenceAudio(MediaStreamTrack):
            kind = 'audio'

            def __init__(self):
                super().__init__()
                self._sr, self._samples, self._pts, self._next = 48000, 960, 0, None

            async def recv(self):
                import time as _t
                self._next = (self._next or _t.time()) + self._samples / self._sr
                d = self._next - _t.time()
                if d > 0:
                    await asyncio.sleep(d)
                f = av.AudioFrame(format='s16', layout='mono', samples=self._samples)
                for p in f.planes:
                    p.update(bytes(self._samples * 2))
                f.pts, f.sample_rate = self._pts, self._sr
                f.time_base = fractions.Fraction(1, self._sr)
                self._pts += self._samples
                return f

        class _BlackVideo(MediaStreamTrack):
            kind = 'video'

            def __init__(self):
                super().__init__()
                self._pts, self._next = 0, None

            async def recv(self):
                import time as _t
                self._next = (self._next or _t.time()) + 1 / 15
                d = self._next - _t.time()
                if d > 0:
                    await asyncio.sleep(d)
                f = av.VideoFrame(width=320, height=240, format='yuv420p')
                for p in f.planes:
                    p.update(bytes(p.buffer_size))
                f.pts = self._pts
                f.time_base = fractions.Fraction(1, 15)
                self._pts += 1
                return f

        stats = {'up': 0, 'fail': 0}

        async def _drain(ws):
            try:
                async for _ in ws:
                    pass
            except Exception:
                pass

        async def one_call(idx, a, b, deadline):
            (a_tok, a_id), (b_tok, b_id) = a, b
            pc_a, pc_b = RTCPeerConnection(ice_config), RTCPeerConnection(ice_config)
            ws_a = ws_b = None
            try:
                pc_a.addTrack(_SilenceAudio())
                pc_b.addTrack(_SilenceAudio())
                if with_video:
                    pc_a.addTrack(_BlackVideo())
                    pc_b.addTrack(_BlackVideo())

                ws_a = await websockets.connect(f'{sig_url}?token={a_tok}', ssl=ssl_ctx, max_size=None)
                ws_b = await websockets.connect(f'{sig_url}?token={b_tok}', ssl=ssl_ctx, max_size=None)

                # A → offer (setLocalDescription соберёт ICE, включая relay-кандидаты TURN)
                await pc_a.setLocalDescription(await pc_a.createOffer())
                await ws_a.send(_json.dumps({
                    'type': 'offer', 'to': b_id, 'withVideo': with_video,
                    'sdp': {'type': pc_a.localDescription.type, 'sdp': pc_a.localDescription.sdp},
                }))

                # B ждёт offer
                offer = await _wait_for(ws_b, 'offer', 30)
                await pc_b.setRemoteDescription(RTCSessionDescription(
                    sdp=offer['sdp']['sdp'], type=offer['sdp']['type']))
                await pc_b.setLocalDescription(await pc_b.createAnswer())
                await ws_b.send(_json.dumps({
                    'type': 'answer', 'to': a_id,
                    'sdp': {'type': pc_b.localDescription.type, 'sdp': pc_b.localDescription.sdp},
                }))

                # A ждёт answer
                answer = await _wait_for(ws_a, 'answer', 30)
                await pc_a.setRemoteDescription(RTCSessionDescription(
                    sdp=answer['sdp']['sdp'], type=answer['sdp']['type']))

                stats['up'] += 1
                # Держим звонок: дренируем WS, медиадорожки сами шлют RTP через TURN
                drain_a = asyncio.ensure_future(_drain(ws_a))
                drain_b = asyncio.ensure_future(_drain(ws_b))
                try:
                    await asyncio.sleep(max(0, deadline - time.time()))
                finally:
                    drain_a.cancel()
                    drain_b.cancel()

                # Корректно завершаем звонок
                try:
                    await ws_a.send(_json.dumps({'type': 'call-end', 'to': b_id}))
                except Exception:
                    pass
            except Exception:
                stats['fail'] += 1
            finally:
                for obj in (pc_a, pc_b):
                    try:
                        await obj.close()
                    except Exception:
                        pass
                for w in (ws_a, ws_b):
                    if w is not None:
                        try:
                            await w.close()
                        except Exception:
                            pass

        async def _wait_for(ws, want, timeout):
            end = time.time() + timeout
            while time.time() < end:
                raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, end - time.time()))
                msg = _json.loads(raw)
                if msg.get('type') == want:
                    return msg
            raise TimeoutError(f'не дождался {want}')

        async def run_all():
            deadline = time.time() + duration
            pairs = [(creds[2 * i], creds[2 * i + 1]) for i in range(I)]
            tasks = [asyncio.ensure_future(one_call(i, a, b, deadline))
                     for i, (a, b) in enumerate(pairs)]
            # Периодический прогресс
            while not all(t.done() for t in tasks):
                await asyncio.sleep(min(15, max(1, duration)))
                left = int(deadline - time.time())
                self.stdout.write(f'     активных звонков: {stats["up"] - stats["fail"]}, '
                                  f'осталось ~{max(0, left)}с')
                if time.time() >= deadline:
                    break
            await asyncio.gather(*tasks, return_exceptions=True)

        try:
            asyncio.run(run_all())
        except KeyboardInterrupt:
            self.stdout.write(self.style.WARNING('     Прервано пользователем — завершаю звонки.'))

        style = self.style.SUCCESS if stats['fail'] == 0 else self.style.WARNING
        self.stdout.write(style(
            f'     Звонков поднято: {stats["up"]}, не удалось: {stats["fail"]} (держали {duration}с)'))
