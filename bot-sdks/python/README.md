# sfera-bot (Python)

Официальная библиотека ботов Сферы. Без зависимостей, Python 3.9+.

## Установка

```bash
pip install ./bot-sdks/python
```

## Ключ

Ключ выдаёт бот **Сфероник** (Исследовать Сферу → Инструменты от разработчика):
отправьте ему `/newbot`. Ключ показывается один раз; новый выпускается
командой `/token <имя_бота>`, старый при этом отзывается.

Библиотека читает ключ из `SFERA_BOT_TOKEN`, адрес сервера — из `SFERA_SERVER`
(по умолчанию `https://start-ionik.ru`).

## Пример

```python
from sfera_bot import Bot, Update

bot = Bot()

@bot.command("start", "Запустить бота")
def start(bot: Bot, update: Update) -> None:
    bot.send(update.chat_id, f"Привет, {update.user}!")

@bot.on_message("погода")
def weather(bot: Bot, update: Update) -> None:
    bot.reply(update, "За окном ясно")

bot.run()
```

`bot.run()` публикует список команд (он же показывается в кнопке команд рядом
с полем ввода) и входит в цикл длинного опроса.

## API

| Метод | Назначение |
|---|---|
| `Bot(token, server)` | клиент; без аргументов читает переменные окружения |
| `@bot.command(name, description)` | обработчик `/name` |
| `@bot.on_message(contains="")` | обработчик обычных сообщений |
| `bot.send(chat_id, text, reply_to="")` | отправить сообщение |
| `bot.reply(update, text)` | ответить цитатой |
| `bot.edit(message_id, text)` | переписать своё сообщение |
| `bot.delete(message_id)` | удалить своё сообщение |
| `bot.set_commands([...])` | опубликовать команды вручную |
| `bot.chats()` | где бот присутствует (ЛС и каналы серверов) |
| `bot.poll(timeout)` / `bot.dispatch(update)` | свой цикл вместо `run()` |
| `bot.http_get(url)` | GET наружу (узел «HTTP-запрос» редактора) |

`Update` содержит `chat_id`, `chat_type` (`dm` / `channel`), `text`, `command`,
`args`, `user`, `user_id`, `message_id`, `guild_id`.

## Что нужно знать

* Бот попадает на сервер, когда владелец добавляет его туда; в ЛС он доступен
  сразу после создания.
* Сообщения бота проходят те же фильтры контента, что и сообщения людей.
* `/deletebot` у Сфероника отзывает ключ — переписки с ботом остаются.
