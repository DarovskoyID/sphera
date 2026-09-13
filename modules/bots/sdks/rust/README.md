# sfera-bot (Rust)

Официальная библиотека ботов Сферы.

## Подключение

```toml
[dependencies]
sfera-bot = { path = "../sdks/rust" }
```

## Ключ

Ключ выдаёт бот **Сфероник** (Исследовать Сферу → Инструменты от разработчика),
команда `/newbot`. `Bot::from_env()` читает `SFERA_BOT_TOKEN`, адрес сервера —
`SFERA_SERVER` (по умолчанию `https://start-ionik.ru`).

## Пример

```rust
use sfera_bot::{Bot, Result, Update};

fn start(bot: &Bot, update: &Update) -> Result<()> {
    bot.send(&update.chat_id, &format!("Привет, {}!", update.user))?;
    Ok(())
}

fn main() -> Result<()> {
    let mut bot = Bot::from_env()?;
    bot.command("start", "Запустить бота", start);
    bot.run()
}
```

`run()` публикует команды (их же показывает кнопка команд рядом с полем ввода)
и входит в цикл длинного опроса; сетевые сбои переживает с нарастающей паузой,
неверный ключ — завершает работу с `Error::Auth`.

## API

| Метод | Назначение |
|---|---|
| `Bot::new(token, server)` / `Bot::from_env()` | клиент |
| `bot.command(name, description, handler)` | обработчик `/name` |
| `bot.on_message(contains, handler)` | обработчик обычных сообщений |
| `bot.send(chat_id, text)` / `bot.reply(&update, text)` | отправка |
| `bot.edit(message_id, text)` / `bot.delete(message_id)` | правка и удаление своих сообщений |
| `bot.set_commands()` | опубликовать команды вручную |
| `bot.chats()` | где бот присутствует |
| `bot.poll()` / `bot.dispatch(&update)` | свой цикл вместо `run()` |
| `bot.http_get(url)` | GET наружу (узел «HTTP-запрос» редактора) |

Обработчик — `fn(&Bot, &Update) -> Result<()>`.

## Тесты

```bash
cargo test
```
