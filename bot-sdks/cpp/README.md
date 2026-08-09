# sfera-bot (C++17)

Официальная библиотека ботов Сферы. Единственная зависимость — libcurl
(JSON разбирается встроенным парсером).

## Сборка

```bash
cmake -B build -DSFERA_BOT_BUILD_EXAMPLES=ON -DSFERA_BOT_BUILD_TESTS=ON
cmake --build build
ctest --test-dir build
```

Подключение из своего проекта:

```cmake
add_subdirectory(bot-sdks/cpp sfera_bot_sdk)
target_link_libraries(my_bot PRIVATE sfera_bot)
```

## Ключ

Ключ выдаёт бот **Сфероник** (Исследовать Сферу → Инструменты от разработчика),
команда `/newbot`. `sfera::Bot::from_env()` читает `SFERA_BOT_TOKEN`, адрес
сервера — `SFERA_SERVER` (по умолчанию `https://start-ionik.ru`).

## Пример

```cpp
#include <sfera/bot.hpp>

int main() {
    sfera::Bot bot = sfera::Bot::from_env();

    bot.command("start", "Запустить бота", [](sfera::Bot& bot, const sfera::Update& update) {
        bot.send(update.chat_id, "Привет, " + update.user + "!");
    });

    bot.run();
}
```

`run()` публикует команды (их показывает кнопка команд рядом с полем ввода) и
входит в цикл длинного опроса: сетевые сбои переживает с нарастающей паузой,
на отозванном ключе бросает `BotError` с `is_auth() == true`.

## API

| Метод | Назначение |
|---|---|
| `Bot(token, server)` / `Bot::from_env()` | клиент |
| `bot.command(name, description, handler)` | обработчик `/name` |
| `bot.on_message(contains, handler)` | обработчик обычных сообщений |
| `bot.send(chat_id, text, reply_to = "")` | отправка |
| `bot.reply(update, text)` | ответ цитатой |
| `bot.edit(message_id, text)` / `bot.remove(message_id)` | правка и удаление своих сообщений |
| `bot.set_commands()` | опубликовать команды вручную |
| `bot.chats()` | где бот присутствует |
| `bot.poll()` / `bot.dispatch(update)` | свой цикл вместо `run()` |
| `bot.http_get(url)` | GET наружу (узел «HTTP-запрос» редактора) |

Обработчик — `std::function<void(sfera::Bot&, const sfera::Update&)>`.
`sfera::contains_ci` складывает регистр только для ASCII.
