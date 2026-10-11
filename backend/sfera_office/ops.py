"""Applying edits to a document, a spreadsheet or a deck.

Clients send small ops and the server replays them onto the stored JSON under a
row lock. Last write wins per block / cell / slide, which is what co-authors
expect from this kind of editing: two people rarely type in the same paragraph,
and when they do, the later keystroke is the one that stays.

Documents  {"blocks": {id: block}, "order": [id, ...]}
    {"op": "block.put", "block": {...}}       create or replace a block
    {"op": "block.del", "id": "..."}          delete a block
    {"op": "order", "order": [id, ...]}       new block order

Spreadsheets  {"cells": {"A1": {"v": "=SUM(B1:B4)"}}, "rows": n, "cols": n, "widths": {}}
    {"op": "cell.set", "ref": "A1", "cell": {...}}
    {"op": "cell.clear", "ref": "A1"}
    {"op": "size", "rows": n, "cols": n}
    {"op": "width", "col": 3, "w": 140}

Decks  {"slides": {id: slide}, "order": [id, ...], "theme": "light"}
    {"op": "slide.put", "slide": {...}}
    {"op": "slide.del", "id": "..."}
    {"op": "order", "order": [id, ...]}
    {"op": "theme", "theme": "light"}
"""
import json
import re

from .models import KIND_DECK, KIND_DOC, KIND_SHEET, MAX_BLOCKS, MAX_CELLS, MAX_DOC_BYTES, MAX_SLIDES

ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,40}$')
REF_RE = re.compile(r'^[A-Z]{1,3}[1-9][0-9]{0,4}$')
BLOCK_TYPES = {'p', 'h1', 'h2', 'h3', 'ul', 'ol', 'quote', 'code', 'divider', 'todo', 'image', 'table'}
SLIDE_LAYOUTS = {'title', 'bullets', 'text', 'two', 'image', 'blank'}
THEMES = {'light', 'dark', 'ink', 'sky'}
MAX_OPS = 400
MAX_TEXT = 20_000
MAX_CELL_TEXT = 4000
MAX_ROWS, MAX_COLS = 5000, 100


class OpError(ValueError):
    pass


def _text(value, limit=MAX_TEXT) -> str:
    if value is None:
        return ''
    if not isinstance(value, str):
        raise OpError('bad_text')
    if len(value) > limit:
        raise OpError('text_too_long')
    return value


def _int(value, low, high) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        raise OpError('bad_number')
    return value


def _style(raw) -> dict:
    if raw is None:
        return {}
    if not isinstance(raw, dict) or len(raw) > 20:
        raise OpError('bad_style')
    out = {}
    for key, value in raw.items():
        if not isinstance(key, str) or len(key) > 24:
            raise OpError('bad_style')
        if isinstance(value, bool) or value is None:
            out[key] = bool(value)
        elif isinstance(value, (int, float)):
            out[key] = value
        else:
            out[key] = _text(value, 64)
    return out


def _clean_block(raw) -> dict:
    if not isinstance(raw, dict):
        raise OpError('bad_block')
    bid = str(raw.get('id', ''))
    if not ID_RE.match(bid):
        raise OpError('bad_id')
    kind = raw.get('type')
    if kind not in BLOCK_TYPES:
        raise OpError('bad_type')
    block = {'id': bid, 'type': kind, 'text': _text(raw.get('text'))}
    if kind == 'todo':
        block['done'] = bool(raw.get('done'))
    if kind == 'code':
        block['lang'] = _text(raw.get('lang'), 24)
    if kind == 'image':
        block['url'] = _text(raw.get('url'), 1000)
        block['alt'] = _text(raw.get('alt'), 300)
    if kind == 'table':
        rows = raw.get('rows')
        if not isinstance(rows, list) or len(rows) > 200:
            raise OpError('bad_table')
        block['rows'] = [[_text(c, 2000) for c in row[:20]] if isinstance(row, list) else [] for row in rows]
    if raw.get('style'):
        block['style'] = _style(raw['style'])
    return block


def _clean_cell(raw) -> dict:
    if not isinstance(raw, dict):
        raise OpError('bad_cell')
    cell = {'v': _text(raw.get('v'), MAX_CELL_TEXT)}
    if raw.get('style'):
        cell['style'] = _style(raw['style'])
    return cell


def _clean_slide(raw) -> dict:
    if not isinstance(raw, dict):
        raise OpError('bad_slide')
    sid = str(raw.get('id', ''))
    if not ID_RE.match(sid):
        raise OpError('bad_id')
    layout = raw.get('layout', 'text')
    if layout not in SLIDE_LAYOUTS:
        raise OpError('bad_layout')
    bullets = raw.get('bullets') or []
    if not isinstance(bullets, list) or len(bullets) > 24:
        raise OpError('bad_bullets')
    return {
        'id': sid, 'layout': layout,
        'title': _text(raw.get('title'), 400),
        'body': _text(raw.get('body'), 6000),
        'bullets': [_text(b, 400) for b in bullets],
        'notes': _text(raw.get('notes'), 4000),
        'image': _text(raw.get('image'), 1000),
        **({'style': _style(raw['style'])} if raw.get('style') else {}),
    }


def _reorder(order, keys, new):
    new = [str(x) for x in (new or []) if str(x) in keys]
    seen = set(new)
    return list(dict.fromkeys(new + [x for x in order if x not in seen and x in keys]))


def _apply_doc(data, ops):
    blocks = dict(data.get('blocks') or {})
    order = [x for x in (data.get('order') or []) if x in blocks]
    for op in ops:
        kind = op.get('op')
        if kind == 'block.put':
            block = _clean_block(op.get('block'))
            if block['id'] not in blocks:
                if len(blocks) >= MAX_BLOCKS:
                    raise OpError('too_many_blocks')
                at = op.get('at')
                if at is None:
                    order.append(block['id'])
                else:
                    order.insert(max(0, min(len(order), _int(at, 0, MAX_BLOCKS))), block['id'])
            blocks[block['id']] = block
        elif kind == 'block.del':
            bid = str(op.get('id', ''))
            blocks.pop(bid, None)
            order = [x for x in order if x != bid]
        elif kind == 'order':
            order = _reorder(order, blocks, op.get('order'))
        else:
            raise OpError('bad_op')
    return {'blocks': blocks, 'order': [x for x in order if x in blocks]}


def _apply_sheet(data, ops):
    cells = dict(data.get('cells') or {})
    rows = int(data.get('rows') or 50)
    cols = int(data.get('cols') or 12)
    widths = dict(data.get('widths') or {})
    for op in ops:
        kind = op.get('op')
        if kind == 'cell.set':
            ref = str(op.get('ref', ''))
            if not REF_RE.match(ref):
                raise OpError('bad_ref')
            cell = _clean_cell(op.get('cell'))
            if not cell['v'] and not cell.get('style'):
                cells.pop(ref, None)
                continue
            if ref not in cells and len(cells) >= MAX_CELLS:
                raise OpError('too_many_cells')
            cells[ref] = cell
        elif kind == 'cell.clear':
            cells.pop(str(op.get('ref', '')), None)
        elif kind == 'size':
            rows = _int(op.get('rows', rows), 1, MAX_ROWS)
            cols = _int(op.get('cols', cols), 1, MAX_COLS)
        elif kind == 'width':
            col = _int(op.get('col'), 0, MAX_COLS - 1)
            widths[str(col)] = _int(op.get('w'), 32, 1200)
        else:
            raise OpError('bad_op')
    return {'cells': cells, 'rows': rows, 'cols': cols, 'widths': widths}


def _apply_deck(data, ops):
    slides = dict(data.get('slides') or {})
    order = [x for x in (data.get('order') or []) if x in slides]
    theme = data.get('theme') or 'light'
    for op in ops:
        kind = op.get('op')
        if kind == 'slide.put':
            slide = _clean_slide(op.get('slide'))
            if slide['id'] not in slides:
                if len(slides) >= MAX_SLIDES:
                    raise OpError('too_many_slides')
                at = op.get('at')
                if at is None:
                    order.append(slide['id'])
                else:
                    order.insert(max(0, min(len(order), _int(at, 0, MAX_SLIDES))), slide['id'])
            slides[slide['id']] = slide
        elif kind == 'slide.del':
            sid = str(op.get('id', ''))
            slides.pop(sid, None)
            order = [x for x in order if x != sid]
        elif kind == 'order':
            order = _reorder(order, slides, op.get('order'))
        elif kind == 'theme':
            if op.get('theme') not in THEMES:
                raise OpError('bad_theme')
            theme = op['theme']
        else:
            raise OpError('bad_op')
    return {'slides': slides, 'order': [x for x in order if x in slides], 'theme': theme}


APPLY = {KIND_DOC: _apply_doc, KIND_SHEET: _apply_sheet, KIND_DECK: _apply_deck}


def apply_ops(kind: str, data: dict, ops: list) -> dict:
    """Return the new document; raises OpError on invalid input."""
    if not isinstance(ops, list) or not ops or len(ops) > MAX_OPS:
        raise OpError('bad_ops')
    if not all(isinstance(op, dict) for op in ops):
        raise OpError('bad_ops')
    handler = APPLY.get(kind)
    if handler is None:
        raise OpError('bad_kind')
    out = handler(data if isinstance(data, dict) else {}, ops)
    if len(json.dumps(out, ensure_ascii=False)) > MAX_DOC_BYTES:
        raise OpError('doc_too_big')
    return out
