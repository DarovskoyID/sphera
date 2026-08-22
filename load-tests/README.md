# Тестовые нагрузки (load-tests)

Генерация тестовых данных в базе Sfera: аккаунты, серверы, каналы, посты и сообщения.
Под капотом — management-команда Django `seed_load`, которая пишет напрямую через ORM
(`bulk_create`), поэтому быстро наполняет даже высокий профиль.

## Профили

| Профиль  | N аккаунты | M серверы | H каналы | J посты | K сообщ. в серверах | G личные сообщ. | T отправка ЛС |
|----------|-----------:|----------:|---------:|--------:|--------------------:|----------------:|--------------:|
| `light`  |         20 |         3 |       10 |      50 |                 300 |             200 |             0 |
| `medium` |        200 |        20 |      120 |   1 000 |              10 000 |           5 000 |             0 |
| `high`   |      2 000 |       100 |      800 |  20 000 |             200 000 |         100 000 |             0 |

Плюс `I` — активные WebRTC-звонки (в профилях `ACTIVE_CALLS=0`, длительность `CALL_DURATION`).

Числа лежат в файлах `light.env`, `medium.env`, `high.env` — правьте под себя.
`T` (отправка ЛС) и `I` (звонки) по умолчанию `0`, т.к. требуют **запущенного сервера** (см. ниже).

## Запуск

Windows (PowerShell):
```powershell
cd load-tests
.\run.ps1 light
.\run.ps1 medium -Purge          # удалить старые тестовые данные и создать заново
.\run.ps1 high -DmMessages 50000 # переопределить отдельное число
.\run.ps1 custom                 # ввести N M H J K G вручную в консоли
```

Linux / macOS:
```bash
cd load-tests
./run.sh light
./run.sh medium --purge
./run.sh custom
```

## Ввести все числа самому

Через профиль `custom` либо прямым вызовом команды — команда спросит каждое
значение, если флаг не передан:

```bash
python ../django-server/sfera_server/manage.py seed_load
#   N аккаунтов: 100
#   M серверов: 10
#   H каналов: 50
#   J постов в каналах: 500
#   K сообщений в серверах: 5000
#   G личных сообщений: 2000
```

Или всё флагами:
```bash
python ../django-server/sfera_server/manage.py seed_load \
  --accounts 100 --servers 10 --channels 50 \
  --posts 500 --server-messages 5000 --dm-messages 2000
```

## Что создаётся

- **N аккаунтов** — пользователи `loadtest_<hex>_NNNNNN`, пароль `loadtest123`, с `UserSettings`.
- **M серверов** — гильдии `[LT] Server …` со случайным владельцем и 1–8 участниками.
- **H каналов** — текстовые (и каждый 7-й — голосовой) каналы, распределённые по серверам.
- **J постов** — посты в личных каналах (`is_personal_channel`); личные каналы создаются
  автоматически (~1 на 10 аккаунтов).
- **K сообщений в серверах** — `GuildMessage` в текстовых каналах серверов.
- **G личных сообщений** — `Message` в DM-диалогах (по 2 участника, ~1 диалог на 20 сообщений), пишутся прямо в БД.
- **T отправленных ЛС** — в отличие от `G`, **реально отправляются через HTTP API** работающего
  сервера (логин JWT → создание диалога → `messages/send/`). Создают живую нагрузку на
  HTTP/WebSocket/Kafka и видны в статусе и Grafana. Требуют запущенного сервера.
- **I активных звонков** — **настоящие WebRTC-звонки через TURN**: пары тестовых аккаунтов
  подключаются к сигналингу, обмениваются offer/answer, поднимают `RTCPeerConnection` и гонят
  реальный медиапоток (аудио, опц. видео) через coturn в течение `--call-duration`. Поднимают
  метрику `active_dm_calls` и грузят TURN. Требуют запущенного сервера + coturn + пакетов.

## Реальные WebRTC-звонки через TURN (I)

Нужны зависимости (ставятся один раз):
```bash
pip install -r load-tests/requirements-loadtest.txt   # requests + websockets + aiortc(PyAV)
```

Запуск — 10 звонков на 5 минут (нужно ≥ 2·I тестовых аккаунтов):
```bash
python ../django-server/sfera_server/manage.py seed_load \
  --accounts 0 --servers 0 --channels 0 --posts 0 --server-messages 0 --dm-messages 0 \
  --active-calls 10 --call-duration 5m --base-url https://<домен>:8000
```
```powershell
.\run.ps1 medium -ActiveCalls 10 -CallDuration 1h -BaseUrl https://127.0.0.1:8000
.\run.ps1 medium -ActiveCalls 5  -CallDuration 5m -WithVideo   # со «видео»
```

- `--call-duration` — `300` / `300s` / `5m` / `1h` / `1h30m`.
- `--with-video` — добавить видеодорожку (по умолчанию только аудио).
- `--signaling-url` — WS сигналинга (по умолчанию `wss://<host>:<port>/ws/signaling/` из `--base-url`).
  Метрика `active_dm_calls` обновляется только если сигналинг идёт через Django-консьюмер.
- TURN по умолчанию берётся из `src/config/network.ts` (`sferauser` / `sferaturn123`, порт 3478);
  переопределяется `--turn-host/--turn-port/--turn-user/--turn-cred`.
- На время звонков команда **блокируется** (держит звонки `--call-duration`), затем кладёт трубку.

## Реальная отправка ЛС (T) — живая нагрузка

В профилях `SEND_DM=0` (выключено). Включить флагом или правкой `*.env`:

```powershell
.\run.ps1 medium -SendDm 500 -BaseUrl https://127.0.0.1:8000
```
```bash
python ../django-server/sfera_server/manage.py seed_load \
  --accounts 50 --servers 0 --channels 0 --posts 0 --server-messages 0 --dm-messages 0 \
  --send-dm 500 --base-url https://127.0.0.1:8000 --concurrency 16
```

- `--base-url` — адрес сервера (по умолчанию `https://127.0.0.1:8000`).
- TLS-сертификат по умолчанию **не проверяется** (самоподписанный); строгая проверка — `--verify-tls`.
- `--concurrency` — число параллельных отправителей (по умолчанию 8).
- Отправители берутся из уже существующих аккаунтов `loadtest_*` (пароль `loadtest123`),
  поэтому сначала нужен хотя бы один прогон с `--accounts > 1`.

> Режимы **`rate` и `ramp` теперь тоже задевают bot API** (создают временных
> ботов `standard`+`premium` и параллельно бьют по ним, `RATE_BOTS` потоков,
> по умолчанию 4) и каждые 15 с печатают **снимок метрик сервера** в консоль
> (`[метрики] CPU.. RAM.. p95.. online.. voice.. HTTP.. botAPI..`). Так `rate`/`ramp`
> двигают все панели Grafana сразу и показывают ключевые цифры прямо в логе.
> Отдельный режим ниже нужен, когда надо **точечно замерить** пропускную способность
> именно bot API (rps/задержки).

## Нагрузка на bot API (B) — замер пропускной способности тарифов

Отвечает на вопрос «выдержит ли API N запросов». Команда создаёт **временного
бота** нужного тарифа (`premium` = 2000/мин или `standard` = 120/мин), обстреливает
его bot API `B` запросами в `--concurrency` потоков, затем **удаляет** бота и печатает
отчёт: реальный **rps**, задержки (**avg/p50/p95/p99**), сколько запросов вернули
`2xx`, сколько срезал rate-limit (**429**) и сколько было ошибок (`5xx`/обрыв).
Требует **запущенного сервера**.

```powershell
# 10 000 запросов к premium-боту, 64 потока
.\run.ps1 botapi -BotApi 10000 -BotApiTier premium -Concurrency 64 -BaseUrl https://127.0.0.1:8000
# сравнить со стандартным тарифом (быстро упрётся в 120/мин → 429)
.\run.ps1 botapi -BotApi 10000 -BotApiTier standard -Concurrency 64
```
```bash
BOT_API=10000 BOT_API_TIER=premium CONCURRENCY=64 BASE_URL=https://127.0.0.1:8000 ./run.sh botapi
```

Или напрямую через management-команду:
```bash
python ../django-server/sfera_server/manage.py seed_load \
  --accounts 0 --servers 0 --channels 0 --posts 0 --server-messages 0 --dm-messages 0 \
  --bot-api 10000 --bot-api-tier premium --bot-api-endpoint me \
  --concurrency 64 --base-url https://127.0.0.1:8000
```

- `--bot-api N` — сколько запросов сделать (`BOT_API` в env / `-BotApi` в PS).
- `--bot-api-tier standard|premium` — тариф временного бота (по умолчанию `premium`).
- `--bot-api-endpoint me|chats` — что долбить: `me` (лёгкий: auth + сериализация) или
  `chats` (чтение из БД). По умолчанию `me`.
- `--concurrency` — число параллельных потоков (по умолчанию 8; для замера ставьте 32–128).
- `--base-url`, `--verify-tls` — как у `--send-dm`.

**Как читать результат.** `2xx` — сколько сервер реально обслужил (и с какой задержкой);
`429 (лимит)` — сколько срезал троттл тарифа; `5xx/conn err` — реальные отказы сервера.
Если при `premium` вы шлёте >2000 запросов за минуту, часть законно уйдёт в 429 — это
**работа лимита, а не отказ**. Чтобы измерить **чистую ёмкость сервера без лимита**,
поднимите потолок тарифа и гоняйте `premium`:

```bash
SFERA_BOT_THROTTLE_PREMIUM=1000000/min  # в окружении сервера, затем перезапуск
```

Тогда `429` уйдут в ноль, и `rps` + `p95/p99` покажут, где начинает деградировать
именно сервер (Daphne + Postgres), а не ограничитель.

> ⚠️ Узкое место обычно не в этом эндпоинте, а в `get_updates` (long-poll до 45 с):
> там важна не частота, а число **одновременно висящих** соединений. Этот тест меряет
> короткие запросы (`me`/`chats`); для long-poll нужен отдельный сценарий на много ботов.

## Окружение на проде (секреты)

При `SFERA_DEBUG=0` (боевой сервер) Django требует `SFERA_SECRET_KEY`, а `seed_load`
ещё и шифрует сообщения ключом `SFERA_MESSAGE_ENCRYPTION_KEY`. Без них — падение
`ImproperlyConfigured: SFERA_SECRET_KEY must be set`.

`run.sh` **сам подхватывает** эти секреты из `/etc/sfera/secrets.env` (тот же файл,
что systemd подаёт сервису): под `root` — напрямую, иначе через `sudo`. Если файл
лежит в другом месте — укажите `SFERA_SECRETS=/путь/secrets.env`, либо просто
`export SFERA_SECRET_KEY=…` перед запуском. На dev-машине (`SFERA_DEBUG=1`) ничего
из этого не нужно.

## Очистка

Удаляет всё, что начинается с префиксов `loadtest_` (пользователи) и `[LT] ` (серверы и
личные каналы); связанные сообщения/каналы уходят каскадом:

```powershell
.\run.ps1 light -Purge        # только очистка + лёгкий профиль
python ..\django-server\sfera_server\manage.py seed_load --purge   # только очистка
```
