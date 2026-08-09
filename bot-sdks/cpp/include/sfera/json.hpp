// Минимальный JSON для Bot API Сферы.
//
// Полноценная библиотека здесь не нужна: ответы сервера — это объекты с
// строками, числами, массивами и вложенными объектами. Свой разбор избавляет
// от внешней зависимости, из-за которой сборку бота пришлось бы настраивать.

#pragma once

#include <cctype>
#include <cstdint>
#include <map>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace sfera {

class Json {
public:
    enum class Type { Null, Bool, Number, String, Array, Object };

    Json() : type_(Type::Null) {}

    static Json parse(const std::string& text) {
        size_t pos = 0;
        Json value = parse_value(text, pos);
        skip_space(text, pos);
        return value;
    }

    Type type() const { return type_; }
    bool is_null() const { return type_ == Type::Null; }

    /// Строковое значение; для чисел и bool — их текстовая форма.
    std::string as_string() const {
        switch (type_) {
            case Type::String: return string_;
            case Type::Number: {
                std::ostringstream out;
                if (number_ == static_cast<int64_t>(number_)) out << static_cast<int64_t>(number_);
                else out << number_;
                return out.str();
            }
            case Type::Bool: return bool_ ? "true" : "false";
            default: return std::string();
        }
    }

    int64_t as_int(int64_t fallback = 0) const {
        if (type_ == Type::Number) return static_cast<int64_t>(number_);
        if (type_ == Type::String) {
            try { return std::stoll(string_); } catch (...) { return fallback; }
        }
        return fallback;
    }

    bool as_bool(bool fallback = false) const {
        return type_ == Type::Bool ? bool_ : fallback;
    }

    /// Поле объекта. Отсутствующее поле — Null, а не исключение.
    const Json& operator[](const std::string& key) const {
        static const Json null_value;
        if (type_ != Type::Object) return null_value;
        auto it = object_.find(key);
        return it == object_.end() ? null_value : *it->second;
    }

    const std::vector<std::shared_ptr<Json>>& items() const { return array_; }
    size_t size() const { return type_ == Type::Array ? array_.size() : 0; }

    // ── сериализация ──────────────────────────────────────────────────
    static std::string quote(const std::string& text) {
        std::string out = "\"";
        for (unsigned char c : text) {
            switch (c) {
                case '"': out += "\\\""; break;
                case '\\': out += "\\\\"; break;
                case '\n': out += "\\n"; break;
                case '\r': out += "\\r"; break;
                case '\t': out += "\\t"; break;
                default:
                    if (c < 0x20) {
                        char buffer[7];
                        std::snprintf(buffer, sizeof(buffer), "\\u%04x", c);
                        out += buffer;
                    } else {
                        out += static_cast<char>(c);
                    }
            }
        }
        return out + "\"";
    }

private:
    Type type_;
    bool bool_ = false;
    double number_ = 0;
    std::string string_;
    std::vector<std::shared_ptr<Json>> array_;
    std::map<std::string, std::shared_ptr<Json>> object_;

    static void skip_space(const std::string& text, size_t& pos) {
        while (pos < text.size() && std::isspace(static_cast<unsigned char>(text[pos]))) ++pos;
    }

    static Json parse_value(const std::string& text, size_t& pos) {
        skip_space(text, pos);
        if (pos >= text.size()) throw std::runtime_error("неожиданный конец JSON");
        char c = text[pos];
        if (c == '{') return parse_object(text, pos);
        if (c == '[') return parse_array(text, pos);
        if (c == '"') {
            Json value;
            value.type_ = Type::String;
            value.string_ = parse_string(text, pos);
            return value;
        }
        if (text.compare(pos, 4, "true") == 0) { pos += 4; return make_bool(true); }
        if (text.compare(pos, 5, "false") == 0) { pos += 5; return make_bool(false); }
        if (text.compare(pos, 4, "null") == 0) { pos += 4; return Json(); }
        return parse_number(text, pos);
    }

    static Json make_bool(bool value) {
        Json json;
        json.type_ = Type::Bool;
        json.bool_ = value;
        return json;
    }

    static Json parse_number(const std::string& text, size_t& pos) {
        size_t start = pos;
        while (pos < text.size() && (std::isdigit(static_cast<unsigned char>(text[pos]))
               || text[pos] == '-' || text[pos] == '+' || text[pos] == '.'
               || text[pos] == 'e' || text[pos] == 'E')) {
            ++pos;
        }
        if (start == pos) throw std::runtime_error("не число в JSON");
        Json json;
        json.type_ = Type::Number;
        json.number_ = std::stod(text.substr(start, pos - start));
        return json;
    }

    static std::string parse_string(const std::string& text, size_t& pos) {
        ++pos;  // открывающая кавычка
        std::string out;
        while (pos < text.size() && text[pos] != '"') {
            char c = text[pos++];
            if (c != '\\') { out += c; continue; }
            if (pos >= text.size()) break;
            char escape = text[pos++];
            switch (escape) {
                case 'n': out += '\n'; break;
                case 't': out += '\t'; break;
                case 'r': out += '\r'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'u': {
                    if (pos + 4 > text.size()) break;
                    unsigned code = std::stoul(text.substr(pos, 4), nullptr, 16);
                    pos += 4;
                    // Суррогатная пара UTF-16 → один кодовый пункт.
                    if (code >= 0xD800 && code <= 0xDBFF && pos + 6 <= text.size()
                        && text[pos] == '\\' && text[pos + 1] == 'u') {
                        unsigned low = std::stoul(text.substr(pos + 2, 4), nullptr, 16);
                        if (low >= 0xDC00 && low <= 0xDFFF) {
                            code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                            pos += 6;
                        }
                    }
                    append_utf8(out, code);
                    break;
                }
                default: out += escape;
            }
        }
        ++pos;  // закрывающая кавычка
        return out;
    }

    static void append_utf8(std::string& out, unsigned code) {
        if (code < 0x80) {
            out += static_cast<char>(code);
        } else if (code < 0x800) {
            out += static_cast<char>(0xC0 | (code >> 6));
            out += static_cast<char>(0x80 | (code & 0x3F));
        } else if (code < 0x10000) {
            out += static_cast<char>(0xE0 | (code >> 12));
            out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (code & 0x3F));
        } else {
            out += static_cast<char>(0xF0 | (code >> 18));
            out += static_cast<char>(0x80 | ((code >> 12) & 0x3F));
            out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (code & 0x3F));
        }
    }

    static Json parse_array(const std::string& text, size_t& pos) {
        Json json;
        json.type_ = Type::Array;
        ++pos;
        skip_space(text, pos);
        if (pos < text.size() && text[pos] == ']') { ++pos; return json; }
        while (pos < text.size()) {
            json.array_.push_back(std::make_shared<Json>(parse_value(text, pos)));
            skip_space(text, pos);
            if (pos < text.size() && text[pos] == ',') { ++pos; continue; }
            break;
        }
        if (pos < text.size() && text[pos] == ']') ++pos;
        return json;
    }

    static Json parse_object(const std::string& text, size_t& pos) {
        Json json;
        json.type_ = Type::Object;
        ++pos;
        skip_space(text, pos);
        if (pos < text.size() && text[pos] == '}') { ++pos; return json; }
        while (pos < text.size()) {
            skip_space(text, pos);
            if (pos >= text.size() || text[pos] != '"') break;
            std::string key = parse_string(text, pos);
            skip_space(text, pos);
            if (pos < text.size() && text[pos] == ':') ++pos;
            json.object_[key] = std::make_shared<Json>(parse_value(text, pos));
            skip_space(text, pos);
            if (pos < text.size() && text[pos] == ',') { ++pos; continue; }
            break;
        }
        if (pos < text.size() && text[pos] == '}') ++pos;
        return json;
    }
};

}  // namespace sfera
