"""Building a protocol: the snapshot of a conversation, its hash and its paper form."""
import hashlib
import html
import urllib.error
import urllib.request
from datetime import timezone as dt_timezone

from django.utils import timezone

from .chain import canonical, sha256, verify
from .models import ChainEntry

MAX_MESSAGES = 20_000
HASH_FILE_LIMIT = 25 * 1024 * 1024
SNAPSHOT_VERSION = 1


class ProtocolError(Exception):
    pass


def _user_brief(u):
    if not u:
        return {'id': '', 'username': '', 'name': ''}
    return {'id': str(u.id), 'username': u.username, 'name': (u.nickname or u.username)}


def _file_hash(attachment) -> str:
    """Hash of the file as it was sent (decrypted), skipped for very large files."""
    if attachment.file_size > HASH_FILE_LIMIT:
        return ''
    from sfera_messages.encryption import decrypt_bytes

    try:
        with attachment.file.open('rb') as fh:
            return sha256(decrypt_bytes(fh.read()))
    except Exception:
        return ''


def build_snapshot(*, scope, conversation, period_from=None, period_to=None, title='', author=None, org=None):
    """Frozen copy of the conversation for the period, with hashes of everything."""
    from sfera_messages.models import Message

    qs = Message.objects.filter(conversation=conversation).select_related('author').prefetch_related('attachments')
    if period_from:
        qs = qs.filter(created_at__gte=period_from)
    if period_to:
        qs = qs.filter(created_at__lte=period_to)
    total = qs.count()
    if total > MAX_MESSAGES:
        raise ProtocolError('too_many_messages')

    chain_rows = {e.message_id: e for e in ChainEntry.objects.filter(scope=scope).order_by('seq')}
    messages = []
    # iterator() keeps a long conversation out of memory in one piece.
    for m in qs.order_by('created_at').iterator(chunk_size=500):
        link = chain_rows.get(str(m.id))
        try:
            text = m.content
        except Exception:
            text = ''
        messages.append({
            'id': str(m.id),
            'at': m.created_at.astimezone(dt_timezone.utc).isoformat(),
            'author': _user_brief(m.author),
            'text': text,
            'edited': bool(m.edited),
            'type': getattr(m, 'message_type', '') or 'text',
            'attachments': [{
                'id': str(a.id), 'name': a.original_filename, 'size': a.file_size,
                'content_type': a.content_type, 'sha256': _file_hash(a),
            } for a in m.attachments.all()],
            'chain': {'seq': link.seq, 'content_hash': link.content_hash, 'chain_hash': link.chain_hash} if link else None,
        })

    participants = [_user_brief(u) for u in conversation.participants.all()]
    chain_ok, chain_note = verify(scope, [chain_rows[k] for k in sorted(chain_rows, key=lambda k: chain_rows[k].seq)] or None)
    if chain_ok is True and messages and any(m['chain'] is None for m in messages):
        chain_ok, chain_note = False, 'Часть сообщений не попала в цепочку'
    snapshot = {
        'format': 'sfera-legal-protocol',
        'version': SNAPSHOT_VERSION,
        'title': title,
        'scope': scope,
        'organization': org or {},
        'built_by': _user_brief(author),
        'built_at': timezone.now().astimezone(dt_timezone.utc).isoformat(),
        'period': {
            'from': period_from.astimezone(dt_timezone.utc).isoformat() if period_from else None,
            'to': period_to.astimezone(dt_timezone.utc).isoformat() if period_to else None,
        },
        'participants': participants,
        'messages': messages,
        'message_count': len(messages),
        'chain': {'ok': chain_ok, 'note': chain_note, 'links': len(chain_rows)},
    }
    return snapshot


def snapshot_bytes(snapshot: dict) -> bytes:
    return canonical(snapshot)


def snapshot_hash(snapshot: dict) -> str:
    return hashlib.sha256(snapshot_bytes(snapshot)).hexdigest()


# ── Paper form ───────────────────────────────────────────────────────────────

def _fmt(iso: str) -> str:
    try:
        from django.utils.dateparse import parse_datetime

        dt = parse_datetime(iso)
        return timezone.localtime(dt).strftime('%d.%m.%Y %H:%M:%S') if dt else iso
    except Exception:
        return iso


def render_html(package, snapshot: dict, verify_url: str = '') -> str:
    """Self-contained A4 page: open it and print to PDF, nothing else needed."""
    e = html.escape
    org = snapshot.get('organization') or {}
    rows = []
    for m in snapshot['messages']:
        files = ''.join(
            f'<div class="file">📎 {e(a["name"])} · {a["size"]} Б'
            + (f' · SHA-256 {a["sha256"][:16]}…' if a['sha256'] else '')
            + '</div>'
            for a in m['attachments']
        )
        link = m.get('chain')
        rows.append(
            f'<tr><td class="num">{link["seq"] if link else "—"}</td>'
            f'<td class="when">{e(_fmt(m["at"]))}</td>'
            f'<td class="who">{e(m["author"]["name"])}<div class="login">@{e(m["author"]["username"])}</div></td>'
            f'<td class="text">{e(m["text"]).replace(chr(10), "<br>")}{files}'
            + ('<div class="edited">сообщение редактировалось</div>' if m['edited'] else '')
            + f'</td><td class="hash">{e((link or {}).get("content_hash", ""))[:16]}</td></tr>'
        )
    signatures = ''.join(
        f'<div class="sig"><b>{e(s.signer_name)}</b>'
        f'<div>{e(s.signer_email)}</div>'
        f'<div>Подписано: {e(timezone.localtime(s.signed_at).strftime("%d.%m.%Y %H:%M:%S"))}</div>'
        f'<div>Способ: {"код из письма (простая электронная подпись)" if s.method == "code" else "файл подписи"}</div>'
        + (f'<div>Сертификат: {e(s.cert_subject)}</div>' if s.cert_subject else '')
        + (f'<div>Отпечаток: {e(s.cert_fingerprint)}</div>' if s.cert_fingerprint else '')
        + f'<div class="mono">Подписанный хеш: {e(s.signed_hash)}</div></div>'
        for s in package.signatures.all()
    ) or '<div class="muted">Подписи отсутствуют</div>'
    chain = snapshot.get('chain') or {}
    chain_line = (
        'Цепочка сходится' if chain.get('ok') is True
        else 'Цепочка нарушена' if chain.get('ok') is False
        else 'Цепочка не велась'
    )
    period = snapshot.get('period') or {}
    period_line = (
        f'с {_fmt(period["from"])} ' if period.get('from') else 'с начала переписки '
    ) + (f'по {_fmt(period["to"])}' if period.get('to') else 'по момент составления')

    return f'''<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>{e(package.title)}</title>
<style>
  @page {{ size: A4; margin: 18mm 14mm; }}
  body {{ font: 12px/1.45 "Times New Roman", Georgia, serif; color: #000; background: #fff; margin: 0; }}
  h1 {{ font-size: 18px; text-align: center; margin: 0 0 4px; }}
  .sub {{ text-align: center; font-size: 12px; margin-bottom: 14px; }}
  .meta {{ border: 1px solid #000; padding: 8px 10px; margin-bottom: 12px; }}
  .meta div {{ margin: 2px 0; }}
  table {{ width: 100%; border-collapse: collapse; }}
  th, td {{ border: 1px solid #555; padding: 4px 6px; vertical-align: top; }}
  th {{ background: #eee; font-size: 11px; }}
  td.num {{ width: 34px; text-align: right; }}
  td.when {{ width: 110px; white-space: nowrap; }}
  td.who {{ width: 130px; }}
  td.hash {{ width: 90px; font-family: Consolas, monospace; font-size: 9px; word-break: break-all; }}
  .login {{ color: #555; font-size: 10px; }}
  .file {{ font-size: 11px; color: #333; margin-top: 2px; }}
  .edited {{ font-size: 10px; color: #777; }}
  .mono {{ font-family: Consolas, monospace; font-size: 10px; word-break: break-all; }}
  .sig {{ border: 1px solid #000; padding: 8px 10px; margin: 8px 0; }}
  .muted {{ color: #555; }}
  footer {{ margin-top: 16px; font-size: 11px; }}
  tr {{ break-inside: avoid; }}
</style></head><body>
<h1>Протокол переписки</h1>
<div class="sub">{e(package.title)}</div>
<div class="meta">
  {f'<div><b>Организация:</b> {e(org.get("name", ""))} {e(org.get("details", ""))}</div>' if org.get('name') else ''}
  <div><b>Составил:</b> {e(snapshot['built_by']['name'])} (@{e(snapshot['built_by']['username'])})</div>
  <div><b>Дата составления:</b> {e(_fmt(snapshot['built_at']))}</div>
  <div><b>Период:</b> {e(period_line)}</div>
  <div><b>Участники:</b> {e(', '.join(f"{p['name']} (@{p['username']})" for p in snapshot['participants']))}</div>
  <div><b>Сообщений:</b> {snapshot['message_count']}</div>
  <div><b>Хеш-цепочка:</b> {e(chain_line)} — {e(chain.get('note', ''))}</div>
  <div><b>SHA-256 протокола:</b> <span class="mono">{e(package.content_hash)}</span></div>
  <div><b>Код проверки:</b> {e(package.code)}{f' — {e(verify_url)}' if verify_url else ''}</div>
  {f'<div><b>Метка времени (RFC 3161):</b> получена {e(timezone.localtime(package.tsa_at).strftime("%d.%m.%Y %H:%M:%S"))}</div>' if package.tsa_at else ''}
</div>
<table><thead><tr><th>№</th><th>Дата и время (UTC+{timezone.localtime().utcoffset().seconds // 3600})</th><th>Отправитель</th><th>Сообщение</th><th>Хеш</th></tr></thead>
<tbody>{''.join(rows) or '<tr><td colspan="5">Сообщений за период нет</td></tr>'}</tbody></table>
<h3>Подписи</h3>
{signatures}
<footer>
  Протокол сформирован в Сфере. Подлинность проверяется по адресу {e(verify_url or '—')} или сравнением SHA-256
  файла протокола с указанным выше значением. Хеш-цепочка связывает каждое сообщение с предыдущим: изменение,
  удаление или вставка сообщения задним числом нарушает цепочку и видны в этом протоколе.
</footer>
</body></html>'''


# ── RFC 3161 time stamp ──────────────────────────────────────────────────────

def _der(tag: int, body: bytes) -> bytes:
    if len(body) < 0x80:
        return bytes([tag, len(body)]) + body
    length = len(body).to_bytes((len(body).bit_length() + 7) // 8, 'big')
    return bytes([tag, 0x80 | len(length)]) + length + body


def _oid_sha256() -> bytes:
    # 2.16.840.1.101.3.4.2.1
    return _der(0x06, bytes([0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]))


def timestamp_request(digest_hex: str, nonce: int) -> bytes:
    """TimeStampReq (RFC 3161) for a SHA-256 digest."""
    algorithm = _der(0x30, _oid_sha256() + _der(0x05, b''))
    imprint = _der(0x30, algorithm + _der(0x04, bytes.fromhex(digest_hex)))
    version = _der(0x02, b'\x01')
    nonce_bytes = nonce.to_bytes((nonce.bit_length() + 8) // 8 or 1, 'big')
    return _der(0x30, version + imprint + _der(0x02, nonce_bytes) + _der(0x01, b'\xff'))


def fetch_timestamp(url: str, digest_hex: str, timeout: int = 15) -> bytes | None:
    """Ask a time-stamping authority to vouch for the hash; reply stored as-is.

    The reply is a signed token from the authority: Sfera keeps it with the
    protocol so an expert can verify it with their own tools. Sfera does not
    parse or validate it.
    """
    import secrets

    body = timestamp_request(digest_hex, secrets.randbits(64))
    req = urllib.request.Request(url, data=body, method='POST')
    req.add_header('Content-Type', 'application/timestamp-query')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            if res.headers.get('Content-Type', '').startswith('application/timestamp-reply'):
                return res.read(200_000)
    except (urllib.error.URLError, TimeoutError, OSError):
        return None
    return None
