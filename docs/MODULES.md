# Модули Сферы

Сфера состоит из **ядра** и **модулей**.

**Ядро** живёт в ветке `main`. В него входят:
- авторизация;
- друзья;
- личные переписки;
- звонки;
- SDK модулей;
- реестр модулей (`sfera_modules`).

**Модули** лежат каждый в своей ветке `module/<id>`:

| Модуль | Ветка | Django-приложение | Что даёт |
|---|---|---|---|
| Серверы | `module/servers` | `sfera_servers` | сообщества с текстовыми и голосовыми каналами, роли, приглашения, поиск серверов |
| Каналы | `module/channels` | `sfera_channels` | личные ленты: посты, подписки, комментарии, поиск каналов и постов |
| Боты | `module/bots` | `sfera_bots` | Сфероник, редактор ботов, Bot API, SDK |
| Семейный центр | `module/family` | `sfera_family` | детские аккаунты, одобрение друзей, геолокация семьи |
| Личные дневники | `module/diary` | `sfera_diary` | приватные записи с задачами, геометками и файлами |

Модули не зависят друг от друга. Если модуль умеет больше рядом с другим, он проверяет, есть ли тот на сервере. Например, у семьи появляется семейный сервер, когда развёрнут модуль серверов. Бот может писать в каналы серверов тоже только при развёрнутом модуле серверов.

## Как пользователь ставит модули

1. **Открывает каталог.** В «Исследовать сферу» видны все модули, развёрнутые на сервере, с кнопками «Установить» и «Удалить».
2. **Устанавливает модуль.** Интерфейс модуля загружается сразу, перезагрузка не нужна. Код каждого модуля — отдельный чанк, он скачивается только после установки.
3. **Удаляет модуль.** Интерфейс исчезает, API модуля начинает отвечать 403, данные при этом сохраняются. Если поставить модуль снова, всё вернётся.
4. **Поиск.** Строка поиска в «Исследовать сферу» есть, только пока установлен хотя бы один модуль с поиском: серверы или каналы.
5. **Защита детей.** Семейный центр нельзя удалить, пока пользователь состоит в семье. Ограничения детского аккаунта работают независимо от того, что установлено.

Все, у кого уже были данные модуля, получили его автоматически в миграции `install_for_*`.

## Устройство ветки модуля

```
module.json                 id, name, version, sdkVersion, deps, backendApp, urlPrefix, icon
backend/<django_app>/        models, migrations, urls.py, routing.py (WS), apps.py (хуки), tests.py
frontend/index.tsx           export default defineModule({ id, setup(ctx) { … } })
monitoring/grafana/*.json    дашборды Grafana модуля (папка модуля в Grafana)
monitoring/alert_rules.yml   алерты Prometheus модуля (необязательно)
.github/workflows/module.yml CI модуля: собирает main + этот модуль и гоняет его тесты
```

### Бэкенд

Загрузчик (`sfera_modules/loader.py`) находит `modules/*/module.json` и делает три вещи:
- добавляет `backendApp` в `INSTALLED_APPS`;
- монтирует `urls.py` по `urlPrefix`;
- подключает `routing.py`. WebSocket-маршруты модулей идут под `/ws/m/...`, nginx отправляет их в Django.

Модуль общается с ядром только через `sfera_modules.hooks`:
- **Сигналы:** `message_created`, `conversation_opened`, `user_blocked`/`user_unblocked`, `module_installed`/`module_uninstalled`.
- **Реестры:** `PROFILE_EXTRAS`, `DATA_EXPORT`, `METRICS`, `HAS_DATA`, `IS_MANAGED`, `CAN_UNINSTALL`, `WS_AUTHORIZE`, `KAFKA_HANDLERS`, `ENCRYPTED_DATA`.
- **Сервисы:** `hooks.provide(name, impl)` / `hooks.service(name)`.
- **Пуш клиенту:** `hooks.push_to_user(user_id, event, payload)`.

Метрики модуль отдаёт через `METRICS`: `tables` (строки в `sfera_db_rows`), `prometheus` (список серий `{name, type, value, help, labels}`) и `status` (карточки на `/status/`). Ядро само ничего не знает о метриках модулей.

Эндпоинты модуля закрываются декоратором `requires_module('<id>')`, WebSocket — функцией `ws_has_module`. Переменная `SFERA_MODULES_ENFORCE=0` отключает проверку, и тогда все развёрнутые модули считаются установленными.

### Фронтенд

Модуль импортирует только из `@sfera/sdk` (`src/sdk/index.ts`). В `setup(ctx)` он регистрирует:
- **слоты интерфейса:** `nav.rail`, `nav.railScroll`, `rail.addAction`, `main.view`, `settings.page`, `explore.card`, `explore.search`, `chat.composerAction`, `profile.section`, `sidebar.userPanel`, `picker.stickers`, `app.overlay`, `app.provider`;
- **подписки на события:** `ctx.onWs('signaling', 'module:<event>', …)`;
- **хуки жизненного цикла:** `ctx.onLifecycle('logout' | 'callStart' | 'mute' | 'deafen' …)`;
- **переводы:** `ctx.strings(...)`.

Маршрут модуля записывается в `currentServer` как `<id>:<что-угодно>`, например `diary:<uuid>`.

## Разработка и деплой

```bash
node scripts/modules/fetch.mjs            # закреплённые версии из modules.lock.json
node scripts/modules/fetch.mjs --dev      # ветки модулей (attached) — чтобы коммитить в модуль
node scripts/modules/fetch.mjs --update   # закрепить текущие головы веток в modules.lock.json
```

`modules/` в `main` игнорируется: каждый модуль — это git worktree своей ветки.

**Выпуск новой версии модуля:**
1. Коммит в ветку `module/<id>`.
2. `node scripts/modules/fetch.mjs --update`.
3. Коммит `modules.lock.json` в `main`.

Деплой (`scripts/linux/start-common.sh`) сначала подтягивает модули по lock-файлу, потом ставит зависимости, мигрирует и собирает фронт.

**Ядро без модулей обязано собираться и проходить проверки.** CI в `main` проверяет это отдельной job.

## Мониторинг и выбор при установке

Grafana и Prometheus получают конфигурацию из `django-server/monitoring/generated/`. Эту папку собирает `node scripts/modules/monitoring.mjs` из ядра (`django-server/monitoring`) и из `modules/<id>/monitoring` каждого развёрнутого модуля. Модуль, который не развёрнут, не даёт ни дашбордов, ни алертов.

Переменные деплоя (`/etc/sfera/deploy.env` или repo variables в GitHub):

| Переменная | Что делает |
|---|---|
| `SFERA_MODULES=servers,channels` | ставит только эти модули, остальные worktree удаляются; `none` — ядро без модулей |
| `SFERA_MONITORING_EXCLUDE=diary,core` | не ставит дашборды и алерты этих модулей (`core` — дашборды ядра) |
| `SFERA_MONITORING=0` | не поднимает Prometheus, Grafana и Alertmanager вовсе |
| `"monitoring": false` в `modules.lock.json` | постоянно исключает мониторинг модуля |

Данные модулей при этом не трогаются: исключённый из деплоя модуль просто не загружается, его таблицы остаются в базе.
