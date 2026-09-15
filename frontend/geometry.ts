import type { BoxShape, Doc, EndPoint, LineShape, PenShape, Shape, Side } from './types';

export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

export const isBox = (s: Shape): s is BoxShape => s.type !== 'line' && s.type !== 'pen';

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function normRect(a: Pt, b: Pt): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

export function snap(v: number, grid: number, on: boolean) {
  return on ? Math.round(v / grid) * grid : v;
}

export function anchorPoint(box: Rect, side: Side): Pt {
  switch (side) {
    case 'top': return { x: box.x + box.w / 2, y: box.y };
    case 'bottom': return { x: box.x + box.w / 2, y: box.y + box.h };
    case 'left': return { x: box.x, y: box.y + box.h / 2 };
    default: return { x: box.x + box.w, y: box.y + box.h / 2 };
  }
}

export const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];

/** Side of `box` facing point `p`. */
export function facingSide(box: Rect, p: Pt): Side {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = (p.x - cx) / Math.max(box.w, 1);
  const dy = (p.y - cy) / Math.max(box.h, 1);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'bottom' : 'top';
}

function centerOf(r: Rect): Pt {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Resolved end of a connector: its point and the side it leaves from (if attached). */
export function resolveEnd(doc: Doc, end: EndPoint, other: EndPoint): { p: Pt; side?: Side } {
  const target = end.shapeId ? doc.shapes[end.shapeId] : undefined;
  if (!target || !isBox(target)) return { p: { x: end.x, y: end.y } };
  const otherShape = other.shapeId ? doc.shapes[other.shapeId] : undefined;
  const otherPt = otherShape && isBox(otherShape) ? centerOf(otherShape) : { x: other.x, y: other.y };
  const side = !end.side || end.side === 'auto' ? facingSide(target, otherPt) : end.side;
  return { p: anchorPoint(target, side), side };
}

const OUT = 24;
const push = (p: Pt, side: Side | undefined, d = OUT): Pt => {
  if (side === 'top') return { x: p.x, y: p.y - d };
  if (side === 'bottom') return { x: p.x, y: p.y + d };
  if (side === 'left') return { x: p.x - d, y: p.y };
  if (side === 'right') return { x: p.x + d, y: p.y };
  return p;
};
const horizontal = (s?: Side) => s === 'left' || s === 'right';

/** Polyline of a connector in board coordinates. */
export function linePoints(doc: Doc, line: LineShape): Pt[] {
  const a = resolveEnd(doc, line.from, line.to);
  const b = resolveEnd(doc, line.to, line.from);
  if (line.route !== 'orthogonal') return [a.p, b.p];
  const a1 = push(a.p, a.side);
  const b1 = push(b.p, b.side);
  const pts: Pt[] = [a.p, a1];
  const aH = a.side ? horizontal(a.side) : Math.abs(b1.x - a1.x) > Math.abs(b1.y - a1.y);
  const bH = b.side ? horizontal(b.side) : aH;
  if (aH && bH) {
    const mx = (a1.x + b1.x) / 2;
    pts.push({ x: mx, y: a1.y }, { x: mx, y: b1.y });
  } else if (!aH && !bH) {
    const my = (a1.y + b1.y) / 2;
    pts.push({ x: a1.x, y: my }, { x: b1.x, y: my });
  } else if (aH) {
    pts.push({ x: b1.x, y: a1.y });
  } else {
    pts.push({ x: a1.x, y: b1.y });
  }
  pts.push(b1, b.p);
  // Drop repeated points so arrowheads get a real direction.
  const out = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 0.5);
  // A connector with both ends in one place still needs two points.
  return out.length >= 2 ? out : [a.p, b.p];
}

export function linePath(doc: Doc, line: LineShape): string {
  const pts = linePoints(doc, line);
  if (line.route === 'curved' && pts.length === 2) {
    const a = resolveEnd(doc, line.from, line.to);
    const b = resolveEnd(doc, line.to, line.from);
    const dist = Math.max(40, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) / 2.5);
    const c1 = a.side ? push(pts[0], a.side, dist) : { x: (pts[0].x * 2 + pts[1].x) / 3, y: pts[0].y };
    const c2 = b.side ? push(pts[1], b.side, dist) : { x: (pts[0].x + pts[1].x * 2) / 3, y: pts[1].y };
    return `M${pts[0].x},${pts[0].y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${pts[1].x},${pts[1].y}`;
  }
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
}

/** Direction into the end point, for drawing an arrowhead. */
export function endDirection(doc: Doc, line: LineShape, which: 'from' | 'to'): { tip: Pt; angle: number } {
  const pts = linePoints(doc, line);
  if (line.route === 'curved' && pts.length === 2) {
    const end = which === 'to' ? resolveEnd(doc, line.to, line.from) : resolveEnd(doc, line.from, line.to);
    const tip = which === 'to' ? pts[1] : pts[0];
    if (end.side) {
      const out = push(tip, end.side, 10);
      return { tip, angle: Math.atan2(tip.y - out.y, tip.x - out.x) };
    }
  }
  const [p, q] = which === 'to' ? [pts[pts.length - 2], pts[pts.length - 1]] : [pts[1], pts[0]];
  if (!p || !q) return { tip: pts[0] ?? { x: 0, y: 0 }, angle: 0 };
  return { tip: q, angle: Math.atan2(q.y - p.y, q.x - p.x) };
}

export function midpoint(doc: Doc, line: LineShape): Pt {
  const pts = linePoints(doc, line);
  let total = 0;
  const segs = pts.slice(1).map((p, i) => { const l = Math.hypot(p.x - pts[i].x, p.y - pts[i].y); total += l; return l; });
  let left = total / 2;
  for (let i = 0; i < segs.length; i++) {
    if (left <= segs[i]) {
      const t = segs[i] ? left / segs[i] : 0;
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t };
    }
    left -= segs[i];
  }
  return pts[0];
}

export function distToSegment(p: Pt, a: Pt, b: Pt) {
  const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
}

export function penBounds(s: PenShape): Rect {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (let i = 0; i < s.points.length; i += 2) {
    x1 = Math.min(x1, s.points[i]); x2 = Math.max(x2, s.points[i]);
    y1 = Math.min(y1, s.points[i + 1]); y2 = Math.max(y2, s.points[i + 1]);
  }
  return Number.isFinite(x1) ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : { x: 0, y: 0, w: 0, h: 0 };
}

export function boundsOf(doc: Doc, s: Shape): Rect {
  if (isBox(s)) return { x: s.x, y: s.y, w: s.w, h: s.h };
  if (s.type === 'pen') return penBounds(s);
  const pts = linePoints(doc, s);
  const xs = pts.map(p => p.x);
  const ys = pts.map(p => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

export function unionBounds(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  const x = Math.min(...rects.map(r => r.x));
  const y = Math.min(...rects.map(r => r.y));
  return { x, y, w: Math.max(...rects.map(r => r.x + r.w)) - x, h: Math.max(...rects.map(r => r.y + r.h)) - y };
}

/** Top-most shape under a board point (connectors and strokes get a tolerance). */
export function hitTest(doc: Doc, p: Pt, tolerance: number, skip?: (s: Shape) => boolean): Shape | null {
  for (let i = doc.order.length - 1; i >= 0; i--) {
    const s = doc.shapes[doc.order[i]];
    if (!s || skip?.(s)) continue;
    if (s.type === 'line') {
      const pts = linePoints(doc, s);
      for (let j = 1; j < pts.length; j++) if (distToSegment(p, pts[j - 1], pts[j]) <= tolerance + s.style.strokeWidth) return s;
    } else if (s.type === 'pen') {
      for (let j = 2; j < s.points.length; j += 2) {
        if (distToSegment(p, { x: s.points[j - 2], y: s.points[j - 1] }, { x: s.points[j], y: s.points[j + 1] }) <= tolerance + s.style.strokeWidth) return s;
      }
    } else if (s.type === 'frame') {
      // A frame is picked by its title bar and edge, so shapes inside stay clickable.
      const inside = p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y - 24 && p.y <= s.y + s.h;
      const edge = p.y < s.y + tolerance || p.x < s.x + tolerance || p.x > s.x + s.w - tolerance || p.y > s.y + s.h - tolerance;
      if (inside && edge) return s;
    } else if (p.x >= s.x - tolerance / 2 && p.x <= s.x + s.w + tolerance / 2 && p.y >= s.y - tolerance / 2 && p.y <= s.y + s.h + tolerance / 2) {
      if (s.style.fill === 'transparent' && s.type !== 'text' && !s.text) {
        const edge = Math.min(Math.abs(p.x - s.x), Math.abs(p.x - s.x - s.w), Math.abs(p.y - s.y), Math.abs(p.y - s.y - s.h));
        if (edge > tolerance + s.style.strokeWidth) continue;
      }
      return s;
    }
  }
  return null;
}

/** Svg path for box outlines that are not plain rects. */
export function boxPath(s: BoxShape): string | null {
  const { x, y, w, h } = s;
  switch (s.type) {
    case 'diamond': return `M${x + w / 2},${y} L${x + w},${y + h / 2} L${x + w / 2},${y + h} L${x},${y + h / 2} Z`;
    case 'triangle': return `M${x + w / 2},${y} L${x + w},${y + h} L${x},${y + h} Z`;
    case 'hexagon': {
      const d = Math.min(w / 4, h / 2);
      return `M${x + d},${y} L${x + w - d},${y} L${x + w},${y + h / 2} L${x + w - d},${y + h} L${x + d},${y + h} L${x},${y + h / 2} Z`;
    }
    case 'cylinder': {
      const ry = Math.min(h / 6, 18);
      return `M${x},${y + ry} A${w / 2},${ry} 0 0 1 ${x + w},${y + ry} L${x + w},${y + h - ry} A${w / 2},${ry} 0 0 1 ${x},${y + h - ry} Z M${x},${y + ry} A${w / 2},${ry} 0 0 0 ${x + w},${y + ry}`;
    }
    case 'cloud': {
      return `M${x + w * 0.25},${y + h * 0.85} C${x - w * 0.05},${y + h * 0.85} ${x - w * 0.02},${y + h * 0.45} ${x + w * 0.2},${y + h * 0.45}`
        + ` C${x + w * 0.18},${y + h * 0.1} ${x + w * 0.55},${y + h * 0.02} ${x + w * 0.62},${y + h * 0.3}`
        + ` C${x + w * 0.8},${y + h * 0.12} ${x + w * 1.02},${y + h * 0.35} ${x + w * 0.88},${y + h * 0.55}`
        + ` C${x + w * 1.05},${y + h * 0.7} ${x + w * 0.95},${y + h * 0.9} ${x + w * 0.78},${y + h * 0.85} Z`;
    }
    default: return null;
  }
}

export function arrowHead(kind: LineShape['arrowEnd'], tip: Pt, angle: number, size: number): { d: string; filled: boolean } | null {
  if (kind === 'none') return null;
  const s = size;
  const rot = (dx: number, dy: number) => ({
    x: tip.x + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: tip.y + dx * Math.sin(angle) + dy * Math.cos(angle),
  });
  if (kind === 'arrow') {
    const a = rot(-s * 1.4, -s * 0.8);
    const b = rot(-s * 1.4, s * 0.8);
    return { d: `M${a.x},${a.y} L${tip.x},${tip.y} L${b.x},${b.y}`, filled: false };
  }
  if (kind === 'triangle') {
    const a = rot(-s * 1.6, -s * 0.8);
    const b = rot(-s * 1.6, s * 0.8);
    return { d: `M${a.x},${a.y} L${tip.x},${tip.y} L${b.x},${b.y} Z`, filled: true };
  }
  if (kind === 'diamond') {
    const a = rot(-s, -s * 0.7);
    const b = rot(-s * 2, 0);
    const c = rot(-s, s * 0.7);
    return { d: `M${tip.x},${tip.y} L${a.x},${a.y} L${b.x},${b.y} L${c.x},${c.y} Z`, filled: true };
  }
  const c = rot(-s * 0.7, 0);
  const r = s * 0.7;
  return { d: `M${c.x - r},${c.y} a${r},${r} 0 1,0 ${r * 2},0 a${r},${r} 0 1,0 ${-r * 2},0`, filled: true };
}

/** Pen stroke as a smoothed path (quadratic through midpoints). */
export function penPath(points: number[]): string {
  if (points.length < 4) return points.length === 2 ? `M${points[0]},${points[1]} l0.1,0` : '';
  let d = `M${points[0]},${points[1]}`;
  for (let i = 2; i < points.length - 2; i += 2) {
    const mx = (points[i] + points[i + 2]) / 2;
    const my = (points[i + 1] + points[i + 3]) / 2;
    d += ` Q${points[i]},${points[i + 1]} ${mx},${my}`;
  }
  d += ` L${points[points.length - 2]},${points[points.length - 1]}`;
  return d;
}

/** Drop points closer than `min` to the previous kept one. */
export function simplify(points: number[], min: number) {
  const out = points.slice(0, 2);
  for (let i = 2; i < points.length; i += 2) {
    if (Math.hypot(points[i] - out[out.length - 2], points[i + 1] - out[out.length - 1]) >= min) out.push(points[i], points[i + 1]);
  }
  if (points.length > 2 && (out[out.length - 2] !== points[points.length - 2] || out[out.length - 1] !== points[points.length - 1])) {
    out.push(points[points.length - 2], points[points.length - 1]);
  }
  return out;
}
