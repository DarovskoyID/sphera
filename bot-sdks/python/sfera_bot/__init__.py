"""Официальная библиотека ботов Сферы.

    from sfera_bot import Bot

    bot = Bot(token="sfb_…", server="https://start-ionik.ru")

    @bot.command("start", "Запустить бота")
    def start(bot, update):
        bot.send(update.chat_id, f"Привет, {update.user}!")

    bot.run()
"""

from .client import Bot, BotError, Chat, Command, Update, __version__

__all__ = ['Bot', 'BotError', 'Chat', 'Command', 'Update', '__version__']
