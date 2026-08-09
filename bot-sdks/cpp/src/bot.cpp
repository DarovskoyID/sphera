#include "sfera/bot.hpp"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <thread>

#include <curl/curl.h>

namespace sfera {
namespace {

constexpr long kMaxBackoffSeconds = 30;

size_t write_callback(char* data, size_t size, size_t count, void* userdata) {
    static_cast<std::string*>(userdata)->append(data, size * count);
    return size * count;
}

std::string normalize_command(const std::string& raw) {
    std::string out;
    for (char c : raw) {
        if (c == '/' && out.empty()) continue;
        char lower = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        if ((lower >= 'a' && lower <= 'z') || (lower >= '0' && lower <= '9') || lower == '_') {
            out += lower;
        }
    }
    return out;
}

std::string to_lower(const std::string& text) {
    std::string out = text;
    std::transform(out.begin(), out.end(), out.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return out;
}

std::string env_or(const char* name, const std::string& fallback) {
    const char* value = std::getenv(name);
    return (value && *value) ? std::string(value) : fallback;
}

Update update_from_json(const Json& item) {
    const Json& message = item["message"];
    const Json& author = message["from"];
    Update update;
    update.id = item["id"].as_int();
    update.type = item["type"].as_string();
    update.chat_id = item["chat_id"].as_string();
    if (!item["chat_type"].as_string().empty()) update.chat_type = item["chat_type"].as_string();
    update.text = message["content"].as_string();
    update.user = author["nickname"].as_string();
    if (update.user.empty()) update.user = author["username"].as_string();
    update.user_id = author["id"].as_string();
    update.message_id = message["id"].as_string();
    update.command = item["command"].as_string();
    update.args = item["args"].as_string();
    update.guild_id = item["guild_id"].as_string();
    return update;
}

}  // namespace

bool contains_ci(const std::string& haystack, const std::string& needle) {
    if (needle.empty()) return true;
    return to_lower(haystack).find(to_lower(needle)) != std::string::npos;
}

Bot::Bot(const std::string& token, const std::string& server)
    : token_(token), server_(server.empty() ? kDefaultServer : server) {
    while (!server_.empty() && server_.back() == '/') server_.pop_back();
    if (token_.empty()) {
        throw BotError("нужен ключ бота: аргумент token или переменная SFERA_BOT_TOKEN", true);
    }
    curl_global_init(CURL_GLOBAL_DEFAULT);
}

Bot Bot::from_env() {
    return Bot(env_or("SFERA_BOT_TOKEN", ""), env_or("SFERA_SERVER", kDefaultServer));
}

Bot& Bot::command(const std::string& name, const std::string& description, Handler handler) {
    const std::string key = normalize_command(name);
    commands_.push_back(Command{key, description});
    command_handlers_[key] = std::move(handler);
    return *this;
}

Bot& Bot::on_message(const std::string& contains, Handler handler) {
    message_handlers_.emplace_back(to_lower(contains), std::move(handler));
    return *this;
}

Json Bot::me() {
    return request("GET", "/api/bots/api/me/");
}

std::vector<Chat> Bot::chats() {
    Json payload = request("GET", "/api/bots/api/chats/");
    std::vector<Chat> chats;
    for (const auto& item : payload["chats"].items()) {
        chats.push_back(Chat{
            (*item)["chat_id"].as_string(),
            (*item)["chat_type"].as_string(),
            (*item)["name"].as_string(),
            (*item)["guild_id"].as_string(),
            (*item)["guild_name"].as_string(),
        });
    }
    return chats;
}

Json Bot::send(const std::string& chat_id, const std::string& text, const std::string& reply_to) {
    std::ostringstream body;
    body << "{\"chat_id\":" << Json::quote(chat_id) << ",\"text\":" << Json::quote(text);
    if (!reply_to.empty()) body << ",\"reply_to\":" << Json::quote(reply_to);
    body << "}";
    return request("POST", "/api/bots/api/send/", body.str());
}

Json Bot::reply(const Update& update, const std::string& text) {
    return send(update.chat_id, text, update.message_id);
}

Json Bot::edit(const std::string& message_id, const std::string& text) {
    std::ostringstream body;
    body << "{\"message_id\":" << Json::quote(message_id)
         << ",\"text\":" << Json::quote(text) << "}";
    return request("POST", "/api/bots/api/edit/", body.str());
}

void Bot::remove(const std::string& message_id) {
    std::ostringstream body;
    body << "{\"message_id\":" << Json::quote(message_id) << "}";
    request("POST", "/api/bots/api/delete/", body.str());
}

Json Bot::set_commands() {
    std::ostringstream body;
    body << "{\"commands\":[";
    for (size_t i = 0; i < commands_.size(); ++i) {
        if (i) body << ',';
        body << "{\"command\":" << Json::quote(commands_[i].command)
             << ",\"description\":" << Json::quote(commands_[i].description) << '}';
    }
    body << "]}";
    return request("POST", "/api/bots/api/commands/", body.str());
}

std::string Bot::http_get(const std::string& url) {
    CURL* curl = curl_easy_init();
    if (!curl) throw BotError("не удалось инициализировать libcurl");
    std::string response;
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 20L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, (std::string("sfera-bot/") + kVersion).c_str());
    CURLcode code = curl_easy_perform(curl);
    curl_easy_cleanup(curl);
    if (code != CURLE_OK) throw BotError(std::string("сеть недоступна: ") + curl_easy_strerror(code));
    // Обрезаем перевод строки, чтобы значение было пригодно для подстановки.
    while (!response.empty() && (response.back() == '\n' || response.back() == '\r' || response.back() == ' ')) {
        response.pop_back();
    }
    return response;
}

std::vector<Update> Bot::poll() {
    std::ostringstream path;
    path << "/api/bots/api/updates/?offset=" << offset_ << "&timeout=" << timeout_;
    Json payload = request("GET", path.str());
    std::vector<Update> updates;
    for (const auto& item : payload["updates"].items()) {
        updates.push_back(update_from_json(*item));
    }
    for (const Update& update : updates) offset_ = std::max(offset_, update.id);
    return updates;
}

void Bot::dispatch(const Update& update) {
    if (update.is_command()) {
        auto it = command_handlers_.find(normalize_command(update.command));
        if (it != command_handlers_.end()) it->second(*this, update);
        return;
    }
    const std::string text = to_lower(update.text);
    for (const auto& entry : message_handlers_) {
        if (entry.first.empty() || text.find(entry.first) != std::string::npos) {
            entry.second(*this, update);
        }
    }
}

void Bot::run() {
    if (!commands_.empty()) {
        try {
            set_commands();
        } catch (const BotError& error) {
            std::cerr << "не удалось опубликовать команды: " << error.what() << std::endl;
        }
    }
    running_ = true;
    long backoff = 1;
    while (running_) {
        try {
            for (const Update& update : poll()) {
                try {
                    dispatch(update);
                } catch (const std::exception& error) {
                    // Ошибка обработчика не должна ронять бота.
                    std::cerr << "обработчик упал на обновлении " << update.id
                              << ": " << error.what() << std::endl;
                }
            }
            backoff = 1;
        } catch (const BotError& error) {
            if (error.is_auth()) throw;
            std::cerr << "опрос не удался (" << error.what() << "), повтор через "
                      << backoff << " с" << std::endl;
            std::this_thread::sleep_for(std::chrono::seconds(backoff));
            backoff = std::min(backoff * 2, kMaxBackoffSeconds);
        }
    }
}

Json Bot::request(const std::string& method, const std::string& path, const std::string& body) {
    CURL* curl = curl_easy_init();
    if (!curl) throw BotError("не удалось инициализировать libcurl");

    const std::string url = server_ + path;
    std::string response;
    curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, ("Authorization: Bot " + token_).c_str());
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "X-Ionik-Client: 1");

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, (std::string("sfera-bot/") + kVersion).c_str());
    // Длинный опрос держит соединение до timeout: даём запас сверху.
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, timeout_ + 15);
    if (method == "POST") {
        curl_easy_setopt(curl, CURLOPT_POST, 1L);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(body.size()));
    } else if (method != "GET") {
        curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, method.c_str());
    }

    CURLcode code = curl_easy_perform(curl);
    long status = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (code != CURLE_OK) {
        throw BotError(std::string("сеть недоступна: ") + curl_easy_strerror(code));
    }
    if (status == 401) {
        throw BotError("ключ отозван или неверен", true);
    }
    if (status >= 400) {
        throw BotError("HTTP " + std::to_string(status) + ": " + response.substr(0, 300));
    }
    if (response.empty()) return Json();
    try {
        return Json::parse(response);
    } catch (const std::exception& error) {
        throw BotError(std::string("сервер вернул не JSON: ") + error.what());
    }
}

}  // namespace sfera
