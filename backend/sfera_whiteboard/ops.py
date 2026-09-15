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
    kind = raw.get('type')
    if kind not in SHAPE_TYPES:
        raise OpError('bad_type')
    finite = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and abs(v) < 1e7  # noqa: E731
    if kind == 'pen':
        pts = raw.get('points')
        if not isinstance(pts, list) or len(pts) < 2 or len(pts) > 40000 or not all(finite(v) for v in pts):
            raise OpError('bad_points')
    elif kind == 'line':
        for end in (raw.get('from'), raw.get('to')):
            if not isinstance(end, dict) or not finite(end.get('x')) or not finite(end.get('y')):
                raise OpError('bad_endpoint')
    elif not all(finite(raw.get(k)) for k in ('x', 'y', 'w', 'h')):
        raise OpError('bad_geometry')
    if 'style' in raw and not isinstance(raw['style'], dict):
        raise OpError('bad_style')
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
