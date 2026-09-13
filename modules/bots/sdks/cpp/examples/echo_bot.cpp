// Простейший бот: отвечает на /start и повторяет обычные сообщения.
//
//     cmake -B build -DSFERA_BOT_BUILD_EXAMPLES=ON && cmake --build build
//     SFERA_BOT_TOKEN=sfb_… ./build/echo_bot

#include <iostream>

#include <sfera/bot.hpp>

int main() {
    try {
        sfera::Bot bot = sfera::Bot::from_env();

        bot.command("start", "Запустить бота", [](sfera::Bot& bot, const sfera::Update& update) {
            bot.send(update.chat_id, "Привет, " + update.user + "! Напишите что-нибудь — я повторю.");
        });
        bot.command("ping", "Проверить, жив ли бот", [](sfera::Bot& bot, const sfera::Update& update) {
            bot.reply(update, "pong");
        });
        bot.on_message("", [](sfera::Bot& bot, const sfera::Update& update) {
            bot.send(update.chat_id, update.text);
        });

        bot.run();
    } catch (const sfera::BotError& error) {
        std::cerr << "бот остановлен: " << error.what() << std::endl;
        return 1;
    }
    return 0;
}
