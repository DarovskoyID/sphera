// Официальная библиотека ботов Сферы для C++17.
//
//     #include <sfera/bot.hpp>
//
//     int main() {
//         sfera::Bot bot = sfera::Bot::from_env();
//         bot.command("start", "Запустить бота", [](sfera::Bot& bot, const sfera::Update& update) {
//             bot.send(update.chat_id, "Привет, " + update.user + "!");
//         });
//         bot.run();
//     }
//
// Транспорт — libcurl. Протокол тот же, что у SDK для Python и Rust: ключ в
// заголовке `Authorization: Bot <token>`, длинный опрос с подтверждением через
// `offset`, отправка через `POST /api/bots/api/send/`.

#pragma once

#include <functional>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

#include "json.hpp"

namespace sfera {

constexpr const char* kVersion = "1.0.0";
constexpr const char* kDefaultServer = "https://start-ionik.ru";
constexpr long kLongPollSeconds = 30;

/// Ошибка обращения к Bot API. `auth` означает отозванный или неверный ключ —
/// повторять такой запрос бессмысленно.
class BotError : public std::runtime_error {
public:
    BotError(const std::string& message, bool auth = false)
        : std::runtime_error(message), auth_(auth) {}
    bool is_auth() const { return auth_; }

private:
    bool auth_;
};

struct Command {
    std::string command;
    std::string description;
};

/// Место, где присутствует бот.
struct Chat {
    std::string chat_id;
    std::string chat_type;  // "dm" | "channel"
    std::string name;
    std::string guild_id;
    std::string guild_name;
};

/// Входящее событие.
struct Update {
    long long id = 0;
    std::string type;
    std::string chat_id;
    std::string chat_type = "dm";
    std::string text;
    std::string user;
    std::string user_id;
    std::string message_id;
    std::string command;
    std::string args;
    std::string guild_id;

    bool is_command() const { return !command.empty(); }
    bool is_direct() const { return chat_type == "dm"; }
};

class Bot;
using Handler = std::function<void(Bot&, const Update&)>;

/// Поиск подстроки без учёта регистра (ASCII) — используется узлом «Условие».
bool contains_ci(const std::string& haystack, const std::string& needle);

class Bot {
public:
    Bot(const std::string& token, const std::string& server);

    /// Ключ из `SFERA_BOT_TOKEN`, адрес из `SFERA_SERVER`.
    static Bot from_env();

    // ── регистрация ─────────────────────────────────────────────────────
    Bot& command(const std::string& name, const std::string& description, Handler handler);
    /// Обработчик обычных сообщений. Пустая подстрока — любое сообщение.
    Bot& on_message(const std::string& contains, Handler handler);

    // ── действия ────────────────────────────────────────────────────────
    Json me();
    std::vector<Chat> chats();
    Json send(const std::string& chat_id, const std::string& text, const std::string& reply_to = "");
    Json reply(const Update& update, const std::string& text);
    /// Опубликовать команды — их показывает кнопка команд у поля ввода.
    Json set_commands();
    /// GET наружу — используется узлом «HTTP-запрос» нодового редактора.
    std::string http_get(const std::string& url);

    // ── цикл ────────────────────────────────────────────────────────────
    std::vector<Update> poll();
    void dispatch(const Update& update);
    /// Блокирующий цикл: публикует команды и обслуживает обновления.
    void run();
    void stop() { running_ = false; }

    const std::string& server() const { return server_; }

private:
    std::string token_;
    std::string server_;
    long long offset_ = 0;
    long timeout_ = kLongPollSeconds;
    bool running_ = false;
    std::vector<Command> commands_;
    std::map<std::string, Handler> command_handlers_;
    std::vector<std::pair<std::string, Handler>> message_handlers_;

    Json request(const std::string& method, const std::string& path, const std::string& body = "");
};

}  // namespace sfera
