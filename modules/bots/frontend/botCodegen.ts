// Turning a node graph into a real project the owner can run on their own
// server: Python, C++ or Rust source plus its build config and a README.
//
// Every generator walks the same graph the same way — a trigger node becomes a
// handler function, linear nodes become statements, a condition becomes an
// if/else — so the three outputs stay behaviourally identical.

import type { BotGraph, BotNode } from './botFlow';
import { graphCommands, nextNode, specFor } from './botFlow';

export type TargetLanguage = 'python' | 'cpp' | 'rust';

export interface GeneratedFile {
  path: string;
  content: string;
}

interface Meta {
  botUsername: string;
  serverUrl: string;
}

// ── text templates ────────────────────────────────────────────────────────
// `{text}`, `{args}`, `{user}` and any `{variable}` produced by an HTTP node
// are compiled into plain string concatenation, which every target supports
// without pulling in a formatting library.

type Token = { kind: 'literal'; value: string } | { kind: 'ref'; name: string };

function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  const re = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    if (m.index > last) tokens.push({ kind: 'literal', value: template.slice(last, m.index) });
    tokens.push({ kind: 'ref', name: m[1] });
    last = m.index + m[0].length;
  }
  if (last < template.length) tokens.push({ kind: 'literal', value: template.slice(last) });
  return tokens.length ? tokens : [{ kind: 'literal', value: '' }];
}

const quote = (s: string) =>
  `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '')}"`;

const identifier = (raw: string, fallback: string) => {
  const cleaned = (raw || '').trim().replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
  return cleaned || fallback;
};

interface Lang {
  /** Expression for a built-in reference, or undefined when it's a variable. */
  builtin(name: string): string | undefined;
  variable(name: string): string;
  concat(parts: string[]): string;
}

function expression(template: string, lang: Lang, defined: Set<string>): string {
  const parts = tokenize(template).map(token => {
    if (token.kind === 'literal') return quote(token.value);
    const builtin = lang.builtin(token.name);
    if (builtin) return builtin;
    if (defined.has(token.name)) return lang.variable(token.name);
    // Unknown placeholder: keep it visible rather than silently dropping it.
    return quote(`{${token.name}}`);
  });
  return parts.length === 1 ? parts[0] : lang.concat(parts);
}

// ── graph walking ─────────────────────────────────────────────────────────

interface Emitter {
  reply(expr: string, indent: string): string[];
  condition(value: string, indent: string): { open: string[]; middle: string[]; close: string[] };
  http(varName: string, urlExpr: string, indent: string): string[];
  delay(seconds: number, indent: string): string[];
  stop(indent: string): string[];
  lang: Lang;
}

const MAX_DEPTH = 64;

function walk(
  graph: BotGraph, node: BotNode | undefined, emitter: Emitter,
  indent: string, defined: Set<string>, depth = 0,
): string[] {
  if (!node || depth > MAX_DEPTH) return [];
  const lines: string[] = [];
  switch (node.type) {
    case 'reply': {
      lines.push(...emitter.reply(expression(node.data.text || '', emitter.lang, defined), indent));
      break;
    }
    case 'http_get': {
      const varName = identifier(node.data.var || 'result', 'result');
      lines.push(...emitter.http(varName, expression(node.data.url || '', emitter.lang, defined), indent));
      defined.add(varName);
      break;
    }
    case 'delay': {
      const seconds = Number(node.data.seconds || '1');
      lines.push(...emitter.delay(Number.isFinite(seconds) && seconds > 0 ? seconds : 1, indent));
      break;
    }
    case 'stop': {
      lines.push(...emitter.stop(indent));
      return lines;
    }
    case 'condition': {
      const block = emitter.condition(quote(node.data.value || ''), indent);
      lines.push(...block.open);
      const thenLines = walk(graph, nextNode(graph, node.id, 'then'), emitter, indent + '    ', new Set(defined), depth + 1);
      lines.push(...(thenLines.length ? thenLines : emitter.stop(indent + '    ')));
      lines.push(...block.middle);
      const elseLines = walk(graph, nextNode(graph, node.id, 'else'), emitter, indent + '    ', new Set(defined), depth + 1);
      lines.push(...(elseLines.length ? elseLines : emitter.stop(indent + '    ')));
      lines.push(...block.close);
      return lines;
    }
    default:
      break;
  }
  lines.push(...walk(graph, nextNode(graph, node.id, 'out'), emitter, indent, defined, depth + 1));
  return lines;
}

const triggers = (graph: BotGraph) => graph.nodes.filter(n => specFor(n.type).isTrigger);

const handlerName = (node: BotNode, index: number) =>
  node.type === 'trigger_command'
    ? `on_${identifier(node.data.command || `command_${index}`, `command_${index}`)}`
    : `on_message_${index}`;

// ── Python ────────────────────────────────────────────────────────────────

const pythonLang: Lang = {
  builtin: name => ({ text: 'update.text', args: 'update.args', user: 'update.user' } as Record<string, string>)[name],
  variable: name => `str(v_${name})`,
  concat: parts => parts.join(' + '),
};

const pythonEmitter: Emitter = {
  lang: pythonLang,
  reply: (expr, i) => [`${i}bot.send(update.chat_id, ${expr})`],
  condition: (value, i) => ({
    open: [`${i}if ${value} in update.text.lower():`],
    middle: [`${i}else:`],
    close: [],
  }),
  http: (name, url, i) => [`${i}v_${name} = bot.http_get(${url})`],
  delay: (seconds, i) => [`${i}time.sleep(${seconds})`],
  stop: i => [`${i}return`],
};

function pythonProject(graph: BotGraph, meta: Meta): GeneratedFile[] {
  const body: string[] = [];
  triggers(graph).forEach((trigger, index) => {
    const name = handlerName(trigger, index);
    const lines = walk(graph, nextNode(graph, trigger.id, 'out'), pythonEmitter, '    ', new Set());
    if (trigger.type === 'trigger_command') {
      const command = identifier(trigger.data.command || 'start', 'start').toLowerCase();
      body.push(`@bot.command(${quote(command)}, ${quote(trigger.data.description || '')})`);
    } else {
      body.push(`@bot.message(${quote((trigger.data.contains || '').toLowerCase())})`);
    }
    body.push(`def ${name}(bot: Bot, update: Update) -> None:`);
    body.push(...(lines.length ? lines : ['    pass']));
    body.push('');
  });

  const main = `"""Бот @${meta.botUsername} — сгенерирован нодовым редактором Сферы.

Запуск:
    pip install -r requirements.txt
    set SFERA_BOT_TOKEN=<ключ от Сфероника>   # Linux/macOS: export
    python main.py
"""

import os
import time

from sfera_bot import Bot, Update

bot = Bot(
    token=os.environ.get("SFERA_BOT_TOKEN", ""),
    server=os.environ.get("SFERA_SERVER", ${quote(meta.serverUrl)}),
)

${body.join('\n')}
if __name__ == "__main__":
    bot.run()
`;

  return [
    { path: 'main.py', content: main },
    { path: 'requirements.txt', content: 'sfera-bot>=1.0\n' },
    {
      path: 'README.md',
      content: readme(meta, 'python', [
        'pip install -r requirements.txt',
        'export SFERA_BOT_TOKEN=<ключ>',
        'python main.py',
      ]),
    },
  ];
}

// ── Rust ──────────────────────────────────────────────────────────────────

const rustLang: Lang = {
  builtin: name => ({
    text: 'update.text.clone()', args: 'update.args.clone()', user: 'update.user.clone()',
  } as Record<string, string>)[name],
  variable: name => `v_${name}.clone()`,
  concat: parts => parts.map(p => (p.startsWith('"') ? `String::from(${p})` : p)).join(' + &'),
};

const rustEmitter: Emitter = {
  lang: rustLang,
  reply: (expr, i) => [`${i}bot.send(&update.chat_id, &(${expr.startsWith('"') ? `String::from(${expr})` : expr}))?;`],
  condition: (value, i) => ({
    open: [`${i}if update.text.to_lowercase().contains(${value}) {`],
    middle: [`${i}} else {`],
    close: [`${i}}`],
  }),
  http: (name, url, i) => [`${i}let v_${name} = bot.http_get(&(${url.startsWith('"') ? `String::from(${url})` : url}))?;`],
  delay: (seconds, i) => [`${i}std::thread::sleep(std::time::Duration::from_secs_f64(${seconds.toFixed(3)}));`],
  stop: i => [`${i}return Ok(());`],
};

function rustProject(graph: BotGraph, meta: Meta): GeneratedFile[] {
  const handlers: string[] = [];
  const registrations: string[] = [];
  triggers(graph).forEach((trigger, index) => {
    const name = handlerName(trigger, index);
    const lines = walk(graph, nextNode(graph, trigger.id, 'out'), rustEmitter, '    ', new Set());
    handlers.push(
      `fn ${name}(bot: &Bot, update: &Update) -> Result<()> {\n${lines.join('\n')}${lines.length ? '\n' : ''}    Ok(())\n}\n`,
    );
    if (trigger.type === 'trigger_command') {
      const command = identifier(trigger.data.command || 'start', 'start').toLowerCase();
      registrations.push(`    bot.command(${quote(command)}, ${quote(trigger.data.description || '')}, ${name});`);
    } else {
      registrations.push(`    bot.on_message(${quote((trigger.data.contains || '').toLowerCase())}, ${name});`);
    }
  });

  const main = `//! Бот @${meta.botUsername} — сгенерирован нодовым редактором Сферы.
//!
//! Запуск:
//!     export SFERA_BOT_TOKEN=<ключ от Сфероника>
//!     cargo run --release

use sfera_bot::{Bot, Result, Update};

${handlers.join('\n')}
fn main() -> Result<()> {
    let mut bot = Bot::new(
        &std::env::var("SFERA_BOT_TOKEN").unwrap_or_default(),
        &std::env::var("SFERA_SERVER").unwrap_or_else(|_| ${quote(meta.serverUrl)}.to_string()),
    );
${registrations.join('\n')}
    bot.run()
}
`;

  const cargo = `[package]
name = "${identifier(meta.botUsername, 'sfera_bot_app').toLowerCase()}"
version = "0.1.0"
edition = "2021"

[dependencies]
sfera-bot = { path = "../bot-sdks/rust" }
`;

  return [
    { path: 'src/main.rs', content: main },
    { path: 'Cargo.toml', content: cargo },
    {
      path: 'README.md',
      content: readme(meta, 'rust', [
        'export SFERA_BOT_TOKEN=<ключ>',
        'cargo run --release',
      ]),
    },
  ];
}

// ── C++ ───────────────────────────────────────────────────────────────────

const cppLang: Lang = {
  builtin: name => ({ text: 'update.text', args: 'update.args', user: 'update.user' } as Record<string, string>)[name],
  variable: name => `v_${name}`,
  concat: parts => parts.map((p, i) => (i === 0 && p.startsWith('"') ? `std::string(${p})` : p)).join(' + '),
};

const cppEmitter: Emitter = {
  lang: cppLang,
  reply: (expr, i) => [`${i}bot.send(update.chat_id, ${expr.startsWith('"') ? `std::string(${expr})` : expr});`],
  condition: (value, i) => ({
    open: [`${i}if (sfera::contains_ci(update.text, ${value})) {`],
    middle: [`${i}} else {`],
    close: [`${i}}`],
  }),
  http: (name, url, i) => [`${i}const std::string v_${name} = bot.http_get(${url.startsWith('"') ? `std::string(${url})` : url});`],
  delay: (seconds, i) => [`${i}std::this_thread::sleep_for(std::chrono::milliseconds(${Math.round(seconds * 1000)}));`],
  stop: i => [`${i}return;`],
};

function cppProject(graph: BotGraph, meta: Meta): GeneratedFile[] {
  const handlers: string[] = [];
  const registrations: string[] = [];
  triggers(graph).forEach((trigger, index) => {
    const name = handlerName(trigger, index);
    const lines = walk(graph, nextNode(graph, trigger.id, 'out'), cppEmitter, '    ', new Set());
    handlers.push(
      `static void ${name}(sfera::Bot& bot, const sfera::Update& update) {\n${lines.join('\n')}${lines.length ? '\n' : ''}}\n`,
    );
    if (trigger.type === 'trigger_command') {
      const command = identifier(trigger.data.command || 'start', 'start').toLowerCase();
      registrations.push(`    bot.command(${quote(command)}, ${quote(trigger.data.description || '')}, ${name});`);
    } else {
      registrations.push(`    bot.on_message(${quote((trigger.data.contains || '').toLowerCase())}, ${name});`);
    }
  });

  const main = `// Бот @${meta.botUsername} — сгенерирован нодовым редактором Сферы.
//
// Сборка:
//     cmake -B build && cmake --build build
//     SFERA_BOT_TOKEN=<ключ от Сфероника> ./build/bot

#include <chrono>
#include <cstdlib>
#include <string>
#include <thread>

#include <sfera/bot.hpp>

${handlers.join('\n')}
static std::string env_or(const char* name, const std::string& fallback) {
    const char* value = std::getenv(name);
    return (value && *value) ? std::string(value) : fallback;
}

int main() {
    sfera::Bot bot(env_or("SFERA_BOT_TOKEN", ""), env_or("SFERA_SERVER", ${quote(meta.serverUrl)}));
${registrations.join('\n')}
    bot.run();
    return 0;
}
`;

  const cmake = `cmake_minimum_required(VERSION 3.16)
project(${identifier(meta.botUsername, 'sfera_bot_app').toLowerCase()} CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# The SDK lives in bot-sdks/cpp of the Sfera repository.
add_subdirectory(\${CMAKE_CURRENT_SOURCE_DIR}/../bot-sdks/cpp sfera_bot_sdk)

add_executable(bot main.cpp)
target_link_libraries(bot PRIVATE sfera_bot)
`;

  return [
    { path: 'main.cpp', content: main },
    { path: 'CMakeLists.txt', content: cmake },
    {
      path: 'README.md',
      content: readme(meta, 'cpp', [
        'cmake -B build && cmake --build build',
        'export SFERA_BOT_TOKEN=<ключ>',
        './build/bot',
      ]),
    },
  ];
}

// ── shared ────────────────────────────────────────────────────────────────

function readme(meta: Meta, language: TargetLanguage, steps: string[]) {
  const names: Record<TargetLanguage, string> = { python: 'Python', cpp: 'C++', rust: 'Rust' };
  return `# @${meta.botUsername}

Проект сгенерирован нодовым редактором Сферы (${names[language]}).

Бот работает по ключу, который выдал **Сфероник**. Ключ не зашит в код —
он читается из переменной окружения \`SFERA_BOT_TOKEN\`, чтобы его можно было
менять без пересборки.

## Запуск на своём сервере

\`\`\`bash
${steps.join('\n')}
\`\`\`

Сервер Сферы по умолчанию: \`${meta.serverUrl}\`. Переопределяется переменной
\`SFERA_SERVER\`.

## Команды

Список команд регистрируется на сервере при старте — именно он показывается
в кнопке команд рядом с полем ввода в чатах, где есть бот.

## Правила

Сообщения бота проходят те же фильтры контента, что и сообщения людей.
Удалить бота можно в диалоге со Сфероником: \`/deletebot ${meta.botUsername}\` —
ключ отзывается, переписки остаются.
`;
}

export function generateProject(
  graph: BotGraph, language: TargetLanguage, meta: Meta,
): GeneratedFile[] {
  const files = language === 'python'
    ? pythonProject(graph, meta)
    : language === 'rust'
      ? rustProject(graph, meta)
      : cppProject(graph, meta);
  return [
    ...files,
    // The graph travels with the project so the editor can reopen it later.
    { path: 'bot.flow.json', content: JSON.stringify({ graph, commands: graphCommands(graph) }, null, 2) },
  ];
}
