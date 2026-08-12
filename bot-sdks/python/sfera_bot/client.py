"""Клиент Bot API Сферы.

Зависимостей нет — только стандартная библиотека, чтобы бота можно было
запустить на любом сервере, где есть Python 3.9+.

Протокол устроен так же, как в SDK для C++ и Rust:

* ключ передаётся заголовком ``Authorization: Bot <token>``;
* обновления забираются длинным опросом ``GET /api/bots/api/updates/``;
* подтверждение — параметр ``offset``: всё до него включительно удаляется
  на сервере, поэтому обработанное не приходит повторно;
* ответы отправляются через ``POST /api/bots/api/send/``.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Union

__version__ = '1.1.0'

DEFAULT_SERVER = 'https://start-ionik.ru'
LONG_POLL_SECONDS = 30
# Пауза после сетевой ошибки растёт до этого потолка, чтобы упавший сервер
# не получал шквал повторов.
MAX_BACKOFF_SECONDS = 30

log = logging.getLogger('sfera_bot')


class BotError(RuntimeError):
    """Ошибка обращения к Bot API."""


@dataclass
class Command:
    command: str
    description: str = ''

    def as_dict(self) -> dict:
        return {'command': self.command, 'description': self.description}


@dataclass
class Chat:
    """Место, где бот присутствует: личный диалог или канал сервера."""
    chat_id: str
    chat_type: str
    name: str = ''
    guild_id: str = ''
    guild_name: str = ''
    peer: Optional[dict] = None


@dataclass
class Attachment:
    """Файл, прикреплённый к сообщению."""
    id: str
    filename: str = ''
    content_type: str = ''
    file_size: int = 0

    @property
    def is_image(self) -> bool:
        return self.content_type.startswith('image/')

    @property
    def is_video(self) -> bool:
        return self.content_type.startswith('video/')

    @classmethod
    def from_payload(cls, payload: dict) -> 'Attachment':
        return cls(
            id=str(payload.get('id') or ''),
            filename=payload.get('filename') or '',
            content_type=payload.get('content_type') or '',
            file_size=int(payload.get('file_size') or 0),
        )


@dataclass
class Update:
    """Входящее событие."""
    id: int
    type: str
    chat_id: str
    chat_type: str
    text: str
    user: str
    user_id: str
    message_id: str
    created_at: str
    command: str = ''
    args: str = ''
    guild_id: str = ''
    attachments: List[Attachment] = field(default_factory=list)
    raw: dict = field(default_factory=dict)

    @property
    def is_command(self) -> bool:
        return bool(self.command)

    @property
    def is_direct(self) -> bool:
        return self.chat_type == 'dm'

    @property
    def has_media(self) -> bool:
        return bool(self.attachments)

    @classmethod
    def from_payload(cls, payload: dict) -> 'Update':
        message = payload.get('message') or {}
        author = message.get('from') or {}
        return cls(
            attachments=[
                Attachment.from_payload(a) for a in (message.get('attachments') or [])
            ],
            id=int(payload.get('id') or 0),
            type=payload.get('type') or 'message',
            chat_id=str(payload.get('chat_id') or ''),
            chat_type=payload.get('chat_type') or 'dm',
            text=message.get('content') or '',
            user=author.get('nickname') or author.get('username') or '',
            user_id=str(author.get('id') or ''),
            message_id=str(message.get('id') or ''),
            created_at=payload.get('created_at') or '',
            command=payload.get('command') or '',
            args=payload.get('args') or '',
            guild_id=str(payload.get('guild_id') or ''),
            raw=payload,
        )


Handler = Callable[['Bot', Update], None]


class Bot:
    """Долгоживущий клиент: регистрирует команды и обслуживает обновления."""

    def __init__(
        self,
        token: str = '',
        server: str = '',
        *,
        timeout: int = LONG_POLL_SECONDS,
        verify_tls: bool = True,
    ) -> None:
        self.token = token or os.environ.get('SFERA_BOT_TOKEN', '')
        self.server = (server or os.environ.get('SFERA_SERVER', DEFAULT_SERVER)).rstrip('/')
        if not self.token:
            raise BotError('нужен ключ бота: аргумент token или переменная SFERA_BOT_TOKEN')
        self.timeout = timeout
        self._commands: Dict[str, Command] = {}
        self._command_handlers: Dict[str, Handler] = {}
        self._message_handlers: List[tuple] = []  # (подстрока, обработчик)
        self._offset = 0
        self._running = False
        self._ssl_context = None if verify_tls else ssl._create_unverified_context()

    # ── регистрация обработчиков ──────────────────────────────────────────

    def command(self, name: str, description: str = ''):
        """Декоратор: обработчик ``/name``. Команда попадёт в кнопку у поля ввода."""
        key = _normalize_command(name)

        def decorator(handler: Handler) -> Handler:
            self._commands[key] = Command(key, description)
            self._command_handlers[key] = handler
            return handler
        return decorator

    def on_message(self, contains: str = ''):
        """Декоратор: обычные сообщения. Пустая строка — любые."""
        def decorator(handler: Handler) -> Handler:
            self._message_handlers.append((contains.lower(), handler))
            return handler
        return decorator

    # Псевдоним, чтобы читалось как в сгенерированном коде.
    message = on_message

    # ── действия ──────────────────────────────────────────────────────────

    def me(self) -> dict:
        return self._request('GET', '/api/bots/api/me/')

    def chats(self) -> List[Chat]:
        payload = self._request('GET', '/api/bots/api/chats/')
        return [
            Chat(
                chat_id=item['chat_id'], chat_type=item['chat_type'],
                name=item.get('name', ''), guild_id=item.get('guild_id', ''),
                guild_name=item.get('guild_name', ''), peer=item.get('peer'),
            )
            for item in payload.get('chats', [])
        ]

    def send(
        self,
        chat_id: str,
        text: str = '',
        reply_to: str = '',
        attachment_ids: Optional[List[str]] = None,
    ) -> dict:
        """Отправить сообщение. Нужен либо ``text``, либо ``attachment_ids``."""
        body: dict = {'chat_id': str(chat_id), 'text': text}
        if reply_to:
            body['reply_to'] = str(reply_to)
        if attachment_ids:
            body['attachment_ids'] = [str(a) for a in attachment_ids]
        return self._request('POST', '/api/bots/api/send/', body)

    def reply(self, update: Update, text: str) -> dict:
        """Ответить в тот же чат, цитируя исходное сообщение."""
        return self.send(update.chat_id, text, reply_to=update.message_id)

    # ── файлы ─────────────────────────────────────────────────────────────

    def upload(
        self,
        chat_id: str,
        file: Union[str, Path, bytes],
        filename: str = '',
        content_type: str = '',
    ) -> Attachment:
        """Загрузить файл в чат, ничего пока не отправляя.

        Принимает путь или сами байты. Возвращает вложение, чей ``id``
        передаётся в :meth:`send` как ``attachment_ids``. Файл привязан к
        этому чату и отправляется ровно один раз.
        """
        if isinstance(file, (str, Path)):
            path = Path(file)
            data = path.read_bytes()
            filename = filename or path.name
        else:
            data = bytes(file)
            filename = filename or 'file.bin'
        content_type = content_type or mimetypes.guess_type(filename)[0] or 'application/octet-stream'
        payload = self._upload_request(str(chat_id), filename, content_type, data)
        return Attachment.from_payload(payload)

    def send_file(
        self,
        chat_id: str,
        file: Union[str, Path, bytes],
        caption: str = '',
        filename: str = '',
        reply_to: str = '',
    ) -> dict:
        """Загрузить и сразу отправить один файл — самый частый случай."""
        attachment = self.upload(chat_id, file, filename)
        return self.send(chat_id, caption, reply_to=reply_to, attachment_ids=[attachment.id])

    def download(self, attachment: Union[str, Attachment]) -> bytes:
        """Скачать вложение из чата, где бот состоит."""
        attachment_id = attachment.id if isinstance(attachment, Attachment) else str(attachment)
        return self._raw_request('GET', f'/api/bots/api/file/{attachment_id}/')

    # ── контекст чата ─────────────────────────────────────────────────────

    def history(self, chat_id: str, limit: int = 50, before: str = '') -> List[dict]:
        """Прочитать чат назад: последние ``limit`` сообщений, старые первыми.

        В отличие от :meth:`poll`, ничего не подтверждает и не удаляет —
        это для ботов, которым нужен контекст, а не живая лента. ``before`` —
        id сообщения, от которого шагать дальше в прошлое.
        """
        query = {'chat_id': str(chat_id), 'limit': limit}
        if before:
            query['before'] = str(before)
        payload = self._request('GET', f'/api/bots/api/history/?{urllib.parse.urlencode(query)}')
        return payload.get('messages', [])

    def members(self, chat_id: str) -> List[dict]:
        """Кто ещё в чате. В канале у каждого есть ``role``."""
        query = urllib.parse.urlencode({'chat_id': str(chat_id)})
        payload = self._request('GET', f'/api/bots/api/members/?{query}')
        return payload.get('members', [])

    def react(self, message_id: str, emoji: str, remove: bool = False) -> List[dict]:
        """Поставить (или снять) реакцию. Только в каналах: у ЛС реакций нет."""
        payload = self._request(
            'POST', '/api/bots/api/react/',
            {'message_id': str(message_id), 'emoji': emoji, 'remove': remove},
        )
        return payload.get('reactions', [])

    def edit(self, message_id: str, text: str) -> dict:
        """Rewrite a message the bot sent earlier (DM or channel)."""
        return self._request(
            'POST', '/api/bots/api/edit/',
            {'message_id': str(message_id), 'text': text},
        )

    def delete(self, message_id: str) -> None:
        """Delete a message the bot sent earlier."""
        self._request('POST', '/api/bots/api/delete/', {'message_id': str(message_id)})

    def set_commands(self, commands: Optional[List[Command]] = None) -> List[dict]:
        """Опубликовать список команд. По умолчанию — все зарегистрированные."""
        items = commands if commands is not None else list(self._commands.values())
        payload = self._request(
            'POST', '/api/bots/api/commands/',
            {'commands': [c.as_dict() for c in items]},
        )
        return payload.get('commands', [])

    def http_get(self, url: str) -> str:
        """Простой GET наружу — используется узлом «HTTP-запрос» редактора."""
        request = urllib.request.Request(url, headers={'User-Agent': f'sfera-bot/{__version__}'})
        with urllib.request.urlopen(request, timeout=20, context=self._ssl_context) as response:
            return response.read().decode('utf-8', 'replace').strip()

    # ── цикл обработки ────────────────────────────────────────────────────

    def poll(self, timeout: Optional[int] = None) -> List[Update]:
        """Забрать порцию обновлений (подтверждая предыдущую)."""
        query = urllib.parse.urlencode({
            'offset': self._offset,
            'timeout': self.timeout if timeout is None else timeout,
        })
        payload = self._request('GET', f'/api/bots/api/updates/?{query}')
        updates = [Update.from_payload(item) for item in payload.get('updates', [])]
        if updates:
            self._offset = max(u.id for u in updates)
        return updates

    def dispatch(self, update: Update) -> None:
        """Отдать обновление подходящему обработчику."""
        if update.command:
            handler = self._command_handlers.get(_normalize_command(update.command))
            if handler is not None:
                handler(self, update)
            return
        text = update.text.lower()
        for contains, handler in self._message_handlers:
            if not contains or contains in text:
                handler(self, update)

    def run(self, register_commands: bool = True) -> None:
        """Блокирующий цикл: публикует команды и обрабатывает обновления."""
        if register_commands and self._commands:
            try:
                self.set_commands()
            except BotError as exc:
                log.warning('не удалось опубликовать команды: %s', exc)
        self._running = True
        backoff = 1.0
        log.info('бот запущен, сервер %s', self.server)
        while self._running:
            try:
                for update in self.poll():
                    try:
                        self.dispatch(update)
                    except Exception:  # обработчик не должен ронять бота
                        log.exception('обработчик упал на обновлении %s', update.id)
                backoff = 1.0
            except KeyboardInterrupt:
                self.stop()
            except BotError as exc:
                log.warning('опрос не удался (%s), повтор через %.0f с', exc, backoff)
                time.sleep(backoff)
                backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)

    def stop(self) -> None:
        self._running = False

    # ── транспорт ─────────────────────────────────────────────────────────

    def _headers(self, content_type: str) -> Dict[str, str]:
        return {
            'Authorization': f'Bot {self.token}',
            'Content-Type': content_type,
            'X-Ionik-Client': '1',
            'User-Agent': f'sfera-bot/{__version__}',
        }

    def _request(self, method: str, path: str, body: Optional[dict] = None) -> dict:
        data = json.dumps(body).encode('utf-8') if body is not None else None
        raw = self._send(method, path, data, 'application/json')
        try:
            return json.loads(raw.decode('utf-8')) if raw else {}
        except json.JSONDecodeError as exc:
            raise BotError('сервер вернул не JSON') from exc

    def _raw_request(self, method: str, path: str) -> bytes:
        """Ответ как есть — для скачивания файлов."""
        return self._send(method, path, None, 'application/json')

    def _upload_request(self, chat_id: str, filename: str, content_type: str, data: bytes) -> dict:
        """multipart/form-data вручную: SDK не тянет зависимостей."""
        boundary = f'----sfera{uuid.uuid4().hex}'
        crlf = b'\r\n'
        safe_name = filename.replace('"', '')
        body = b''.join([
            f'--{boundary}'.encode(), crlf,
            b'Content-Disposition: form-data; name="chat_id"', crlf, crlf,
            chat_id.encode(), crlf,
            f'--{boundary}'.encode(), crlf,
            f'Content-Disposition: form-data; name="file"; filename="{safe_name}"'.encode(), crlf,
            f'Content-Type: {content_type}'.encode(), crlf, crlf,
            data, crlf,
            f'--{boundary}--'.encode(), crlf,
        ])
        raw = self._send(
            'POST', '/api/bots/api/upload/', body,
            f'multipart/form-data; boundary={boundary}',
        )
        try:
            return json.loads(raw.decode('utf-8')) if raw else {}
        except json.JSONDecodeError as exc:
            raise BotError('сервер вернул не JSON') from exc

    def _send(self, method: str, path: str, data: Optional[bytes], content_type: str) -> bytes:
        request = urllib.request.Request(
            f'{self.server}{path}', data=data, method=method,
            headers=self._headers(content_type),
        )
        # Длинный опрос держит соединение до timeout: даём запас сверху.
        deadline = self.timeout + 15
        try:
            with urllib.request.urlopen(request, timeout=deadline, context=self._ssl_context) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode('utf-8', 'replace')[:300]
            if exc.code == 401:
                raise BotError('ключ отозван или неверен') from exc
            raise BotError(f'HTTP {exc.code}: {detail}') from exc
        except (urllib.error.URLError, TimeoutError, ssl.SSLError) as exc:
            raise BotError(f'сеть недоступна: {exc}') from exc


def _normalize_command(name: str) -> str:
    return re.sub(r'[^a-z0-9_]', '', (name or '').strip().lstrip('/').lower())
