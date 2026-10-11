"""Turning a document into something you can send out: Markdown, CSV, HTML."""
import csv
import io
from html import escape

from . import formulas
from .models import KIND_DECK, KIND_DOC, KIND_SHEET

LIST_PREFIX = {'ul': '- ', 'ol': '1. ', 'quote': '> ', 'h1': '# ', 'h2': '## ', 'h3': '### '}


def _blocks(data):
    blocks = data.get('blocks') or {}
    order = [b for b in (data.get('order') or []) if b in blocks]
    return [blocks[b] for b in order]


def to_markdown(doc) -> str:
    out = [f'# {doc.title}', '']
    for block in _blocks(doc.data or {}):
        kind, text = block.get('type'), block.get('text') or ''
        if kind == 'divider':
            out.append('---')
        elif kind == 'code':
            out += [f"```{block.get('lang') or ''}", text, '```']
        elif kind == 'todo':
            out.append(f"- [{'x' if block.get('done') else ' '}] {text}")
        elif kind == 'image':
            out.append(f"![{block.get('alt') or ''}]({block.get('url') or ''})")
        elif kind == 'table':
            rows = block.get('rows') or []
            for i, row in enumerate(rows):
                out.append('| ' + ' | '.join(str(c).replace('|', r'\|') for c in row) + ' |')
                if i == 0:
                    out.append('|' + '|'.join([' --- '] * len(row)) + '|')
        else:
            out.append(LIST_PREFIX.get(kind, '') + text)
        out.append('')
    return '\n'.join(out).rstrip() + '\n'


def to_csv(doc) -> str:
    data = doc.data or {}
    cells = data.get('cells') or {}
    rows = int(data.get('rows') or 50)
    cols = int(data.get('cols') or 12)
    used_rows, used_cols = 0, 0
    for ref in cells:
        letters = ''.join(ch for ch in ref if ch.isalpha())
        digits = ''.join(ch for ch in ref if ch.isdigit())
        if digits:
            used_rows = max(used_rows, int(digits))
            used_cols = max(used_cols, formulas.col_index(letters) + 1)
    rows, cols = min(rows, max(used_rows, 1)), min(cols, max(used_cols, 1))
    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=';', lineterminator='\n')
    for y in range(1, rows + 1):
        writer.writerow([formulas.display(cells, f'{formulas.col_name(x)}{y}') for x in range(cols)])
    return buffer.getvalue()


def _doc_html(doc) -> str:
    parts = []
    open_list = None
    for block in _blocks(doc.data or {}):
        kind, text = block.get('type'), escape(block.get('text') or '')
        tag = {'ul': 'ul', 'ol': 'ol'}.get(kind)
        if open_list and open_list != tag:
            parts.append(f'</{open_list}>')
            open_list = None
        if tag and open_list != tag:
            parts.append(f'<{tag}>')
            open_list = tag
        if kind in ('ul', 'ol'):
            parts.append(f'<li>{text}</li>')
        elif kind in ('h1', 'h2', 'h3'):
            parts.append(f'<{kind}>{text}</{kind}>')
        elif kind == 'quote':
            parts.append(f'<blockquote>{text}</blockquote>')
        elif kind == 'code':
            parts.append(f'<pre><code>{text}</code></pre>')
        elif kind == 'divider':
            parts.append('<hr>')
        elif kind == 'todo':
            mark = '☑' if block.get('done') else '☐'
            parts.append(f'<p class="todo">{mark} {text}</p>')
        elif kind == 'image':
            parts.append(f'<figure><img src="{escape(block.get("url") or "")}" alt="{escape(block.get("alt") or "")}"></figure>')
        elif kind == 'table':
            cells = ''.join(
                '<tr>' + ''.join(f'<{"th" if i == 0 else "td"}>{escape(str(c))}</{"th" if i == 0 else "td"}>' for c in row) + '</tr>'
                for i, row in enumerate(block.get('rows') or [])
            )
            parts.append(f'<table>{cells}</table>')
        else:
            parts.append(f'<p>{text}</p>')
    if open_list:
        parts.append(f'</{open_list}>')
    return '\n'.join(parts)


def _sheet_html(doc) -> str:
    data = doc.data or {}
    cells = data.get('cells') or {}
    rows = min(int(data.get('rows') or 50), 500)
    cols = min(int(data.get('cols') or 12), 60)
    head = ''.join(f'<th>{formulas.col_name(x)}</th>' for x in range(cols))
    body = []
    for y in range(1, rows + 1):
        line = ''.join(f'<td>{escape(formulas.display(cells, f"{formulas.col_name(x)}{y}"))}</td>' for x in range(cols))
        body.append(f'<tr><th class="rowhead">{y}</th>{line}</tr>')
    return f'<table class="grid"><thead><tr><th></th>{head}</tr></thead><tbody>{"".join(body)}</tbody></table>'


def _deck_html(doc) -> str:
    data = doc.data or {}
    slides = data.get('slides') or {}
    order = [s for s in (data.get('order') or []) if s in slides]
    out = []
    for index, sid in enumerate(order, 1):
        slide = slides[sid]
        bullets = ''.join(f'<li>{escape(b)}</li>' for b in slide.get('bullets') or [])
        bullet_list = f'<ul>{bullets}</ul>' if bullets else ''
        body = slide.get('body') or ''
        paragraph = '<p>{}</p>'.format(escape(body)) if body else ''
        out.append(
            '<section class="slide"><h2>{}</h2>{}{}<footer>{} / {}</footer></section>'.format(
                escape(slide.get('title') or ''), bullet_list, paragraph, index, len(order))
        )
    return '\n'.join(out)


BODY = {KIND_DOC: _doc_html, KIND_SHEET: _sheet_html, KIND_DECK: _deck_html}

STYLE = """
  :root { color-scheme: light; }
  body { font: 15px/1.6 -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; margin: 0; padding: 32px; background: #fff; }
  main { max-width: 900px; margin: 0 auto; }
  h1.doc-title { font-size: 26px; margin: 0 0 4px; }
  .meta { color: #666; font-size: 12.5px; margin-bottom: 24px; }
  blockquote { border-left: 3px solid #ddd; margin: 0; padding-left: 14px; color: #444; }
  pre { background: #f5f5f7; padding: 12px; border-radius: 8px; overflow: auto; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; }
  th, td { border: 1px solid #d8d8dd; padding: 5px 8px; font-size: 13px; text-align: left; }
  table.grid th { background: #f5f5f7; text-align: center; }
  td { vertical-align: top; }
  img { max-width: 100%; }
  .slide { page-break-after: always; border: 1px solid #e3e3e8; border-radius: 12px; padding: 28px; margin-bottom: 20px; min-height: 420px; position: relative; }
  .slide h2 { margin-top: 0; font-size: 24px; }
  .slide footer { position: absolute; right: 18px; bottom: 14px; color: #888; font-size: 12px; }
  @media print { body { padding: 0; } .slide { border: none; min-height: 100vh; } }
"""


def to_html(doc, author='') -> str:
    body = BODY[doc.kind](doc)
    when = doc.updated_at.strftime('%d.%m.%Y %H:%M')
    return (
        '<!doctype html><html lang="ru"><head><meta charset="utf-8">'
        f'<title>{escape(doc.title)}</title><style>{STYLE}</style></head><body><main>'
        f'<h1 class="doc-title">{escape(doc.title)}</h1>'
        f'<div class="meta">{escape(author)} · {when}</div>'
        f'{body}</main></body></html>'
    )
