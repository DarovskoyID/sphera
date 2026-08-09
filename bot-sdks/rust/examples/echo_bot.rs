//! Простейший бот: отвечает на /start и повторяет обычные сообщения.
//!
//!     export SFERA_BOT_TOKEN=sfb_…
//!     cargo run --example echo_bot

use sfera_bot::{Bot, Result, Update};

fn start(bot: &Bot, update: &Update) -> Result<()> {
    bot.send(&update.chat_id, &format!("Привет, {}! Напишите что-нибудь — я повторю.", update.user))?;
    Ok(())
}

fn ping(bot: &Bot, update: &Update) -> Result<()> {
    bot.reply(update, "pong")?;
    Ok(())
}

fn echo(bot: &Bot, update: &Update) -> Result<()> {
    bot.send(&update.chat_id, &update.text)?;
    Ok(())
}

fn main() -> Result<()> {
    let mut bot = Bot::from_env()?;
    bot.command("start", "Запустить бота", start);
    bot.command("ping", "Проверить, жив ли бот", ping);
    bot.on_message("", echo);
    bot.run()
}
