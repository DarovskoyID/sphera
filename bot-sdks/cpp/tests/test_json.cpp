// Тесты разбора JSON и вспомогательных функций SDK.
// Сеть не трогаем: проверяется то, что ломается молча.

#include <cassert>
#include <iostream>

#include <sfera/bot.hpp>
#include <sfera/json.hpp>

int main() {
    using sfera::Json;

    const std::string payload = R"({
        "updates": [
            {
                "id": 7,
                "type": "command",
                "chat_id": "abc",
                "chat_type": "dm",
                "command": "start",
                "args": "now",
                "message": {
                    "id": "m1",
                    "content": "/start now",
                    "from": {"id": "u1", "nickname": "Аня", "username": "anya"}
                }
            }
        ]
    })";

    Json root = Json::parse(payload);
    assert(root["updates"].size() == 1);
    const Json& update = *root["updates"].items()[0];
    assert(update["id"].as_int() == 7);
    assert(update["command"].as_string() == "start");
    assert(update["message"]["from"]["nickname"].as_string() == "Аня");
    // Отсутствующее поле — Null, а не падение.
    assert(update["nope"].is_null());
    assert(update["nope"]["deeper"].as_string().empty());

    assert(Json::quote("a\"b\n").find("\\\"") != std::string::npos);
    assert(sfera::contains_ci("Weather TODAY", "today"));
    assert(sfera::contains_ci("anything", ""));
    // Регистр складывается только для ASCII; кириллица сравнивается как есть.
    assert(sfera::contains_ci("Погода сегодня", "сегодня"));

    std::cout << "все проверки пройдены" << std::endl;
    return 0;
}
