<p align="center">
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=white" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/Vite-7-646CFF?style=for-the-badge&logo=vite&logoColor=white" />
  <img src="https://img.shields.io/badge/Django-5.2-092E20?style=for-the-badge&logo=django&logoColor=white" />
  <img src="https://img.shields.io/badge/Rust-ws--gateway-000000?style=for-the-badge&logo=rust&logoColor=white" />
  <img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" />
  <img src="https://img.shields.io/badge/Kafka-7.6-231F20?style=for-the-badge&logo=apachekafka&logoColor=white" />
</p>

# Сфера

Мессенджер: личные переписки, серверы с каналами и ролями, голос и видео через
WebRTC, личный дневник, боты. Ставится на свой хост целиком — от базы до TURN.

Этот README описывает **всё**: запуск с нуля на пустой машине, каждый скрипт,
каждую переменную окружения, каждый порт, деплой, масштабирование на несколько
серверов и нагрузочное тестирование со всеми параметрами.

---

## Оглавление

- [Что внутри](#что-внутри)
- [Архитектура](#архитектура)
- [Порты](#порты)
- [Быстрый старт: только фронтенд](#быстрый-старт-только-фронтенд)
- [Запуск с нуля: полный стек](#запуск-с-нуля-полный-стек)
  - [Установка зависимостей](#1-установка-зависимостей)
  - [Windows](#2-запуск--windows)
  - [macOS](#3-запуск--macos)
  - [Linux / прод](#4-запуск--linux--прод)
- [Скрипты: полный справочник](#скрипты-полный-справочник)
- [Переменные окружения](#переменные-окружения)
- [Секреты](#секреты)
- [Почта](#почта)
- [Docker-сервисы](#docker-сервисы)
- [Нагрузочное тестирование](#нагрузочное-тестирование)
- [Мониторинг и статус](#мониторинг-и-статус)
- [Горизонтальное масштабирование](#горизонтальное-масштабирование)
- [Обслуживание](#обслуживание)
- [Остановка и удаление](#остановка-и-удаление)
- [CI/CD](#cicd)
- [Боты](#боты)
- [Структура проекта](#структура-проекта)
- [Разработка](#разработка)

---

## Что внутри

Сфера модульная: в `main` — **ядро** (личные сообщения и звонки), всё остальное —
**модули** в отдельных ветках, которые пользователь сам ставит и удаляет в
«Исследовать сферу». Подробно — [docs/MODULES.md](docs/MODULES.md).

| Область | Где | Подробности |
|---------|-----|-------------|
| **Личные сообщения** | ядро | Диалоги, вложения (шифруются на диске), ответы, редактирование, отложенная отправка, эмодзи/стикеры/GIF |
| **Звонки** | ядро | 1-на-1, WebRTC через свой STUN/TURN (coturn) |
| **Серверы** | модуль `module/servers` | Текстовые и голосовые каналы, роли и права, упоминания, закрепления, модерация, поиск серверов |
| **Каналы** | модуль `module/channels` | Персональные ленты постов, подписки, комментарии, поиск каналов и постов |
| **Личные дневники** | модуль `module/diary` | Записи, видимые только автору: задачи, геометки, файлы |
| **Семейный центр** | модуль `module/family` | Детские аккаунты, одобрение друзей родителем, фильтр контента, геолокация семьи |
| **Боты** | модуль `module/bots` | Аккаунты типа `bot`, Сфероник, визуальный редактор сценариев, Bot API и SDK на Python / C++ / Rust (документация — в ветке модуля) |
| **Поиск** | Полнотекстовый поиск по сообщениям через Elasticsearch |
| **Языки** | Английский, русский, немецкий, французский, испанский, португальский, китайский |
| **Клиенты** | Веб (адаптив под телефон), Android-обёртка вокруг WebView — [docs/ANDROID_WEBVIEW.md](docs/ANDROID_WEBVIEW.md) |

**Стек.** Фронтенд — React 18 + TypeScript на Vite 7, без UI-фреймворка: стили
собственные, в `src/styles/` + слой `src/minimal.css`. Бэкенд — Django 5.2 с
Channels под Daphne (ASGI). Реалтайм чата и каналов — отдельный шлюз на Rust
(`ws-gateway`). Хранилище — PostgreSQL 16, поиск — Elasticsearch 8, очередь —
Kafka, presence и фан-аут между нодами — Redis. Метрики — Prometheus + Grafana.

---

## Архитектура

```
                    браузер / Android WebView
                        │              │
              https :443│              │wss :8001
                        ▼              ▼
                ┌──────────────────────────────┐
                │      nginx (хост, TLS)       │
                └───┬────────────┬─────────────┘
       статика /    │            │  /ws/…
       /api/ →      │            ▼
                    │   ┌────────────────────┐
                    │   │  loadbalancer      │  127.0.0.1:8081
                    │   │  (nginx, ip_hash)  │  список нод: loadbalancer/servers.conf
                    │   └─────────┬──────────┘
                    │             ▼
                    │   ┌────────────────────┐   JWT → /api/ws/authorize/
                    │   │  ws-gateway (Rust) │◄──────────────┐
                    │   │  чат + каналы      │               │
                    │   └───┬────────────┬───┘               │
                    ▼       │            │                   │
        ┌───────────────────┴──┐         │                   │
        │  Daphne (Django ASGI)│◄────────┼───────────────────┘
        │  HTTP API            │  /ws/signaling/, /ws/guild/…/voice/
        │  presence, сигналинг │  (эти сокеты обслуживает Django, не Rust)
        └───┬──────┬──────┬────┘
            │      │      │
            │      │      └────────► Elasticsearch :9200  (поиск)
            │      └───────────────► Redis :6379          (channel layer, presence, pub/sub)
            │
            ▼ produce
        Kafka :9092 ──► kafka_worker (N процессов) ──► PostgreSQL :5432
                                                          ▲
                                                          └── Daphne читает напрямую

        coturn :3478/:5349 + relay UDP/TCP 49152–65535   (STUN/TURN для звонков)
```

Что здесь важно понимать:

- **Сообщения не пишутся в базу синхронно.** Клиент отдаёт сообщение, оно уходит
  в Kafka, а `kafka_worker` пишет его в PostgreSQL. Один воркер упирался примерно
  в 190 сообщений/с, поэтому воркеров запускается несколько (`SFERA_WORKERS`,
  по умолчанию 2) в одной consumer-группе — брокер сам делит партиции.
- **WebSocket раздвоен.** Чат и каналы гильдий обслуживает Rust-шлюз через
  балансировщик, а presence, сигналинг звонков и голосовые комнаты — Django.
  Это прописано регулярным выражением в конфиге nginx, который генерирует
  `start-common.sh`.
- **Фан-аут между нодами идёт через Redis pub/sub**, поэтому балансировщик можно
  переключить с `ip_hash` на `least_conn` — клиент всё равно получит все сообщения.
- **Вложения зашифрованы на диске.** `/media/attachments/` в nginx отдаёт 404;
  файлы уходят только через `/api/attachments/` с проверкой прав и расшифровкой.

---

## Порты

| Порт | Кто слушает | Наружу | Назначение |
|-----:|-------------|:------:|------------|
| 5173 | Vite | dev | Дев-сервер фронтенда |
| 80 / 443 | nginx (хост) | да | Фронтенд; 80 редиректит на 443 в SSL-режиме |
| 8000 | nginx (хост) | да | Публичный HTTP API (`SFERA_API_PUBLIC_PORT`) |
| 8001 | nginx (хост) | да | Публичный WebSocket (`SFERA_WS_PUBLIC_PORT`) |
| 8010 | Daphne | нет | Внутренний ASGI-порт Django (`SFERA_DJANGO_PORT`) |
| 8081 | loadbalancer | нет | Балансировщик WS (`SFERA_LB_LOCAL_PORT`), в контейнере 8001 |
| 8001 | ws-gateway | нет | Rust-шлюз внутри docker-сети (`WS_BIND`) |
| 8084 | nginx | локально | UI при запуске `scripts/windows/start-all.bat` |
| 5432 | PostgreSQL | нет | База |
| 9200 | Elasticsearch | нет | Поиск по сообщениям |
| 6379 | Redis | нет | Channel layer, presence, pub/sub |
| 9092 | Kafka | нет | Очередь сообщений |
| 9090 | Prometheus | нет | Сбор метрик |
| 9093 | Alertmanager | нет | Алерты |
| 3000 | Grafana | нет | Дашборды (наружу — через `/grafana/`) |
| 3478 / 5349 | coturn | да | STUN/TURN |
| 49152–65535 | coturn | да | Relay-диапазон UDP/TCP (`SFERA_COTURN_MIN_PORT` / `MAX_PORT`) |
| 51820 | WireGuard | да | Приватная сеть между нодами кластера |

Все docker-порты проброшены на `127.0.0.1` — снаружи они недоступны, к ним
ходят только процессы хоста и nginx.

---

## Быстрый старт: только фронтенд

Если нужен один интерфейс, а API берётся с уже работающего сервера:

```bash
npm install
npm run dev
```

Откроется `http://localhost:5173`. Адрес бэкенда задаётся в
[`src/config/network.ts`](src/config/network.ts) (`APP_HOST`, `API_PORT`,
`WS_PORT`) либо выбирается в самом приложении: список серверов хранится в
`localStorage`, добавить свой можно в настройках.

---

## Запуск с нуля: полный стек

Нужно заранее: **Node.js 18+** (CI собирает на 22), **Python 3.12**,
**Docker** с плагином `compose`, **nginx**, **coturn**. Для сборки `ws-gateway`
из исходников — Rust и `cmake`, `libssl-dev`, `libsasl2-dev`, `pkg-config`
(в docker-сборке они уже есть).

### 1. Установка зависимостей

Скрипт ставит системные пакеты, создаёт venv Python, ставит npm-пакеты,
настраивает coturn и генерирует секреты.

```bash
scripts/install-deps.sh
```

| Флаг | Что делает |
|------|------------|
| `--skip-coturn` | Не ставить и не настраивать coturn |
| `--skip-system` | Не ставить пакеты ОС (node/python/nginx/…) — только зависимости проекта |
| `--with-mail` | Дополнительно поднять свой отправляющий SMTP (Postfix + OpenDKIM), только Linux |
| `-h`, `--help` | Справка |

Windows:

```bat
scripts\windows\install-deps.bat
```

Те же флаги `--skip-coturn`, `--skip-system`, `--help`. Скрипт создаёт venv в
`django-server\myenv\`.

Вручную то же самое:

```bash
npm install
cd django-server
python -m venv .venv                 # на Windows: python -m venv myenv
.venv/bin/pip install -r requirements.txt
```

### 2. Запуск — Windows

```bat
scripts\windows\start-all.bat
```

Восемь шагов по порядку: docker-сервисы (Redis, Kafka, Zookeeper, kafka-init,
Prometheus, Grafana, ws-gateway, loadbalancer) → `npm run build` → очистка
каталога nginx → раскладка `dist\` в `html\` → nginx → Daphne в отдельном окне
с автоперезапуском → Kafka-воркер → coturn через WSL.

Скрипт ожидает:

- venv в `django-server\myenv\` (иначе сообщит, что делать),
- nginx в `D:\nginx-1.29.8` — путь захардкожен переменной `NGINX_DIR` в начале
  файла, поправьте под себя,
- `~/turnserver.conf` внутри WSL; TURN-пользователь `sferauser` заводится
  автоматически, если его нет.

После старта: UI на `http://localhost:8084`, API на `http://localhost:8000`.
Любая клавиша в окне скрипта останавливает всё через `scripts\windows\stop-all.bat`.

Отдельные части, если нужно поднять их поштучно:

```bat
scripts\windows\run-daphne.bat      <django_dir> <python.exe>
scripts\windows\run-kafka-worker.bat <django_dir> <python.exe>
scripts\windows\coturn-install.bat
```

### 3. Запуск — macOS

```bash
scripts/macos/coturn-install.sh     # один раз
scripts/macos/start-all.sh
```

Поднимает docker-сервисы, coturn из `~/.coturn/turnserver.conf`, Daphne и
Kafka-воркер. Остановка — `scripts/macos/stop-all.sh`.

### 4. Запуск — Linux / прод

Два входа, оба тонкие обёртки над `scripts/linux/start-common.sh`:

```bash
scripts/linux/start-http.sh                      # без TLS: фронт на :80, API на :8000
scripts/linux/start-ssl.sh --cert PATH --key PATH # прод с TLS
```

Что делает `start-common.sh`, по шагам:

1. **swap** — если его нет, создаёт файл на 6 ГБ (`SFERA_SWAP_SIZE`) и ставит
   `vm.swappiness=10`. На машине с 2 ГБ памяти без свопа OOM-killer убивает
   Kafka, а Daphne зависает.
2. **секреты** — генерирует `/etc/sfera/secrets.env`, если его нет, и пишет
   `django-server/.env` для docker compose.
3. **docker** — поднимает postgres, elasticsearch, redis, kafka, zookeeper,
   kafka-init, prometheus, grafana, alertmanager, ws-gateway, loadbalancer;
   синхронизирует пароль Postgres и ждёт готовности базы (до 120 с).
4. **coturn** — прописывает relay-диапазон в `/etc/turnserver.conf` и
   перезапускает сервис.
5. **почта** — см. [ниже](#почта).
6. **Daphne** — ставит systemd-юнит `sfera-daphne.service` с автоперезапуском,
   `ExecStartPre` с миграциями и таймером-сторожем
   `sfera-daphne-healthcheck.timer`: раз в минуту дёргает `/metrics/` и
   перезапускает сервис, если тот жив, но не отвечает.
7. **Kafka-воркеры** — шаблонный юнит `sfera-kafka-worker@N.service`,
   `SFERA_WORKERS` штук.
8. **loadtest.env** — пишет `load-tests/loadtest.env` с реквизитами PG/ES, чтобы
   нагрузочные тесты работали с той же базой, что и сервер.
9. **фронтенд** — `npm ci` (только если изменился lock-файл), `npm run build`,
   раскладка в `/var/www/sfera`, симлинк `media/`.
10. **nginx** — генерирует и включает конфиг сайта, проверяет `nginx -t`,
    перезагружает.

Флаги (принимают оба входных скрипта):

| Флаг | Значение по умолчанию | Описание |
|------|----------------------|----------|
| `--cert PATH`, `-c` | `/etc/letsencrypt/live/$DOMAIN/fullchain.pem` | Сертификат (только SSL) |
| `--key PATH`, `-k` | `/etc/letsencrypt/live/$DOMAIN/privkey.pem` | Приватный ключ (только SSL) |
| `--api-port PORT` | `8000` | Публичный порт API на nginx |
| `--django-port PORT` | `8010` | Внутренний порт Daphne |
| `--django-bind HOST` | `127.0.0.1` | Адрес, на котором слушает Daphne |
| `--mail MODE` | `yandex` | Режим почты: `yandex` \| `own` \| `off` |
| `--help`, `-h` | — | Справка |

Пример полного прод-запуска:

```bash
SFERA_DOMAIN=example.com \
SFERA_ALLOWED_HOSTS=example.com \
SFERA_WORKERS=4 \
scripts/linux/start-ssl.sh --cert /etc/letsencrypt/live/example.com/fullchain.pem \
                           --key  /etc/letsencrypt/live/example.com/privkey.pem
```

---

## Скрипты: полный справочник

### Общие

| Скрипт | Назначение |
|--------|------------|
| `scripts/install-deps.sh` | Установка всего: пакеты ОС, npm, venv, coturn, секреты |
| `scripts/train-censor-model.mjs` | Переобучение модели фильтра контента (`npm run train:censor`) |

### Linux

| Скрипт | Назначение |
|--------|------------|
| `start-http.sh` | Запуск без TLS |
| `start-ssl.sh` | Запуск с TLS (прод) |
| `start-common.sh` | Общая реализация обоих; принимает `http`\|`ssl` первым аргументом |
| `start-all.sh` | Обёртка совместимости, вызывает `start-http.sh` |
| `stop.sh` | Обычная остановка: Daphne, воркеры, coturn, nginx, `docker compose stop` — контейнеры остаются |
| `stop-all.sh` | Полная остановка: то же + почта + `docker compose down` + зачистка процессов. Тома с данными не трогает |
| `uninstall.sh` | Снос установки: systemd-юниты, docker-стек **вместе с томами (база!)**, конфиг nginx, swap, логи, venv |
| `coturn-install.sh` | Установка и настройка coturn. С общим секретом включает `use-auth-secret` (временные креды, валидны на любой ноде с тем же секретом), иначе статические user/pass |
| `mail-install.sh` | Свой отправляющий SMTP: Postfix (слушает только 127.0.0.1) + OpenDKIM. Идемпотентен. С аргументом-адресом отправит тестовое письмо |
| `wg-hub.sh` | WireGuard-хаб на главном сервере: `install`, `add-peer <pubkey> <ip>`, `info` |
| `wg-node.sh` | WireGuard-клиент на доп-ноде; печатает её pubkey для добавления на хабе |
| `cluster-hub-setup.sh` | Интерактивная настройка кластера на главном сервере, всё спрашивает, пишет `/etc/sfera/cluster.env` |
| `cluster-node-setup.sh` | Настройка доп-ноды целиком; принимает join-токен с главного для предзаполнения |
| `node-up.sh` | Поднять ws-gateway на доп-ноде (нужны поднятый WireGuard и заполненный `/etc/sfera/node.env`) |
| `turn-cluster-setup.sh` | Управление пулом TURN-нод на главном сервере (балансировка звонков) |
| `turn-node-setup.sh` | Поднять отдельную публичную TURN-ноду |
| `node.env.example` | Шаблон `/etc/sfera/node.env` для доп-ноды |

`uninstall.sh` по умолчанию не трогает репозиторий, coturn и docker-образы:

```bash
scripts/linux/uninstall.sh                 # спросит подтверждение
scripts/linux/uninstall.sh --yes
scripts/linux/uninstall.sh --yes --purge-code --purge-images --purge-coturn
scripts/linux/uninstall.sh --keep-swap
```

### Windows

| Скрипт | Назначение |
|--------|------------|
| `install-deps.bat` | Установка зависимостей (`--skip-coturn`, `--skip-system`) |
| `start-all.bat` | Полный запуск стека |
| `stop-all.bat` | Остановка всего |
| `run-daphne.bat` | Daphne с автоперезапуском в отдельном окне |
| `run-kafka-worker.bat` | Kafka-воркер в отдельном окне |
| `coturn-install.bat` | Установка coturn |

### macOS

| Скрипт | Назначение |
|--------|------------|
| `start-all.sh` / `stop-all.sh` | Запуск и остановка стека |
| `run-daphne.sh` / `run-kafka-worker.sh` | Отдельные процессы |
| `coturn-install.sh` | Установка coturn |

---

## Переменные окружения

### Django

Секреты читаются из `/etc/sfera/secrets.env` (см. [Секреты](#секреты)),
остальное задаётся в systemd-юните или в окружении процесса.

| Переменная | По умолчанию | Описание |
|------------|--------------|----------|
| `SFERA_DEBUG` | `0` | Режим отладки. При `0` обязательны `SFERA_SECRET_KEY` и `SFERA_MESSAGE_ENCRYPTION_KEY` |
| `SFERA_SECRET_KEY` | — | Ключ Django. Он же `JWT_SECRET` для ws-gateway |
| `SFERA_DOMAIN` | — (обязателен) | Адрес сайта из секрета `SFERA_DOMAIN`; хранится в `/etc/sfera/secrets.env`. От него настраиваются nginx, сертификат, `ALLOWED_HOSTS`, CSRF/CORS, realm TURN, отправитель писем с кодами и сборка фронтенда. Не задан — сайт отвечает 500 |
| `SFERA_LETSENCRYPT` | `1` | Нет сертификата под домен — деплой сам получает его у Let's Encrypt (nginx на это время останавливается), при неудаче ставит самоподписанный. `0` — не пытаться |
| `SFERA_LETSENCRYPT_EMAIL` | `$SFERA_SUPERUSER_EMAIL` | Почта для уведомлений Let's Encrypt |
| `SFERA_ALLOWED_HOSTS` | — | Дополнительные хосты через запятую |
| `SFERA_CSRF_ORIGINS` | — | Дополнительные CSRF-origin через запятую |
| `SFERA_CORS_ORIGINS` | — | Дополнительные CORS-origin через запятую |
| `SFERA_HSTS_SECONDS` | `31536000` | Длительность HSTS при `DEBUG=0` |
| `SFERA_STATUS_TOKEN` | — | Секретный сегмент URL статус-страницы `/status-<токен>/` |
| **База** | | |
| `POSTGRES_DB` | — | **Если не задана — Django уходит на sqlite.** Задание этой переменной включает Postgres |
| `POSTGRES_USER` | `sfera` | |
| `POSTGRES_PASSWORD` | — | |
| `POSTGRES_HOST` | `127.0.0.1` | |
| `POSTGRES_PORT` | `5432` | |
| `SFERA_CONN_MAX_AGE` | `0` | Время жизни соединения с БД. Поднимать только при наличии пулера |
| `ELASTICSEARCH_URL` | `http://127.0.0.1:9200` | Поиск по сообщениям |
| **Очередь и кэш** | | |
| `KAFKA_ENABLED` | `false` | Включает конвейер через Kafka |
| `KAFKA_BOOTSTRAP_SERVERS` | `localhost:9092` | |
| `REDIS_URL` | `redis://127.0.0.1:6379/0` | |
| `USE_REDIS_CHANNEL_LAYER` | автоопределение | Принудительно включить Redis как channel layer |
| **Токены и сессии** | | |
| `SFERA_ACCESS_TOKEN_MINUTES` | `15` | Время жизни access-токена |
| `SFERA_REFRESH_TOKEN_HOURS` | `36` | Время жизни refresh-токена в вебе |
| `SFERA_APP_REFRESH_TOKEN_DAYS` | `3650` | То же для нативных приложений |
| `SFERA_REFRESH_COOKIE_NAME` | `sfera_refresh` | |
| `SFERA_REFRESH_COOKIE_PATH` | `/api/auth/` | |
| `SFERA_REFRESH_COOKIE_SECURE` | `не DEBUG` | |
| `SFERA_REFRESH_COOKIE_SAMESITE` | `Lax` | |
| `SFERA_APP_UA_TOKEN` | `SferaApp/` | Метка User-Agent нативных оболочек |
| **Ограничение частоты** | | |
| `SFERA_THROTTLE_ANON` | `60/min` | Анонимные запросы |
| `SFERA_THROTTLE_USER` | `1000/min` | Авторизованные |
| `SFERA_THROTTLE_AUTH` | `10/min` | Эндпоинты входа и смены пароля |
| **Шифрование** | | |
| `SFERA_MESSAGE_ENCRYPTION_KEY` | — | Ключ шифрования сообщений и вложений (Fernet) |
| `SFERA_OLD_MESSAGE_ENCRYPTION_KEYS` | — | Прежние ключи через запятую — на время ротации |
| `SFERA_UPLOAD_SCAN_COMMAND` | — | Внешняя команда антивирусной проверки загрузок |
| **TURN** | | |
| `SFERA_TURN_NODES` | — | Пул нод `host:port,host:port`; `/api/turn/` раздаёт их round-robin |
| `SFERA_TURN_REALM` | `$SFERA_DOMAIN` | |
| `SFERA_TURN_PORT` | `3478` | |
| `SFERA_TURN_SECRET` | — | Общий секрет → временные креды (`use-auth-secret`) вместо статических |
| `SFERA_TURN_TTL` | `3600` | Время жизни временных кред |
| `SFERA_TURN_USER` | `sferauser` | Статический логин, если секрет не задан |
| `SFERA_TURN_PASS` | `sferaturn123` | Статический пароль, если секрет не задан |
| **Почта** | | |
| `EMAIL_HOST` | — | Пусто → письма печатаются в консоль |
| `EMAIL_PORT` | `587` | |
| `EMAIL_HOST_USER` / `EMAIL_HOST_PASSWORD` | — | |
| `EMAIL_USE_TLS` | `true` | |
| `EMAIL_USE_SSL` | `false` | |
| `DEFAULT_FROM_EMAIL` | — | Обратный адрес |
| `EMAIL_CODE_TTL_MINUTES` | `15` | Время жизни кода подтверждения |
| `EMAIL_CODE_RESEND_SECONDS` | `60` | Минимальный интервал между отправками |
| `EMAIL_CODE_MAX_ATTEMPTS` | `5` | Попыток ввода кода |

### Скрипты запуска (Linux)

| Переменная | По умолчанию | Описание |
|------------|--------------|----------|
| `SFERA_APP_NAME` | `sfera` | Имя конфига nginx |
| `SFERA_WEB_ROOT` | `/var/www/sfera` | Куда кладётся собранный фронтенд |
| `SFERA_DJANGO_PORT` | `8010` | Внутренний порт Daphne |
| `SFERA_DJANGO_BIND_HOST` | `127.0.0.1` | Адрес Daphne |
| `SFERA_DJANGO_PROXY_HOST` | `127.0.0.1` | Куда проксирует nginx |
| `SFERA_API_PUBLIC_PORT` | `8000` | Публичный порт API |
| `SFERA_WS_PUBLIC_PORT` | `8001` | Публичный порт WebSocket |
| `SFERA_LB_LOCAL_PORT` | `8081` | Локальный порт балансировщика |
| `SFERA_SSL_CERT` / `SFERA_SSL_KEY` | пути Let's Encrypt | Сертификат и ключ |
| `SFERA_COTURN_MIN_PORT` | `49152` | Начало relay-диапазона |
| `SFERA_COTURN_MAX_PORT` | `65535` | Конец relay-диапазона |
| `SFERA_COTURN_CONF` | `/etc/turnserver.conf` | Конфиг coturn |
| `SFERA_WORKERS` | `2` | Число процессов `kafka_worker` |
| `SFERA_MAIL_MODE` | `yandex` | Режим почты |
| `SFERA_SWAP_SIZE` | `6G` | Размер создаваемого swap-файла |
| `SFERA_SWAP_FILE` | `/swapfile` | Путь swap-файла |
| `SFERA_POSTGRES_DB` / `USER` / `PASSWORD` / `HOST` / `PORT` | `sfera` / `sfera` / из секретов / `127.0.0.1` / `5432` | Реквизиты Postgres для host-процессов |
| `SFERA_ELASTICSEARCH_URL` | `http://127.0.0.1:9200` | |
| `SFERA_SMTP_HOST` / `PORT` / `SSL` / `USER` / `PASSWORD` / `FROM` | `smtp.yandex.ru` / `465` / `true` / — / — / — | Реквизиты внешнего SMTP; можно положить в `.mail.env` |

### ws-gateway (Rust)

Файл [`ws-gateway/.env`](ws-gateway/.env) для локального запуска; в docker
значения приходят из `django-server/.env`, который генерирует `start-common.sh`.

| Переменная | По умолчанию | Описание |
|------------|--------------|----------|
| `WS_BIND` | `0.0.0.0:8001` | Адрес прослушивания |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Pub/sub и presence |
| `KAFKA_BOOTSTRAP_SERVERS` | `localhost:9092` | |
| `JWT_SECRET` | — | **Обязан совпадать с `SFERA_SECRET_KEY` Django** |
| `SFERA_SECRET_KEY` | — | Альтернативное имя того же ключа |
| `DJANGO_WS_AUTHZ_URL` | — | Куда шлюз ходит авторизовать сокет, обычно `https://<домен>:8000/api/ws/authorize/` |
| `RUST_LOG` | `info` | Уровень логов |

> Ключ читается из секретов через `sed`, а не `awk -F=`: base64-значение
> `SECRET_KEY` заканчивается на `=`, и `awk` обрезал бы последний символ. Шлюз
> тогда проверяет JWT неверным ключом, и **каждый** чат-сокет отвечает 401,
> тогда как сигналинг продолжает работать — его валидирует Django.

---

## Секреты

Живут вне репозитория, в `/etc/sfera/secrets.env` (права `0640`), и переживают
передеплой. Генерируются автоматически при первом запуске
`install-deps.sh` или `start-common.sh`:

```
SFERA_SECRET_KEY=…                     # ключ Django, он же JWT для ws-gateway
SFERA_STATUS_TOKEN=…                   # сегмент URL статус-страницы
SFERA_MESSAGE_ENCRYPTION_KEY=…         # шифрование сообщений и вложений
SFERA_OLD_MESSAGE_ENCRYPTION_KEYS=     # прежние ключи на время ротации
SFERA_ACCESS_TOKEN_MINUTES=15
GRAFANA_PASSWORD=…
SFERA_POSTGRES_PASSWORD=…
```

`SFERA_SECRET_KEY` и `SFERA_STATUS_TOKEN` можно ротировать свободно — максимум
это разлогинит пользователей. `SFERA_MESSAGE_ENCRYPTION_KEY` ротируется только
через `rotate_message_encryption` (см. [Обслуживание](#обслуживание)):
непосредственная замена сделает старые сообщения нечитаемыми.

Из секретов скрипты собирают `django-server/.env` для docker compose
(`POSTGRES_*`, `GRAFANA_PASSWORD`, `JWT_SECRET`, `DJANGO_WS_AUTHZ_URL`).
Оба файла в `.gitignore` — коммитить их нельзя.

---

## Почта

Кодами подтверждения занимается один из трёх режимов, выбираемых `--mail`:

| Режим | Что происходит |
|-------|----------------|
| `yandex` (по умолчанию) | Письма уходят через внешний релей Yandex SMTP (465, SSL). Исходящий TCP/25 с хоста **режется** отдельной nft-таблицей `sfera_mail` — чтобы взломанный сервер нельзя было использовать как спам-релей. Правило переживает перезагрузку (`sfera-smtp-guard.service`) |
| `own` | Свой Postfix на `127.0.0.1:25` плюс OpenDKIM. Блокировка 25-го порта снимается. Требует `mail-install.sh` |
| `off` | Письма не отправляются, код печатается в консоль сервера |

Реквизиты Yandex в репозиторий не попадают: положите их в `.mail.env` в корне
проекта (файл в `.gitignore`, шаблон — `.mail.env.example`) либо передайте через
`SFERA_SMTP_USER` / `SFERA_SMTP_PASSWORD`. Скрипт создаёт шаблон сам и
предупредит, если он не заполнен.

Пароль SMTP попадает в systemd-дроп-ин
`/etc/systemd/system/sfera-daphne.service.d/email.conf` с правами `600`.

---

## Docker-сервисы

Всё описано в [`django-server/docker-compose.yml`](django-server/docker-compose.yml).

| Сервис | Образ | Порт (на хосте) |
|--------|-------|-----------------|
| `postgres` | `postgres:16-alpine` | `127.0.0.1:5432` |
| `elasticsearch` | `elasticsearch:8.15.3` | `127.0.0.1:9200` |
| `redis` | `redis:7-alpine` | `127.0.0.1:6379` |
| `zookeeper` | `cp-zookeeper:7.6.0` | — |
| `kafka` | `cp-kafka:7.6.0` | `127.0.0.1:9092` |
| `kafka-init` | `cp-kafka:7.6.0` | — (создаёт топики и выходит) |
| `prometheus` | `prom/prometheus:v2.53.0` | `127.0.0.1:9090` |
| `alertmanager` | `prom/alertmanager:v0.27.0` | `127.0.0.1:9093` |
| `grafana` | `grafana/grafana:11.1.0` | `127.0.0.1:3000` |
| `ws-gateway` | сборка из `ws-gateway/` | только внутри сети, `8001` |
| `loadbalancer` | сборка из `loadbalancer/` | `127.0.0.1:8081` → `8001` |

Дополнительно: `docker-compose.cluster.yml` — набор для главного сервера
кластера, `docker-compose.node.yml` — для доп-ноды.

Ручной запуск:

```bash
cd django-server
docker compose up -d --build postgres elasticsearch redis kafka zookeeper \
  kafka-init prometheus grafana alertmanager ws-gateway loadbalancer
docker compose ps
docker compose logs -f ws-gateway
```

---

## Нагрузочное тестирование

Всё живёт в [`load-tests/`](load-tests/) и опирается на management-команду
Django `seed_load`. Она умеет четыре разных вещи: **насеять данные** прямо в базу
через `bulk_create`, **дать живую нагрузку** по ставке через настоящие
WebSocket-соединения, **держать реальные WebRTC-звонки** через TURN, и
**обстрелять bot API** запросами, замеряя пропускную способность тарифов
(`standard` / `premium`).

### Профили сидирования

| Профиль | `N` аккаунты | `M` серверы | `H` каналы | `J` посты | `K` сообщ. в серверах | `G` личные сообщ. |
|---------|-------------:|------------:|-----------:|----------:|----------------------:|------------------:|
| `light` | 20 | 3 | 10 | 50 | 300 | 200 |
| `medium` | 200 | 20 | 120 | 1 000 | 10 000 | 5 000 |
| `high` | 2 000 | 100 | 800 | 20 000 | 200 000 | 100 000 |

Числа лежат в `light.env`, `medium.env`, `high.env` — правятся как обычные файлы.
`SEND_DM` (`T`) и `ACTIVE_CALLS` (`I`) в профилях выставлены в `0`, потому что
требуют запущенного сервера.

Что именно создаётся:

- **N аккаунтов** — пользователи `loadtest_<hex>_NNNNNN` с паролем `loadtest123`
  и настройками `UserSettings`.
- **M серверов** — гильдии `[LT] Server …` со случайным владельцем и 1–8 участниками.
- **H каналов** — текстовые, каждый седьмой голосовой, распределены по серверам.
- **J постов** — в личных каналах; сами каналы создаются автоматически,
  примерно один на 10 аккаунтов.
- **K сообщений** — `GuildMessage` в текстовых каналах гильдий.
- **G личных сообщений** — `Message` в диалогах по два участника,
  примерно один диалог на 20 сообщений; пишутся прямо в БД.

### Запуск

Windows:

```powershell
cd load-tests
.\run.ps1 light
.\run.ps1 medium -Purge              # сначала снести старые тестовые данные
.\run.ps1 high -DmMessages 50000     # переопределить одно число
.\run.ps1 custom                     # ввести N M H J K G вручную
.\run.ps1 -Help
```

Linux / macOS:

```bash
cd load-tests
./run.sh light
./run.sh medium --purge
./run.sh custom
./run.sh --help
```

Скрипты сами находят `manage.py` и python из venv (`.venv` или `myenv`).

### Все параметры `seed_load`

Команду можно вызывать и напрямую — тогда доступны параметры, которых нет в
обёртках. Без флагов она спросит основные числа интерактивно.

```bash
python django-server/sfera_server/manage.py seed_load [флаги]
```

**Сидирование данных**

| Флаг | По умолчанию | Описание |
|------|--------------|----------|
| `--accounts N` | спросит | Число аккаунтов |
| `--servers M` | спросит | Число серверов |
| `--channels H` | спросит | Число каналов всего |
| `--posts J` | спросит | Число постов в личных каналах |
| `--server-messages K` | спросит | Сообщений в серверных каналах |
| `--dm-messages G` | спросит | Личных сообщений в БД |
| `--batch N` | `2000` | Размер пачки для `bulk_create` |
| `--purge` | — | Удалить прежние тестовые данные и выйти |

**Реальная отправка ЛС через HTTP API** (создаёт живую нагрузку на HTTP,
WebSocket и Kafka; видна в статусе и Grafana)

| Флаг | По умолчанию | Описание |
|------|--------------|----------|
| `--send-dm T` | — | Сколько сообщений реально отправить через API |
| `--base-url URL` | `https://127.0.0.1:8000` | Адрес сервера |
| `--verify-tls` | выключено | Проверять TLS-сертификат (по умолчанию самоподписанный принимается) |
| `--concurrency N` | `8` | Параллельных отправителей |

Отправители берутся из уже существующих аккаунтов `loadtest_*`, поэтому сначала
нужен хотя бы один прогон с `--accounts > 1`.

**Живая нагрузка по ставке** — шлёт `R` сообщений в минуту в течение `--duration`
через постоянные WebSocket-соединения, как настоящий клиент. Ничего не создаёт,
работает на существующих данных.

| Флаг | По умолчанию | Описание |
|------|--------------|----------|
| `--rate R` | — | Сообщений в минуту |
| `--duration D` | — | Длительность: `300`, `300s`, `5m`, `1h`, `1h30m` |
| `--rate-target` | `both` | Куда слать: `guild`, `dm`, `both` |
| `--rate-max-conns N` | `100` | Максимум постоянных WS-соединений |
| `--ws-port PORT` | `8001` | Порт WS-шлюза. Именно через него, а не через Daphne, раздаются сообщения каналов |
| `--ws-url URL` | из `--ws-port` | Полный базовый WS-адрес, например `wss://host:8001` |
| `--online N` | `0` | Держать N «онлайн»-пользователей: постоянные presence-подключения к `/ws/signaling/`. Поднимает метрику `sfera_online_users` |

**Реальные WebRTC-звонки через TURN** — пары тестовых аккаунтов подключаются к
сигналингу, обмениваются offer/answer, поднимают `RTCPeerConnection` и гонят
настоящий медиапоток через coturn. Поднимают метрику `active_dm_calls`. Нужно
не меньше `2 × I` тестовых аккаунтов, и на время звонков команда **блокируется**.

| Флаг | По умолчанию | Описание |
|------|--------------|----------|
| `--active-calls I` | — | Сколько одновременных звонков держать |
| `--call-duration D` | — | Длительность: `300`, `300s`, `5m`, `1h`, `1h30m` |
| `--signaling-url URL` | из `--base-url` | Адрес сигналинга, обычно `wss://host:port/ws/signaling/`. Метрика `active_dm_calls` обновляется, только если сигналинг идёт через Django-консьюмер |
| `--with-video` | только звук | Добавить видеодорожку |
| `--turn-host HOST` | хост из `--base-url` | |
| `--turn-port PORT` | `3478` | |
| `--turn-user USER` | `sferauser` | |
| `--turn-cred CRED` | `sferaturn123` | |

Зависимости для звонков ставятся один раз:

```bash
pip install -r load-tests/requirements-loadtest.txt   # requests + websockets + aiortc (PyAV)
```

**Нагрузка на bot API** — создаёт **временного бота** нужного тарифа, обстреливает
его API `B` запросами в `--concurrency` потоков, затем **удаляет** бота и печатает
отчёт: реальный **rps**, задержки **avg/p50/p95/p99**, и разбивку ответов —
`2xx` (обслужено) / `429` (срезал rate-limit тарифа) / `5xx`+обрывы (реальные отказы).
Нужен запущенный сервер.

| Флаг | По умолчанию | Описание |
|------|--------------|----------|
| `--bot-api B` | — | Сколько запросов сделать к bot API |
| `--bot-api-tier` | `premium` | Тариф временного бота: `standard` (120/мин) или `premium` (2000/мин) |
| `--bot-api-endpoint` | `me` | Что долбить: `me` (auth + сериализация) или `chats` (чтение из БД) |
| `--concurrency N` | `8` | Параллельных потоков (для замера ставьте 32–128) |
| `--base-url URL` | `https://127.0.0.1:8000` | Адрес сервера |

Если при `premium` слать больше 2000 запросов в минуту, часть законно уйдёт в `429` —
это **работа лимита, а не отказ сервера**. Чтобы измерить **чистую ёмкость сервера
без лимита**, поднимите потолок тарифа и гоняйте `premium`:

```bash
SFERA_BOT_THROTTLE_PREMIUM=1000000/min   # в окружении сервера, затем перезапуск
```

> Этот тест меряет короткие запросы (`me`/`chats`). Настоящее узкое место ботов —
> `get_updates` (long-poll до 45 с), где важно число **одновременно висящих**
> соединений, а не частота; под него нужен отдельный сценарий на много ботов.

### Режим `rate` — живая нагрузка

Ничего не сидирует, гоняет нагрузку по готовым данным. Нужен запущенный сервер.

Задевает **все компоненты, что видны в Grafana**: сообщения в каналы/ЛС по WS,
онлайн-присутствие (`ONLINE`), WebRTC-звонки (`CALLS`) и **bot API** — параллельно
создаёт временных ботов `standard`+`premium` и бьёт по ним (`RATE_BOTS` потоков,
по умолчанию 4; `0` — выключить). Каждые 15 с печатает **снимок метрик сервера**
прямо в консоль — строку `[метрики] CPU.. RAM.. p95.. online.. voice.. HTTP.. botAPI..`
(берётся с `/metrics`; нужен `SFERA_STATUS_TOKEN`, который `run.sh` подхватывает
из `/etc/sfera/secrets.env` автоматически). Так все показатели видны и в логе, и в
дашбордах одновременно.

```powershell
.\run.ps1 rate -Rate 600 -Duration 10m -RateTarget both -BaseUrl https://127.0.0.1:8000
.\run.ps1 rate -Online 50 -Rate 600 -Duration 2m -Calls 5 -CallDuration 2m
```

```bash
RATE=600 DURATION=2m RATE_TARGET=both ./run.sh rate
ONLINE=200 RATE=600 DURATION=10m CALLS=10 CALL_DURATION=5m ./run.sh rate
```

| Переменная (`run.sh`) | Флаг (`run.ps1`) | По умолчанию | Описание |
|-----------------------|------------------|--------------|----------|
| `RATE` | `-Rate` | `600` | Сообщений в минуту |
| `DURATION` | `-Duration` | `10m` | Длительность |
| `RATE_TARGET` | `-RateTarget` | `both` | `guild` \| `dm` \| `both` |
| `ONLINE` | `-Online` | `0` | Онлайн-пользователей (presence) |
| `CALLS` | `-Calls` | `0` | Реальных WebRTC-звонков |
| `CALL_DURATION` | `-CallDuration` | — | Длительность звонков |
| `RATE_BOTS` | `-RateBots` | `4` | Потоков трафика на bot API (`0` — не трогать ботов) |
| `STATUS_TOKEN` | `-StatusToken` | из `SFERA_STATUS_TOKEN` | Токен `/metrics` для снимка метрик в консоль |
| `BASE_URL` | `-BaseUrl` | `https://127.0.0.1:8000` | Адрес сервера |

### Режим `ramp` — разгон до отказа

Только в `run.sh`. Постепенно повышает ставку стадиями, после каждой проверяет
здоровье сервера HTTP-пробой и долю ошибок отправки, и записывает в отчёт, на
каких параметрах сервер сломался. Каждая стадия — это тот же `rate`, поэтому
**тоже задевает bot API и печатает снимок метрик** (см. выше; отключить трафик
ботов — `RATE_BOTS=0`).

```bash
RAMP_START=600 RAMP_STEP=600 RAMP_STAGE=20s ./run.sh ramp
```

| Переменная | По умолчанию | Описание |
|------------|--------------|----------|
| `RAMP_START` | `600` | Стартовая ставка, сообщений/мин |
| `RAMP_STEP` | `600` | Прибавка за стадию |
| `RAMP_STAGE` | `20s` | Длительность одной стадии |
| `RAMP_MAX` | `30000` | Потолок ставки — если выдержал, тест останавливается |
| `RAMP_TARGET` | `guild` | `guild` \| `dm` \| `both` |
| `RAMP_FAIL_ERRORS` | `0.25` | Доля ошибок отправки, считающаяся отказом |
| `RAMP_MAXCONN` | `100` | Число WS-соединений на стадию |
| `RAMP_REPORT` | `load-tests/ramp-result.txt` | Файл отчёта |

### Режим `botapi` — пропускная способность bot API

Ничего не сидирует: создаёт временного бота тарифа `premium`/`standard`, шлёт
`BOT_API` запросов и печатает rps, задержки и разбивку `2xx`/`429`/ошибки. Нужен
запущенный сервер. Прямой ответ на вопрос «выдержит ли API N запросов».

```powershell
.\run.ps1 botapi -BotApi 10000 -BotApiTier premium -Concurrency 64 -BaseUrl https://127.0.0.1:8000
.\run.ps1 botapi -BotApi 10000 -BotApiTier standard -Concurrency 64   # быстро упрётся в 120/мин → 429
```

```bash
BOT_API=10000 BOT_API_TIER=premium CONCURRENCY=64 BASE_URL=https://127.0.0.1:8000 ./run.sh botapi
```

| Переменная (`run.sh`) | Флаг (`run.ps1`) | По умолчанию | Описание |
|-----------------------|------------------|--------------|----------|
| `BOT_API` | `-BotApi` | `10000` | Число запросов к bot API |
| `BOT_API_TIER` | `-BotApiTier` | `premium` | `standard` \| `premium` |
| `BOT_API_ENDPOINT` | `-BotApiEndpoint` | `me` | `me` \| `chats` |
| `CONCURRENCY` | `-Concurrency` | `8` | Параллельных потоков |
| `BASE_URL` | `-BaseUrl` | `https://127.0.0.1:8000` | Адрес сервера |

### База для тестов

`seed_load` обязана работать с **той же базой, что и сервер**. На сервере
`start-common.sh` пишет `load-tests/loadtest.env` автоматически; если запускаете
вручную, скопируйте `loadtest.env.example` и заполните:

```
POSTGRES_DB=sfera
POSTGRES_USER=sfera
POSTGRES_PASSWORD=…
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
ELASTICSEARCH_URL=http://127.0.0.1:9200
```

Без этого файла команда уйдёт в sqlite, прочитает каналы и пользователей из
другой базы, и вход на сервер провалится с результатом 0 из N. На дев-машине
файл не нужен — там sqlite и есть рабочая база.

**Секреты на проде.** При `SFERA_DEBUG=0` (боевой сервер) Django требует
`SFERA_SECRET_KEY`, а `seed_load` ещё и шифрует сообщения ключом
`SFERA_MESSAGE_ENCRYPTION_KEY`. Иначе — падение `ImproperlyConfigured:
SFERA_SECRET_KEY must be set`. `run.sh` сам подхватывает их из
`/etc/sfera/secrets.env` (того же файла, что systemd подаёт сервису) — под root
напрямую, иначе через `sudo`. Если файл в другом месте — укажите
`SFERA_SECRETS=/путь/secrets.env`, либо просто `export SFERA_SECRET_KEY=…` перед
запуском.

### Очистка

Удаляет всё с префиксами `loadtest_` (пользователи) и `[LT] ` (серверы и личные
каналы); связанные сообщения и каналы уходят каскадом.

```powershell
.\run.ps1 light -Purge
```
```bash
python django-server/sfera_server/manage.py seed_load --purge
```

---

## Мониторинг и статус

- **Grafana** — `https://<домен>/grafana/`, пароль в `GRAFANA_PASSWORD` из
  `/etc/sfera/secrets.env`.
- **Prometheus** — `127.0.0.1:9090`, **Alertmanager** — `127.0.0.1:9093`.
- **Метрики Django** — `/metrics/`. Их же дёргает сторож Daphne.
- **Статус-страница** — `/status-<SFERA_STATUS_TOKEN>/`. Токен заменяет собой
  дату в URL; без него адрес — `/status-ГГГГ-ММ-ДД/`. Middleware пропускает
  `/status-` и `/metrics` мимо проверки клиентского заголовка.

Полезные метрики: `sfera_online_users` (presence), `active_dm_calls` (звонки),
`ws_messages_sent`.

Логи на Linux:

```bash
tail -f /var/log/sfera/daphne.log
tail -f /var/log/sfera/kafka-worker.log
systemctl status sfera-daphne
journalctl -u sfera-daphne -n 200 -o cat
journalctl -t sfera-daphne-healthcheck     # срабатывания сторожа
journalctl -u nginx
journalctl -u coturn
postqueue -p                                # очередь почты в режиме own
```

---

## Горизонтальное масштабирование

Подробности — в [docs/SCALING.md](docs/SCALING.md). Коротко: всё состояние
(Postgres, Redis, Kafka, Elasticsearch) держит главный сервер, а доп-ноды несут
только `ws-gateway` и ходят к состоянию через приватный WireGuard.

**Пул ws-gateway.** Единственный файл со списком нод —
[`loadbalancer/servers.conf`](loadbalancer/servers.conf):

```nginx
server 10.0.0.12:8001 max_fails=3 fail_timeout=10s;
```

Применяется без простоя:

```bash
docker compose exec loadbalancer nginx -s reload
curl http://localhost:8081/lb-health
```

По умолчанию алгоритм `ip_hash` — клиент всегда попадает на ту же ноду. Так как
фан-аут идёт через Redis, можно переключить на `least_conn` в
`loadbalancer/nginx.conf`.

**Добавление ноды, по шагам:**

```bash
# на главном
sudo bash scripts/linux/wg-hub.sh install
sudo bash scripts/linux/wg-hub.sh info                      # покажет pubkey и endpoint
sudo bash scripts/linux/cluster-hub-setup.sh                # выдаст join-токен

# на ноде
sudo SFERA_WG_HUB_PUBKEY='<pubkey хаба>' \
     SFERA_WG_HUB_ENDPOINT='<публичный IP хаба>:51820' \
     SFERA_WG_NODE_IP=10.77.0.2 \
     bash scripts/linux/wg-node.sh                          # напечатает pubkey ноды

# снова на главном
sudo bash scripts/linux/wg-hub.sh add-peer <pubkey ноды> 10.77.0.2

# на ноде
sudo bash scripts/linux/cluster-node-setup.sh '<join-токен>'
sudo bash scripts/linux/node-up.sh
```

Конфиг ноды — `/etc/sfera/node.env` (шаблон `scripts/linux/node.env.example`),
права `600`. `JWT_SECRET` в нём должен быть **ровно** значением
`SFERA_SECRET_KEY` с главного сервера.

**Пул TURN.** Ноды звонков масштабируются отдельно от ws-gateway:

```bash
sudo bash scripts/linux/turn-node-setup.sh      # на новом публичном сервере
sudo bash scripts/linux/turn-cluster-setup.sh   # на главном: добавить ноду в пул
```

Список нод хранится в `SFERA_TURN_NODES`, эндпоинт `/api/turn/` раздаёт их
клиентам round-robin. Для нескольких TURN-серверов нужен общий
`SFERA_TURN_SECRET` — тогда coturn работает в режиме `use-auth-secret` и
временные креды валидны на любой ноде.

---

## Обслуживание

**Миграции.** На Linux их прогоняет `ExecStartPre` юнита Daphne при каждом
запуске. Вручную:

```bash
cd django-server/sfera_server
../.venv/bin/python manage.py migrate
../.venv/bin/python manage.py createsuperuser
```

**Ротация ключа шифрования сообщений.** Прямая замена ключа делает старые
сообщения нечитаемыми. Порядок такой: положить новый ключ в
`SFERA_MESSAGE_ENCRYPTION_KEY`, а прежний — в
`SFERA_OLD_MESSAGE_ENCRYPTION_KEYS`, перезапустить сервисы, прогнать команду и
только потом убрать старый ключ из `OLD_KEYS`.

```bash
python manage.py rotate_message_encryption --dry-run     # прогон без записи
python manage.py rotate_message_encryption
python manage.py rotate_message_encryption --batch-size 500
python manage.py rotate_message_encryption --db-only     # не трогать файлы вложений
```

**Kafka-воркер вручную:**

```bash
python manage.py kafka_worker
```

**Число воркеров:** `SFERA_WORKERS=4 scripts/linux/start-ssl.sh …` — скрипт сам
поднимет недостающие инстансы `sfera-kafka-worker@N` и погасит лишние.

---

## Остановка и удаление

```bash
scripts/linux/stop.sh        # штатно: сервисы вниз, контейнеры остаются — быстрый рестарт
scripts/linux/stop-all.sh    # полностью: + почта, docker compose down, зачистка. Тома целы
scripts/linux/uninstall.sh   # снос установки. ВНИМАНИЕ: удаляет тома docker вместе с базой
```

Windows — `scripts\windows\stop-all.bat`, macOS — `scripts/macos/stop-all.sh`.

---

## CI/CD

[`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml) на каждый PR и push
в `main`:

1. `npm ci` и `npm run build` на Node 22;
2. установка зависимостей Python 3.12, `compileall` бэкенда;
3. `manage.py check --deploy`;
4. `cargo check` для `ws-gateway` — не блокирует пайплайн, потому что настоящая
   сборка всё равно идёт в Docker, а сборка librdkafka на раннере капризна.

Деплой запускается при push в `main`, если переменная репозитория
`SFERA_DEPLOY_ENABLED` равна `true`, либо вручную через `workflow_dispatch` с
`deploy: true`. Он заходит по SSH, делает `git reset --hard origin/main` и
запускает `scripts/linux/start-common.sh`.

| Секрет | Назначение |
|--------|------------|
| `SFERA_DEPLOY_KEY` | Приватный SSH-ключ |
| `SFERA_DEPLOY_HOST` | Адрес сервера |
| `SFERA_DEPLOY_USER` | Пользователь (по умолчанию `root`) |
| `SFERA_DEPLOY_PORT` | Порт SSH (по умолчанию `22`) |

| Переменная | Назначение |
|------------|------------|
| `SFERA_DEPLOY_ENABLED` | `true` включает автодеплой с `main` |
| `SFERA_DEPLOY_PATH` | Каталог на сервере (по умолчанию `/opt/sfera`) |
| `SFERA_DEPLOY_MODE` | `ssl` или `http` (по умолчанию `ssl`) |
| `SFERA_DEPLOY_ENV_FILE` | Файл окружения на сервере (по умолчанию `/etc/sfera/deploy.env`) |
| `SFERA_DOMAIN` | Ваш домен: `From` писем становится `no-reply@<домен>`, идёт в `ALLOWED_HOSTS`, CSRF и realm TURN |
| `SFERA_MAIL_MODE` | Режим почты для деплоя: `own` (свой Postfix под доменом), `yandex` или `off` |

Если секреты не заданы, шаг деплоя пропускается с предупреждением, а не валит
пайплайн. Отдельный workflow [`security.yml`](.github/workflows/security.yml)
гоняет проверки безопасности.

### Почта под своим доменом через CI/CD

Чтобы письма уходили от `no-reply@<ваш-домен>` со своего сервера (SPF/DKIM/DMARC),
без внешнего релея:

1. Задайте секрет репозитория `SFERA_DOMAIN` = ваш домен и переменную `SFERA_MAIL_MODE` = `own`.
2. Один раз запустите workflow **CI/CD** вручную (`Run workflow`) с галкой
   **`setup_mail`**. Шаг зайдёт на сервер и выполнит
   [`mail-install.sh`](scripts/linux/mail-install.sh) для `SFERA_DOMAIN`: поднимет
   Postfix (только `127.0.0.1:25`) + OpenDKIM и **напечатает в лог job'а DNS-записи**
   (A, SPF, DKIM, DMARC) и напоминание про PTR.
3. Добавьте эти записи в DNS-зону домена (PTR/rDNS — в панели хостера). Подождите
   распространения (до ~часа).
4. Дальше обычный деплой (push в `main` или `deploy: true`) с `SFERA_MAIL_MODE=own`
   пропишет Django отправку через локальный Postfix — коды пойдут под вашим доменом.

Обычный деплой **не** переустанавливает Postfix и не трогает DKIM-ключ — только
переприменяет обвязку (drop-in `EMAIL_*` для Django, guard на порт 25). Сам
почтовый сервер ставится один раз через `setup_mail`.

**Проверка после деплоя.** Каждый деплой прогоняет шаг **Mail health check**
([`mail-healthcheck.sh`](scripts/linux/mail-healthcheck.sh)): смотрит, как Django
настроен на отправку, поднят ли Postfix/OpenDKIM, не зарублен ли исходящий 25,
отвечает ли SMTP баннером и сходится ли PTR/FCrDNS. Шаг не блокирует деплой —
проблемы выводятся как `warning`. Чтобы вдобавок отправить **реальное** тестовое
письмо, запустите workflow вручную и укажите адрес в поле `mail_test_to` — в логе
шага будет результат и очередь Postfix. Тот же скрипт можно гонять руками:
`sudo bash scripts/linux/mail-healthcheck.sh [--send you@example.com]`.

Проверка после DNS: `dig +short TXT mail._domainkey.<домен>` и заголовки
доставленного письма — `spf=pass dkim=pass`.

---

## Боты

Бот — обычный аккаунт с глобальным типом `bot`, зарегистрированный через
Сфероника. Боты — отдельный модуль (ветка `module/bots`): там же визуальный
редактор сценариев, публичный HTTP API, документация (`docs/BOTS.md`,
`docs/BOT_API.md`) и SDK (`sdks/python`, `sdks/cpp`, `sdks/rust`). После
`node scripts/modules/fetch.mjs` всё это лежит в `modules/bots/`.

---

## Структура проекта

```
.
├── src/                       фронтенд ядра (React + TypeScript)
│   ├── components/            экраны и виджеты: чат, звонки, настройки
│   ├── config/                адреса серверов, ICE/TURN
│   ├── context/               AppContext — состояние ядра и работа с API
│   ├── core/                  хост модулей (загрузка, слоты) и «Исследовать сферу»
│   ├── sdk/                   @sfera/sdk — единственный API, доступный модулям
│   ├── data/                  наборы эмодзи и прочие статические данные
│   ├── i18n/                  переводы (en, ru, de, fr, es, pt, zh)
│   ├── styles/                стили по областям интерфейса
│   ├── types/                 общие типы
│   ├── utils/                 вспомогательное: черновики, фильтр контента, NSFW
│   └── minimal.css            слой поверх styles/ — спокойная нейтральная тема
├── django-server/
│   ├── sfera_server/          проект Django
│   │   ├── sfera_auth/        пользователи, друзья, профили, устройства
│   │   ├── sfera_messages/    личные сообщения, вложения, общие сервисы сообщений
│   │   ├── sfera_modules/     реестр модулей: загрузка, установка, хуки ядра
│   │   └── sfera_signaling/   WebRTC-сигналинг
│   ├── docker-compose*.yml    стек: одиночный, кластерный, нода
│   └── requirements.txt
├── modules/                   модули (git worktree веток module/<id>, в main не хранятся)
├── modules.lock.json          какие коммиты веток модулей разворачиваются с этим ядром
├── ws-gateway/                WebSocket-шлюз на Rust (чат и каналы)
├── loadbalancer/              nginx перед пулом ws-gateway
├── load-tests/                профили и запускалки нагрузки
├── scripts/                   установка, запуск, остановка, кластер, TURN, почта, modules/fetch.mjs
│   ├── linux/  macos/  windows/
├── docs/                      модули, масштабирование, Android WebView
└── .github/workflows/         CI/CD и проверки безопасности
```

---

## Разработка

| Команда | Что делает |
|---------|------------|
| `npm run dev` | Дев-сервер Vite с HMR на `:5173` |
| `npm run build` | Прод-сборка в `dist/` |
| `npm run preview` | Локальный просмотр прод-сборки |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` по `tsconfig.app.json` |
| `npm run train:censor` | Переобучение модели фильтра контента |

Бэкенд:

```bash
cd django-server/sfera_server
../.venv/bin/python manage.py runserver          # HTTP без WebSocket
../.venv/bin/daphne -b 127.0.0.1 -p 8010 sfera_server.asgi:application
../.venv/bin/python manage.py test
```

Без `POSTGRES_DB` в окружении Django работает на sqlite — локальной разработке
не нужен ни поднятый Postgres, ни Docker. При `SFERA_DEBUG=1` секреты
подставляются дев-значениями, письма печатаются в консоль.

`ws-gateway`:

```bash
cd ws-gateway
cargo check
cargo run          # читает ws-gateway/.env
```

Замечания по безопасности бэкенда — в
[`django-server/SECURITY.md`](django-server/SECURITY.md).

---

## Лицензия

Проект приватный.

## Лицензия и коммерческие сервисы

Ядро этой ветки распространяется по **AGPL-3.0-only**: [полный текст](LICENSE). Сторонние зависимости сохраняют собственные лицензии.

Целевая модель: открытое ядро и платные модули через отдельный API компании, подписка на весь экземпляр сервера. [Границы и состояние миграции](docs/OPEN_CORE_MODEL.md). Работающая альфа до разделения сохранена в ветке `prototype-1`.
