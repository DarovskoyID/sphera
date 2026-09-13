"""Простейший бот: отвечает на /start и повторяет обычные сообщения.

    export SFERA_BOT_TOKEN=sfb_…
    python examples/echo_bot.py
"""

import logging

from sfera_bot import Bot, Update

logging.basicConfig(level=logging.INFO)

bot = Bot()  # ключ и сервер берутся из SFERA_BOT_TOKEN / SFERA_SERVER


@bot.command('start', 'Запустить бота')
def start(bot: Bot, update: Update) -> None:
    bot.send(update.chat_id, f'Привет, {update.user}! Напишите что-нибудь — я повторю.')


@bot.command('ping', 'Проверить, жив ли бот')
def ping(bot: Bot, update: Update) -> None:
    bot.reply(update, 'pong')


@bot.on_message()
def echo(bot: Bot, update: Update) -> None:
    bot.send(update.chat_id, update.text)


if __name__ == '__main__':
    bot.run()
