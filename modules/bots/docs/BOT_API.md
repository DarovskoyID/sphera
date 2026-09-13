# Bot API Сферы — справочник

Публичный HTTP-интерфейс для программ, которые работают от имени бота.

* **База:** `https://start-ionik.ru`
* **Аутентификация:** `Authorization: Bot <ключ>` (или `X-Bot-Token: <ключ>`)
* **Формат:** JSON в обе стороны, кроме загрузки файла (`multipart/form-data`)
  и скачивания (сырые байты)
* **Заголовок `X-Ionik-Client` не нужен** — на `/api/bots/api/` он не
  требуется, это и есть точка входа для сторонних клиентов

Ключ выдаёт [Сфероник](BOTS.md#сфероник) командой `/newbot`. Он показывается
один раз; потерянный ключ перевыпускается через `/token <бот>`, старый при этом
отзывается немедленно.

Готовые библиотеки для Python, Rust и C++ — в [`sdks/`](../sdks).

---

## Оглавление

* [Кто я — `/me/`](#get-apibotsapime)
* [Где я — `/chats/`](#get-apibotsapichats)
* [Команды — `/commands/`](#post-apibotsapicommands)
* [Обновления — `/updates/`](#get-apibotsapiupdates)
* [Отправка — `/send/`](#post-apibotsapisend)
* [Правка — `/edit/`](#post-apibotsapiedit)
* [Удаление — `/delete/`](#post-apibotsapidelete)
* [Загрузка файла — `/upload/`](#post-apibotsapiupload)
* [Скачивание файла — `/file/<id>/`](#get-apibotsapifileid)
* [История — `/history/`](#get-apibotsapihistory)
* [Участники — `/members/`](#get-apibotsapimembers)
* [Реакции — `/react/`](#post-apibotsapireact)
* [Ошибки](#ошибки)
* [Ограничения](#ограничения)

---

## Объекты

### Пользователь

```json
{
  "id": "9f1c…",
  "username": "bob",
  "nickname": "Боб",
  "avatar": "/media/avatars/…",
  "status": "online",
  "account_type": "user"
}
```

`account_type` — `user`, `bot` или `admin`.

### Вложение

```json
{
  "id": "3ac0…",
  "filename": "cat.png",
  "content_type": "image/png",
  "file_size": 20481,
  "url": "/api/bots/api/file/3ac0…/"
}
```

`url` — относительный путь; чтобы скачать, допишите его к адресу сервера и
приложите тот же заголовок `Authorization`.

### Чат

Чат — это либо личный диалог (`dm`), либо текстовый канал сервера (`channel`).
Везде, где встречается `chat_id`, подходит и тот и другой: бот может писать
только туда, где он состоит.

---

## `GET /api/bots/api/me/`

Профиль бота. Обычно первый вызов — проверить, что ключ жив.

```bash
curl https://start-ionik.ru/api/bots/api/me/ -H "Authorization: Bot $SFERA_BOT_TOKEN"
```

```json
{
  "id": "1b2c…", "user_id": "44de…", "username": "weather_bot",
  "display_name": "Погода", "description": "", "avatar": "",
  "commands": [{"command": "start", "description": "Запустить"}],
  "token_prefix": "sfb_ab12", "is_active": true, "is_system": false,
  "created_at": "2026-08-12T09:00:00+00:00", "owner_id": "0f7a…"
}
```

## `GET /api/bots/api/chats/`

Где бот присутствует прямо сейчас.

```json
{"chats": [
  {"chat_id": "aa11…", "chat_type": "dm", "peer": {"username": "bob", "…": "…"}},
  {"chat_id": "bb22…", "chat_type": "channel", "name": "general",
   "guild_id": "cc33…", "guild_name": "Клуб"}
]}
```

## `POST /api/bots/api/commands/`

Опубликовать список команд — именно он показывается в кнопке рядом с полем
ввода у всех, кто общается с ботом.

```json
{"commands": [{"command": "start", "description": "Запустить"},
              {"command": "help",  "description": "Справка"}]}
```

Принимается и простой текст в поле `commands` — по строке на команду в формате
`команда - описание`. Ответ: `{"ok": true, "commands": [...]}`.

## `GET /api/bots/api/updates/`

Длинный опрос входящих событий. Основной цикл бота.

| Параметр | По умолчанию | Что делает |
|---|---|---|
| `offset` | `0` | id последнего обработанного обновления: всё до него включительно удаляется на сервере |
| `timeout` | `0` | сколько секунд ждать на пустой очереди, максимум 45 |
| `limit` | `50` | сколько обновлений вернуть за раз, максимум 100 |

```bash
curl "https://start-ionik.ru/api/bots/api/updates/?offset=41&timeout=30" \
  -H "Authorization: Bot $SFERA_BOT_TOKEN"
```

```json
{"updates": [{
  "id": 42,
  "type": "command",
  "created_at": "2026-08-12T09:15:02+00:00",
  "chat_type": "dm",
  "chat_id": "aa11…",
  "command": "start",
  "args": "сейчас",
  "message": {
    "id": "77ff…",
    "content": "/start сейчас",
    "created_at": "2026-08-12T09:15:02+00:00",
    "from": {"id": "9f1c…", "username": "bob", "…": "…"},
    "attachments": []
  }
}]}
```

`type` — `command`, когда текст начинается со слэша, иначе `message`. Поля
`command` и `args` есть только у команд. В канале дополнительно приходит
`guild_id`.

**Подтверждение обязательно.** Пока вы не передали `offset`, те же события
будут приходить снова. Обычный цикл: опросить → обработать → следующий опрос с
`offset`, равным наибольшему полученному `id`.

## `POST /api/bots/api/send/`

Отправить сообщение. Нужен либо `text`, либо `attachment_ids` — можно и то и
другое (подпись к фото).

| Поле | Обязательно | Что это |
|---|---|---|
| `chat_id` | да | куда писать |
| `text` | — | до 4000 символов |
| `attachment_ids` | — | список id из `/upload/`, до 15 штук |
| `reply_to` | — | id сообщения, которое цитируем |

```bash
curl -X POST https://start-ionik.ru/api/bots/api/send/ \
  -H "Authorization: Bot $SFERA_BOT_TOKEN" -H "Content-Type: application/json" \
  -d '{"chat_id":"aa11…","text":"привет","reply_to":"77ff…"}'
```

`201` и само сообщение в ответе — с `id`, автором, временем и вложениями.

## `POST /api/bots/api/edit/`

`{"message_id": "…", "text": "новый текст"}` — переписать своё сообщение.
Чужое переписать нельзя: `404`.

## `POST /api/bots/api/delete/`

`{"message_id": "…"}` — удалить своё сообщение. `204` при успехе.

## `POST /api/bots/api/upload/`

Положить файл в чат, ничего пока не отправляя. `multipart/form-data`:

| Поле | Что это |
|---|---|
| `chat_id` | чат, для которого файл предназначен |
| `file` | сам файл |

```bash
curl -X POST https://start-ionik.ru/api/bots/api/upload/ \
  -H "Authorization: Bot $SFERA_BOT_TOKEN" \
  -F chat_id=aa11… -F file=@cat.png
```

`201` и объект вложения. Его `id` передаётся в `/send/`.

Загрузка и отправка разделены намеренно: так одно сообщение может нести
несколько файлов, а сам `/send/` остаётся обычным JSON. Файл привязан к чату,
для которого загружен, и отправляется ровно один раз — повторная попытка даёт
`400`.

## `GET /api/bots/api/file/<id>/`

Скачать вложение из чата, где бот состоит. Возвращает сырые байты с исходным
`Content-Type`. Так бот читает и то, что прислали ему.

```bash
curl https://start-ionik.ru/api/bots/api/file/3ac0…/ \
  -H "Authorization: Bot $SFERA_BOT_TOKEN" -o cat.png
```

## `GET /api/bots/api/history/`

Прочитать чат назад. В отличие от `/updates/`, ничего не подтверждает и не
удаляет: это для ботов, которым нужен контекст, а не живая лента.

| Параметр | По умолчанию | Что делает |
|---|---|---|
| `chat_id` | — | обязательный |
| `limit` | `50` | сколько сообщений, максимум 200 |
| `before` | — | id сообщения; вернутся только те, что старше него |

```json
{"chat_id": "aa11…", "chat_type": "dm", "messages": [
  {"id": "77ff…", "content": "первое", "created_at": "…",
   "edited": false, "from": {"…": "…"}, "attachments": []}
]}
```

Сообщения идут **от старых к новым**. Чтобы листать вглубь, передавайте в
`before` id первого сообщения предыдущей страницы. Неизвестный `before` не
ошибка — просто вернётся пустой список.

## `GET /api/bots/api/members/`

`?chat_id=` — кто в чате. У личного диалога это две стороны, у канала — все
участники сервера, и у каждого дополнительно есть `role`
(`owner` / `admin` / `member`).

## `POST /api/bots/api/react/`

Поставить или снять реакцию.

| Поле | Что это |
|---|---|
| `message_id` | сообщение в канале |
| `emoji` | сама реакция |
| `remove` | `true`, чтобы снять |

```json
{"message_id": "88aa…", "reactions": [{"emoji": "👍", "count": 3, "reacted": true}]}
```

Только каналы: у личных сообщений реакций нет — на такой запрос придёт `404`.
Как и у человека, у бота не больше трёх разных реакций на одно сообщение.

---

## Ошибки

Тело ошибки всегда `{"error": "…"}`.

| Код | Когда |
|---|---|
| `400` | не хватает поля, кривой id, текст длиннее 4000, вложение уже отправлено |
| `401` | ключ неверен или отозван |
| `403` | действие не разрешено этому боту |
| `404` | чата, сообщения или файла нет — либо бот к ним не имеет доступа |
| `409` | упёрлись в лимит (например, три реакции на сообщение) |

`404` намеренно не различает «не существует» и «не ваше»: иначе перебором id
можно было бы выяснить, что в системе есть.

## Ограничения

* до 20 активных ботов на аккаунт;
* сообщение — не длиннее 4000 символов;
* до 15 вложений на сообщение, файл — до 50 МБ;
* исполняемые типы файлов (`.exe`, `.bat`, `.js`, `.svg`, …) отклоняются;
* `/updates/` ждёт не дольше 45 секунд;
* бот не может писать в чат, участником которого он не является;
* бот не запускает другого бота: сообщения от аккаунтов с `account_type=bot`
  в очередь обновлений не попадают;
* в канале с несколькими ботами команда адресуется конкретному:
  `/help@my_bot`.

## Минимальный бот на голом HTTP

```bash
#!/usr/bin/env bash
OFFSET=0
while true; do
  BATCH=$(curl -s "https://start-ionik.ru/api/bots/api/updates/?offset=$OFFSET&timeout=30" \
    -H "Authorization: Bot $SFERA_BOT_TOKEN")
  echo "$BATCH" | jq -c '.updates[]' | while read -r U; do
    CHAT=$(echo "$U" | jq -r .chat_id)
    curl -s -X POST https://start-ionik.ru/api/bots/api/send/ \
      -H "Authorization: Bot $SFERA_BOT_TOKEN" -H "Content-Type: application/json" \
      -d "{\"chat_id\":\"$CHAT\",\"text\":\"эхо\"}" > /dev/null
  done
  NEW=$(echo "$BATCH" | jq -r '[.updates[].id] | max // empty')
  [ -n "$NEW" ] && OFFSET=$NEW
done
```

То же самое на Python — четыре строки, см. [`sdks/python`](../sdks/python).
