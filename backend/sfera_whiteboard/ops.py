"""Applying edits to a board document.

The document is ``{"shapes": {id: shape}, "order": [id, ...]}``. Clients send
small ops and the last write wins per shape, which is what collaborators expect
from a diagram (two people rarely drag the same box at once):

    {"op": "put", "shape": {...}}   create or replace a shape
    {"op": "del", "id": "..."}      delete a shape (and its dangling connector ends)
    {"op": "order", "order": [...]} new z-order (ids not on the board are dropped)
"""
import json
import re

from .models import MAX_DOC_BYTES, MAX_SHAPES

ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,40}$')
SHAPE_TYPES = {'rect', 'ellipse', 'diamond', 'text', 'note', 'line', 'pen', 'triangle', 'hexagon', 'cylinder', 'cloud', 'frame'}
MAX_OPS = 500


class OpError(ValueError):
    pass


def _clean_shape(raw) -> dict:
    if not isinstance(raw, dict):
        raise OpError('bad_shape')
    sid = str(raw.get('id', ''))
    if not ID_RE.match(sid):
        raise OpError('bad_id')
    if raw.get('type') not in SHAPE_TYPES:
        raise OpError('bad_type')
    size = len(json.dumps(raw, ensure_ascii=False))
    if size > 200_000:
        raise OpError('shape_too_big')
    return raw


def apply_ops(doc: dict, ops: list) -> dict:
    """Return the new document; raises OpError on invalid input."""
    if not isinstance(ops, list) or not ops or len(ops) > MAX_OPS:
        raise OpError('bad_ops')
    shapes = dict(doc.get('shapes') or {})
    order = list(doc.get('order') or [])
    for op in ops:
        kind = op.get('op') if isinstance(op, dict) else None
        if kind == 'put':
            shape = _clean_shape(op.get('shape'))
            if shape['id'] not in shapes:
                if len(shapes) >= MAX_SHAPES:
                    raise OpError('too_many_shapes')
                order.append(shape['id'])
            shapes[shape['id']] = shape
        elif kind == 'del':
            sid = str(op.get('id', ''))
            if sid in shapes:
                del shapes[sid]
                order = [x for x in order if x != sid]
        elif kind == 'order':
            new = [str(x) for x in (op.get('order') or []) if str(x) in shapes]
            seen = set(new)
            order = list(dict.fromkeys(new + [x for x in order if x not in seen]))
        else:
            raise OpError('bad_op')
    out = {'shapes': shapes, 'order': [x for x in order if x in shapes]}
    if len(json.dumps(out, ensure_ascii=False)) > MAX_DOC_BYTES:
        raise OpError('doc_too_big')
    return out
