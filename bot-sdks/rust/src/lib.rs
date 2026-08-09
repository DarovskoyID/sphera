//! Официальная библиотека ботов Сферы.
//!
//! ```no_run
//! use sfera_bot::{Bot, Result, Update};
//!
//! fn start(bot: &Bot, update: &Update) -> Result<()> {
//!     bot.send(&update.chat_id, &format!("Привет, {}!", update.user))?;
//!     Ok(())
//! }
//!
//! fn main() -> Result<()> {
//!     let mut bot = Bot::from_env()?;
//!     bot.command("start", "Запустить бота", start);
//!     bot.run()
//! }
//! ```
//!
//! Протокол тот же, что у SDK для Python и C++: ключ в заголовке
//! `Authorization: Bot <token>`, обновления — длинным опросом с подтверждением
//! через `offset`, отправка — `POST /api/bots/api/send/`.

use std::collections::HashMap;
use std::fmt;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DEFAULT_SERVER: &str = "https://start-ionik.ru";

const LONG_POLL_SECONDS: u64 = 30;
const MAX_BACKOFF_SECONDS: u64 = 30;

// ── ошибки ──────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum Error {
    /// Ключ не задан, отозван или неверен.
    Auth(String),
    /// Сеть или сервер.
    Transport(String),
    /// Сервер ответил не тем, что ожидалось.
    Protocol(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Auth(m) => write!(f, "ошибка ключа: {m}"),
            Error::Transport(m) => write!(f, "сеть недоступна: {m}"),
            Error::Protocol(m) => write!(f, "неожиданный ответ: {m}"),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

// ── модели ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command {
    pub command: String,
    pub description: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Chat {
    pub chat_id: String,
    pub chat_type: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub guild_id: String,
    #[serde(default)]
    pub guild_name: String,
}

/// Входящее событие.
#[derive(Debug, Clone, Default)]
pub struct Update {
    pub id: i64,
    pub kind: String,
    pub chat_id: String,
    pub chat_type: String,
    pub text: String,
    pub user: String,
    pub user_id: String,
    pub message_id: String,
    pub command: String,
    pub args: String,
    pub guild_id: String,
}

impl Update {
    pub fn is_command(&self) -> bool {
        !self.command.is_empty()
    }

    pub fn is_direct(&self) -> bool {
        self.chat_type == "dm"
    }

    fn from_value(value: &Value) -> Update {
        let message = &value["message"];
        let author = &message["from"];
        let string = |v: &Value| v.as_str().unwrap_or_default().to_string();
        Update {
            id: value["id"].as_i64().unwrap_or_default(),
            kind: string(&value["type"]),
            chat_id: string(&value["chat_id"]),
            chat_type: {
                let t = string(&value["chat_type"]);
                if t.is_empty() { "dm".to_string() } else { t }
            },
            text: string(&message["content"]),
            user: {
                let nickname = string(&author["nickname"]);
                if nickname.is_empty() { string(&author["username"]) } else { nickname }
            },
            user_id: string(&author["id"]),
            message_id: string(&message["id"]),
            command: string(&value["command"]),
            args: string(&value["args"]),
            guild_id: string(&value["guild_id"]),
        }
    }
}

pub type Handler = fn(&Bot, &Update) -> Result<()>;

// ── клиент ──────────────────────────────────────────────────────────────

pub struct Bot {
    token: String,
    server: String,
    agent: ureq::Agent,
    timeout: u64,
    offset: i64,
    commands: Vec<Command>,
    command_handlers: HashMap<String, Handler>,
    message_handlers: Vec<(String, Handler)>,
    running: bool,
}

impl Bot {
    pub fn new(token: &str, server: &str) -> Bot {
        let server = if server.is_empty() { DEFAULT_SERVER } else { server };
        Bot {
            token: token.to_string(),
            server: server.trim_end_matches('/').to_string(),
            agent: ureq::AgentBuilder::new()
                // Длинный опрос держит соединение до timeout: даём запас сверху.
                .timeout_read(Duration::from_secs(LONG_POLL_SECONDS + 15))
                .user_agent(&format!("sfera-bot/{VERSION}"))
                .build(),
            timeout: LONG_POLL_SECONDS,
            offset: 0,
            commands: Vec::new(),
            command_handlers: HashMap::new(),
            message_handlers: Vec::new(),
            running: false,
        }
    }

    /// Ключ из `SFERA_BOT_TOKEN`, адрес из `SFERA_SERVER`.
    pub fn from_env() -> Result<Bot> {
        let token = std::env::var("SFERA_BOT_TOKEN").unwrap_or_default();
        if token.is_empty() {
            return Err(Error::Auth("переменная SFERA_BOT_TOKEN не задана".into()));
        }
        let server = std::env::var("SFERA_SERVER").unwrap_or_else(|_| DEFAULT_SERVER.to_string());
        Ok(Bot::new(&token, &server))
    }

    // ── регистрация ─────────────────────────────────────────────────────

    pub fn command(&mut self, name: &str, description: &str, handler: Handler) -> &mut Bot {
        let key = normalize_command(name);
        self.commands.push(Command { command: key.clone(), description: description.to_string() });
        self.command_handlers.insert(key, handler);
        self
    }

    /// Обработчик обычных сообщений. Пустая подстрока — любое сообщение.
    pub fn on_message(&mut self, contains: &str, handler: Handler) -> &mut Bot {
        self.message_handlers.push((contains.to_lowercase(), handler));
        self
    }

    // ── действия ────────────────────────────────────────────────────────

    pub fn me(&self) -> Result<Value> {
        self.request("GET", "/api/bots/api/me/", None)
    }

    pub fn chats(&self) -> Result<Vec<Chat>> {
        let payload = self.request("GET", "/api/bots/api/chats/", None)?;
        serde_json::from_value(payload["chats"].clone())
            .map_err(|e| Error::Protocol(e.to_string()))
    }

    pub fn send(&self, chat_id: &str, text: &str) -> Result<Value> {
        self.request("POST", "/api/bots/api/send/", Some(json!({
            "chat_id": chat_id,
            "text": text,
        })))
    }

    /// Ответить в тот же чат, цитируя исходное сообщение.
    pub fn reply(&self, update: &Update, text: &str) -> Result<Value> {
        self.request("POST", "/api/bots/api/send/", Some(json!({
            "chat_id": update.chat_id,
            "text": text,
            "reply_to": update.message_id,
        })))
    }

    /// Опубликовать команды — именно они видны в кнопке команд у поля ввода.
    pub fn set_commands(&self) -> Result<Value> {
        let items: Vec<Value> = self.commands.iter()
            .map(|c| json!({ "command": c.command, "description": c.description }))
            .collect();
        self.request("POST", "/api/bots/api/commands/", Some(json!({ "commands": items })))
    }

    /// GET наружу — используется узлом «HTTP-запрос» нодового редактора.
    pub fn http_get(&self, url: &str) -> Result<String> {
        self.agent.get(url).call()
            .map_err(|e| Error::Transport(e.to_string()))?
            .into_string()
            .map(|s| s.trim().to_string())
            .map_err(|e| Error::Transport(e.to_string()))
    }

    // ── цикл ────────────────────────────────────────────────────────────

    pub fn poll(&mut self) -> Result<Vec<Update>> {
        let path = format!("/api/bots/api/updates/?offset={}&timeout={}", self.offset, self.timeout);
        let payload = self.request("GET", &path, None)?;
        let updates: Vec<Update> = payload["updates"].as_array()
            .map(|items| items.iter().map(Update::from_value).collect())
            .unwrap_or_default();
        if let Some(last) = updates.iter().map(|u| u.id).max() {
            self.offset = last;
        }
        Ok(updates)
    }

    pub fn dispatch(&self, update: &Update) -> Result<()> {
        if update.is_command() {
            if let Some(handler) = self.command_handlers.get(&normalize_command(&update.command)) {
                return handler(self, update);
            }
            return Ok(());
        }
        let text = update.text.to_lowercase();
        for (contains, handler) in &self.message_handlers {
            if contains.is_empty() || text.contains(contains.as_str()) {
                handler(self, update)?;
            }
        }
        Ok(())
    }

    /// Блокирующий цикл: публикует команды и обслуживает обновления.
    pub fn run(&mut self) -> Result<()> {
        if !self.commands.is_empty() {
            if let Err(e) = self.set_commands() {
                eprintln!("не удалось опубликовать команды: {e}");
            }
        }
        self.running = true;
        let mut backoff = 1u64;
        while self.running {
            match self.poll() {
                Ok(updates) => {
                    for update in &updates {
                        // Ошибка обработчика не должна ронять бота.
                        if let Err(e) = self.dispatch(update) {
                            eprintln!("обработчик упал на обновлении {}: {e}", update.id);
                        }
                    }
                    backoff = 1;
                }
                Err(Error::Auth(message)) => return Err(Error::Auth(message)),
                Err(e) => {
                    eprintln!("опрос не удался ({e}), повтор через {backoff} с");
                    std::thread::sleep(Duration::from_secs(backoff));
                    backoff = (backoff * 2).min(MAX_BACKOFF_SECONDS);
                }
            }
        }
        Ok(())
    }

    pub fn stop(&mut self) {
        self.running = false;
    }

    // ── транспорт ───────────────────────────────────────────────────────

    fn request(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
        let url = format!("{}{}", self.server, path);
        let request = self.agent.request(method, &url)
            .set("Authorization", &format!("Bot {}", self.token))
            .set("X-Ionik-Client", "1");
        let response = match body {
            Some(value) => request.send_json(value),
            None => request.call(),
        };
        match response {
            Ok(response) => {
                let text = response.into_string().map_err(|e| Error::Transport(e.to_string()))?;
                if text.is_empty() {
                    return Ok(Value::Null);
                }
                serde_json::from_str(&text).map_err(|e| Error::Protocol(e.to_string()))
            }
            Err(ureq::Error::Status(401, _)) => Err(Error::Auth("ключ отозван или неверен".into())),
            Err(ureq::Error::Status(code, response)) => {
                let detail = response.into_string().unwrap_or_default();
                Err(Error::Protocol(format!("HTTP {code}: {}", truncate(&detail, 300))))
            }
            Err(e) => Err(Error::Transport(e.to_string())),
        }
    }
}

fn normalize_command(name: &str) -> String {
    name.trim().trim_start_matches('/').to_lowercase()
        .chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect()
}

fn truncate(text: &str, limit: usize) -> &str {
    match text.char_indices().nth(limit) {
        Some((index, _)) => &text[..index],
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_names_are_normalized() {
        assert_eq!(normalize_command("/Start "), "start");
        assert_eq!(normalize_command("my-cmd"), "mycmd");
    }

    #[test]
    fn update_parses_a_command_payload() {
        let value = json!({
            "id": 7,
            "type": "command",
            "chat_id": "abc",
            "chat_type": "dm",
            "command": "start",
            "args": "now",
            "message": { "id": "m1", "content": "/start now", "from": { "id": "u1", "nickname": "Аня" } }
        });
        let update = Update::from_value(&value);
        assert_eq!(update.id, 7);
        assert!(update.is_command());
        assert!(update.is_direct());
        assert_eq!(update.user, "Аня");
        assert_eq!(update.args, "now");
    }
}
