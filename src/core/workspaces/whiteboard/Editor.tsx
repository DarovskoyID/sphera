import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useModuleT } from '@sfera/sdk';
import {
  SIDES, anchorPoint, boundsOf, contains, facingSide, hitTest, intersects, isBox, normRect, simplify, snap, uid, unionBounds,
  type Pt, type Rect,
} from './geometry';
import { ShapeView } from './render';
import type { BoardSession } from './session';
import { PropertiesPanel, Toolbar, ZoomBar } from './Panels';
import { DEFAULT_STYLE, NOTE_FILLS, type BoxShape, type BoxType, type Doc, type EndPoint, type LineShape, type Op, type PenShape, type Shape, type Side, type Tool } from './types';
import { useIsMobile } from './ui';

const GRID = 10;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const CLIP_PREFIX = 'sfera-whiteboard:';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

type Interaction =
  | { kind: 'pan'; start: Pt; pan: Pt }
  | { kind: 'move'; start: Pt; base: Doc; ids: string[]; moved: boolean }
  | { kind: 'resize'; start: Pt; base: Doc; ids: string[]; handle: Handle; box: Rect }
  | { kind: 'marquee'; start: Pt; current: Pt; additive: boolean; initial: string[] }
  | { kind: 'create'; start: Pt; base: Doc; id: string; type: BoxType }
  | { kind: 'line'; base: Doc; id: string }
  | { kind: 'endpoint'; base: Doc; id: string; which: 'from' | 'to' }
  | { kind: 'pen'; base: Doc; id: string; points: number[] };

export interface EditorApi {
  zoomBy: (f: number) => void;
  fit: () => void;
}

const HANDLE_CURSORS: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

function newBox(type: BoxType, r: Rect, frameTitle = 'Frame'): BoxShape {
  const style = { ...DEFAULT_STYLE, stroke: 'ink', textColor: 'ink', fill: 'paper' };
  if (type === 'note') Object.assign(style, { fill: NOTE_FILLS[0], strokeWidth: 0, align: 'left', vAlign: 'top', fontSize: 16 });
  if (type === 'text') Object.assign(style, { fill: 'transparent', strokeWidth: 0, fontSize: 20, align: 'left', vAlign: 'top' });
  if (type === 'frame') Object.assign(style, { fill: 'transparent', stroke: '#94a3b8', strokeWidth: 1.5, dash: 'dashed' });
  return { id: uid(), type, ...r, text: type === 'frame' ? frameTitle : '', style };
}

const DEFAULT_SIZE: Record<BoxType, [number, number]> = {
  rect: [160, 90], ellipse: [140, 100], diamond: [140, 110], triangle: [130, 110], hexagon: [160, 90], cylinder: [120, 130],
  cloud: [180, 110], note: [180, 180], text: [220, 40], frame: [480, 320],
};

/**
 * Exported SVG must not contain foreignObject (browsers refuse to rasterize it
 * into PNG): turn every text block into wrapped <text> lines.
 */
function textToSvg(g: SVGGElement): string {
  const clone = g.cloneNode(true) as SVGGElement;
  const live = [...g.querySelectorAll('foreignObject')];
  const ctx = document.createElement('canvas').getContext('2d')!;
  [...clone.querySelectorAll('foreignObject')].forEach((fo, i) => {
    const div = live[i]?.firstElementChild as HTMLElement | undefined;
    if (!div) { fo.remove(); return; }
    const cs = getComputedStyle(div);
    const size = parseFloat(cs.fontSize) || 16;
    const pad = parseFloat(cs.paddingLeft) || 0;
    const x = parseFloat(fo.getAttribute('x') || '0');
    const y = parseFloat(fo.getAttribute('y') || '0');
    const w = parseFloat(fo.getAttribute('width') || '0');
    const h = parseFloat(fo.getAttribute('height') || '0');
    ctx.font = `${cs.fontWeight} ${size}px Inter, system-ui, sans-serif`;
    const lines: string[] = [];
    for (const para of (div.textContent || '').split('\n')) {
      let line = '';
      for (const word of para.split(/(\s+)/)) {
        if (line && ctx.measureText(line + word).width > w - pad * 2) { lines.push(line.trimEnd()); line = word.trimStart(); }
        else line += word;
      }
      lines.push(line);
    }
    const lh = size * 1.3;
    const block = lines.length * lh;
    const top = cs.justifyContent === 'flex-start' ? y + pad : cs.justifyContent === 'flex-end' ? y + h - pad - block : y + (h - block) / 2;
    const anchor = cs.textAlign === 'center' ? 'middle' : cs.textAlign === 'right' ? 'end' : 'start';
    const tx = anchor === 'middle' ? x + w / 2 : anchor === 'end' ? x + w - pad : x + pad;
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('font-size', String(size));
    text.setAttribute('font-weight', cs.fontWeight);
    text.setAttribute('font-family', 'Inter, system-ui, sans-serif');
    text.setAttribute('fill', div.style.color || cs.color);
    text.setAttribute('text-anchor', anchor);
    lines.forEach((l, j) => {
      const span = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
      span.setAttribute('x', String(tx));
      span.setAttribute('y', String(top + lh * j + size));
      span.textContent = l;
      text.appendChild(span);
    });
    fo.replaceWith(text);
  });
  return new XMLSerializer().serializeToString(clone).replace(/^<g[^>]*>|<\/g>$/g, '');
}

function isEditableTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el?.closest?.('input, textarea, select, [contenteditable="true"]');
}

export function Editor({ session, readOnly, onExportReady }: {
  session: BoardSession;
  readOnly: boolean;
  onExportReady?: (fn: { svg: () => string | null; api: EditorApi }) => void;
}) {
  const t = useModuleT();
  const mobile = useIsMobile();
  useSyncExternalStore(session.subscribe, session.snapshot);
  const doc = session.doc;

  const svgRef = useRef<SVGSVGElement>(null);
  const contentRef = useRef<SVGGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [toolLock, setToolLock] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [pan, setPan] = useState<Pt>({ x: 80, y: 80 });
  const [zoom, setZoom] = useState(1);
  const [grid, setGrid] = useState(true);
  const [space, setSpace] = useState(false);
  const [lineTarget, setLineTarget] = useState<{ id: string; side?: Side } | null>(null);
  const interaction = useRef<Interaction | null>(null);
  const [, force] = useState(0);
  const pointers = useRef(new Map<number, Pt>());
  const pinch = useRef<{ dist: number; zoom: number; mid: Pt; pan: Pt } | null>(null);
  const clipboard = useRef<Shape[]>([]);
  const lastPointer = useRef<Pt>({ x: 0, y: 0 });
  const effectiveTool: Tool = readOnly && tool !== 'hand' ? 'select' : tool;

  // Selection of deleted shapes (undo, collaborators) disappears.
  useEffect(() => {
    setSelection(sel => (sel.every(id => doc.shapes[id]) ? sel : sel.filter(id => doc.shapes[id])));
    if (editing && !doc.shapes[editing]) setEditing(null);
  }, [doc, editing]);

  const toBoard = useCallback((clientX: number, clientY: number): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left - pan.x) / zoom, y: (clientY - r.top - pan.y) / zoom };
  }, [pan, zoom]);

  const zoomAt = useCallback((next: number, screen?: Pt) => {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    const r = svgRef.current?.getBoundingClientRect();
    const sx = screen ? screen.x - (r?.left ?? 0) : (r?.width ?? 0) / 2;
    const sy = screen ? screen.y - (r?.top ?? 0) : (r?.height ?? 0) / 2;
    setPan(p => ({ x: sx - ((sx - p.x) / zoom) * z, y: sy - ((sy - p.y) / zoom) * z }));
    setZoom(z);
  }, [zoom]);

  const fit = useCallback(() => {
    const b = unionBounds(doc.order.map(id => boundsOf(doc, doc.shapes[id])));
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || r.width < 50 || r.height < 50) return false;
    if (!b) { setZoom(1); setPan({ x: 80, y: 80 }); return true; }
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(Math.max(r.width - 120, 100) / Math.max(b.w, 1), Math.max(r.height - 160, 100) / Math.max(b.h, 1), 1.25)));
    setZoom(z);
    setPan({ x: r.width / 2 - (b.x + b.w / 2) * z, y: r.height / 2 - (b.y + b.h / 2) * z + 20 });
    return true;
  }, [doc]);

  // Open at the content.
  const fitted = useRef(false);
  useEffect(() => {
    const el = svgRef.current;
    if (fitted.current || !el) return;
    // Wait until the canvas has its size (the view is laid out after mount).
    const ro = new ResizeObserver(() => {
      if (fitted.current) return;
      if (!doc.order.length || fit()) { fitted.current = true; ro.disconnect(); }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc, fit]);

  const exportSvg = useCallback(() => {
    const g = contentRef.current;
    if (!g || !doc.order.length) return null;
    const b = unionBounds(doc.order.map(id => boundsOf(doc, doc.shapes[id])))!;
    const pad = 24;
    const inner = textToSvg(g).replaceAll('var(--wb-ink)', '#1f2937').replaceAll('var(--wb-paper)', '#ffffff');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x - pad} ${b.y - pad - 20} ${b.w + pad * 2} ${b.h + pad * 2 + 20}" width="${Math.ceil(b.w + pad * 2)}" height="${Math.ceil(b.h + pad * 2 + 20)}"><rect x="${b.x - pad}" y="${b.y - pad - 20}" width="${b.w + pad * 2}" height="${b.h + pad * 2 + 20}" fill="#ffffff"/>${inner}</svg>`;
  }, [doc]);

  useEffect(() => {
    onExportReady?.({ svg: exportSvg, api: { zoomBy: f => zoomAt(zoom * f), fit: () => { fit(); } } });
  }, [exportSvg, zoomAt, zoom, fit, onExportReady]);

  const selectedShapes = selection.map(id => doc.shapes[id]).filter(Boolean) as Shape[];
  const selBounds = unionBounds(selectedShapes.map(s => boundsOf(doc, s)));
  const singleLine = selectedShapes.length === 1 && selectedShapes[0].type === 'line' ? selectedShapes[0] as LineShape : null;

  // ── Edits ────────────────────────────────────────────────────────────────

  const commit = useCallback((ops: Op[], base?: Doc) => { if (!readOnly) session.commit(ops, base); }, [readOnly, session]);

  const deleteSelection = useCallback(() => {
    if (!selection.length) return;
    const ids = new Set(selection);
    const ops: Op[] = selection.map(id => ({ op: 'del', id }));
    // Connectors keep their position when the shape they pointed at is gone.
    for (const id of doc.order) {
      const s = doc.shapes[id];
      if (s.type !== 'line' || ids.has(id)) continue;
      const detach = (e: EndPoint): EndPoint => {
        if (!e.shapeId || !ids.has(e.shapeId)) return e;
        const target = doc.shapes[e.shapeId];
        const p = target && isBox(target) ? anchorPoint(target, e.side && e.side !== 'auto' ? e.side : 'right') : e;
        return { x: p.x, y: p.y };
      };
      const from = detach(s.from);
      const to = detach(s.to);
      if (from !== s.from || to !== s.to) ops.push({ op: 'put', shape: { ...s, from, to } });
    }
    commit(ops);
    setSelection([]);
  }, [selection, doc, commit]);

  const duplicate = useCallback((shapes: Shape[], offset = 20) => {
    const map = new Map<string, string>();
    shapes.forEach(s => map.set(s.id, uid()));
    const copies = shapes.map(s => {
      const id = map.get(s.id)!;
      if (s.type === 'line') {
        const end = (e: EndPoint): EndPoint => (e.shapeId && map.has(e.shapeId) ? { ...e, shapeId: map.get(e.shapeId) } : { x: e.x + offset, y: e.y + offset });
        return { ...s, id, from: end(s.from), to: end(s.to) };
      }
      if (s.type === 'pen') return { ...s, id, points: s.points.map(v => v + offset) };
      return { ...s, id, x: s.x + offset, y: s.y + offset };
    });
    commit(copies.map(shape => ({ op: 'put', shape })));
    setSelection(copies.map(c => c.id));
  }, [commit]);

  const updateShapes = useCallback((patch: (s: Shape) => Shape | null) => {
    const ops: Op[] = [];
    for (const s of selectedShapes) {
      const next = patch(s);
      if (next && next !== s) ops.push({ op: 'put', shape: next });
    }
    commit(ops);
  }, [selectedShapes, commit]);

  const reorder = useCallback((where: 'front' | 'back' | 'forward' | 'backward') => {
    if (!selection.length) return;
    const sel = new Set(selection);
    let order = [...doc.order];
    if (where === 'front') order = [...order.filter(id => !sel.has(id)), ...order.filter(id => sel.has(id))];
    else if (where === 'back') order = [...order.filter(id => sel.has(id)), ...order.filter(id => !sel.has(id))];
    else {
      const dir = where === 'forward' ? 1 : -1;
      const idxs = order.map((id, i) => (sel.has(id) ? i : -1)).filter(i => i >= 0);
      if (dir > 0) idxs.reverse();
      for (const i of idxs) {
        const j = i + dir;
        if (j < 0 || j >= order.length || sel.has(order[j])) continue;
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    commit([{ op: 'order', order }]);
  }, [selection, doc, commit]);

  const copy = useCallback((cut = false) => {
    if (!selectedShapes.length) return;
    const ids = new Set(selection);
    // Connectors between copied shapes come along.
    const extra = doc.order.map(id => doc.shapes[id]).filter(s => s.type === 'line' && !ids.has(s.id)
      && (s as LineShape).from.shapeId && ids.has((s as LineShape).from.shapeId!) && (s as LineShape).to.shapeId && ids.has((s as LineShape).to.shapeId!));
    clipboard.current = [...selectedShapes, ...extra];
    try { void navigator.clipboard?.writeText(CLIP_PREFIX + JSON.stringify(clipboard.current)); } catch { /* no permission */ }
    if (cut) deleteSelection();
  }, [selectedShapes, selection, doc, deleteSelection]);

  const paste = useCallback(async () => {
    let shapes = clipboard.current;
    try {
      const text = await navigator.clipboard?.readText();
      if (text?.startsWith(CLIP_PREFIX)) shapes = JSON.parse(text.slice(CLIP_PREFIX.length));
      else if (text && text.trim() && !shapes.length) {
        const p = lastPointer.current;
        const box = newBox('text', { x: p.x, y: p.y, w: Math.min(600, Math.max(120, text.length * 9)), h: 40 });
        box.text = text.slice(0, 5000);
        commit([{ op: 'put', shape: box }]);
        setSelection([box.id]);
        return;
      }
    } catch { /* clipboard not readable: internal copy */ }
    if (shapes.length) duplicate(shapes, 24);
  }, [duplicate, commit]);

  const nudge = useCallback((dx: number, dy: number) => {
    updateShapes(s => {
      if (s.locked) return null;
      if (s.type === 'pen') return { ...s, points: s.points.map((v, i) => v + (i % 2 ? dy : dx)) };
      if (s.type === 'line') {
        const mv = (e: EndPoint) => (e.shapeId ? e : { ...e, x: e.x + dx, y: e.y + dy });
        return { ...s, from: mv(s.from), to: mv(s.to) };
      }
      return { ...s, x: s.x + dx, y: s.y + dy };
    });
  }, [updateShapes]);

  // ── Keyboard ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || document.querySelector('[role="dialog"]')) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (e.code === 'Space' && !e.repeat) { setSpace(true); e.preventDefault(); return; }
      if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) session.redo(); else session.undo(); return; }
      if (mod && key === 'y') { e.preventDefault(); session.redo(); return; }
      if (mod && key === 'a') { e.preventDefault(); setSelection([...doc.order]); return; }
      if (mod && key === 'c') { copy(); return; }
      if (mod && key === 'x') { if (!readOnly) copy(true); return; }
      if (mod && key === 'v') { if (!readOnly) { e.preventDefault(); void paste(); } return; }
      if (mod && key === 'd') { e.preventDefault(); if (!readOnly && selectedShapes.length) duplicate(selectedShapes); return; }
      if (mod && (key === '=' || key === '+')) { e.preventDefault(); zoomAt(zoom * 1.2); return; }
      if (mod && key === '-') { e.preventDefault(); zoomAt(zoom / 1.2); return; }
      if (e.shiftKey && e.code === 'Digit1') { fit(); return; }
      if (e.shiftKey && e.code === 'Digit0') { zoomAt(1); return; }
      if (mod) return;
      if (key === 'escape') { setSelection([]); setTool('select'); setEditing(null); return; }
      if ((key === 'delete' || key === 'backspace') && !readOnly) { e.preventDefault(); deleteSelection(); return; }
      if (key === 'enter' && selectedShapes.length === 1 && !readOnly && selectedShapes[0].type !== 'pen') { e.preventDefault(); setEditing(selectedShapes[0].id); return; }
      if (key.startsWith('arrow') && selection.length && !readOnly) {
        e.preventDefault();
        const d = e.shiftKey ? GRID * 5 : 1;
        nudge(key === 'arrowleft' ? -d : key === 'arrowright' ? d : 0, key === 'arrowup' ? -d : key === 'arrowdown' ? d : 0);
        return;
      }
      if (key === ']') { reorder(e.altKey ? 'front' : 'forward'); return; }
      if (key === '[') { reorder(e.altKey ? 'back' : 'backward'); return; }
      const tools: Record<string, Tool> = { v: 'select', h: 'hand', r: 'rect', o: 'ellipse', d: 'diamond', t: 'text', n: 'note', l: 'line', a: 'line', p: 'pen', f: 'frame' };
      // Russian layout: the same physical keys.
      const byCode: Record<string, Tool> = { KeyV: 'select', KeyH: 'hand', KeyR: 'rect', KeyO: 'ellipse', KeyD: 'diamond', KeyT: 'text', KeyN: 'note', KeyL: 'line', KeyA: 'line', KeyP: 'pen', KeyF: 'frame' };
      const next = tools[key] ?? byCode[e.code];
      if (next && (!readOnly || next === 'select' || next === 'hand')) setTool(next);
    };
    const onUp = (e: KeyboardEvent) => { if (e.code === 'Space') setSpace(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onUp); };
  }, [session, doc, copy, paste, duplicate, selectedShapes, selection, zoomAt, zoom, fit, deleteSelection, nudge, reorder, readOnly]);

  // Wheel: scroll pans, ctrl/cmd + wheel (and trackpad pinch) zooms at the pointer.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomAt(zoom * Math.exp(-e.deltaY * 0.0022), { x: e.clientX, y: e.clientY });
      else setPan(p => ({ x: p.x - (e.shiftKey ? e.deltaY : e.deltaX), y: p.y - (e.shiftKey ? 0 : e.deltaY) }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt, zoom]);

  // ── Pointer ──────────────────────────────────────────────────────────────

  const connectorTarget = (p: Pt, skipId?: string): { id: string; side?: Side } | null => {
    const tol = 8 / zoom;
    const s = hitTest(doc, p, tol, x => x.type === 'line' || x.type === 'pen' || x.id === skipId || x.type === 'text');
    if (!s || !isBox(s)) return null;
    for (const side of SIDES) {
      const a = anchorPoint(s, side);
      if (Math.hypot(a.x - p.x, a.y - p.y) < 14 / zoom) return { id: s.id, side };
    }
    return { id: s.id };
  };

  const startLine = (from: EndPoint, p: Pt) => {
    const line: LineShape = {
      id: uid(), type: 'line', from, to: { x: p.x, y: p.y }, route: 'orthogonal', arrowStart: 'none', arrowEnd: 'triangle', text: '',
      style: { ...DEFAULT_STYLE, stroke: 'ink', textColor: 'ink', fill: 'transparent', strokeWidth: 2 },
    };
    const base = session.doc;
    session.live([{ op: 'put', shape: line }]);
    interaction.current = { kind: 'line', base, id: line.id };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (editing) { setEditing(null); }
    svgRef.current?.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      // Second finger: pinch zoom, cancel what the first finger started.
      const [a, b] = [...pointers.current.values()];
      if (interaction.current && 'base' in interaction.current) session.finishLive(interaction.current.base, []);
      interaction.current = null;
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, pan };
      return;
    }
    const p = toBoard(e.clientX, e.clientY);
    const target = (e.target as Element).closest('[data-handle],[data-anchor],[data-endpoint]') as HTMLElement | null;

    if (e.button === 1 || space || effectiveTool === 'hand') {
      interaction.current = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, pan };
      force(n => n + 1);
      return;
    }
    if (e.button !== 0) return;

    if (target?.dataset.handle && selBounds && !readOnly) {
      interaction.current = { kind: 'resize', start: p, base: session.doc, ids: selection, handle: target.dataset.handle as Handle, box: selBounds };
      return;
    }
    if (target?.dataset.endpoint && singleLine && !readOnly) {
      interaction.current = { kind: 'endpoint', base: session.doc, id: singleLine.id, which: target.dataset.endpoint as 'from' | 'to' };
      return;
    }
    if (target?.dataset.anchor && !readOnly) {
      const [shapeId, side] = target.dataset.anchor.split(':');
      const s = doc.shapes[shapeId];
      if (s && isBox(s)) {
        const a = anchorPoint(s, side as Side);
        startLine({ x: a.x, y: a.y, shapeId, side: side as Side }, p);
        return;
      }
    }

    if (effectiveTool === 'line') {
      const hit = connectorTarget(p);
      const from: EndPoint = hit ? { x: p.x, y: p.y, shapeId: hit.id, side: hit.side ?? 'auto' } : { x: snap(p.x, GRID, grid), y: snap(p.y, GRID, grid) };
      startLine(from, p);
      return;
    }
    if (effectiveTool === 'pen') {
      const shape: PenShape = { id: uid(), type: 'pen', points: [p.x, p.y], style: { ...DEFAULT_STYLE, stroke: 'ink', strokeWidth: 3, fill: 'transparent' } };
      const base = session.doc;
      session.live([{ op: 'put', shape }]);
      interaction.current = { kind: 'pen', base, id: shape.id, points: [p.x, p.y] };
      return;
    }
    if (effectiveTool !== 'select') {
      const type = effectiveTool as BoxType;
      const start = { x: snap(p.x, GRID, grid), y: snap(p.y, GRID, grid) };
      const shape = newBox(type, { ...start, w: 1, h: 1 }, t('wb_kind_frame'));
      const base = session.doc;
      session.live([{ op: 'put', shape }]);
      interaction.current = { kind: 'create', start, base, id: shape.id, type };
      return;
    }

    const hit = hitTest(doc, p, 6 / zoom);
    if (hit) {
      let ids = selection;
      if (e.shiftKey) ids = selection.includes(hit.id) ? selection.filter(id => id !== hit.id) : [...selection, hit.id];
      else if (!selection.includes(hit.id)) ids = [hit.id];
      setSelection(ids);
      if (!readOnly && !e.shiftKey) {
        // Moving a frame carries what lies inside it.
        const withFrames = new Set(ids);
        for (const id of ids) {
          const s = doc.shapes[id];
          if (s?.type !== 'frame') continue;
          for (const other of doc.order) {
            const o = doc.shapes[other];
            if (o.id !== id && contains(s, boundsOf(doc, o))) withFrames.add(o.id);
          }
        }
        interaction.current = { kind: 'move', start: p, base: session.doc, ids: [...withFrames], moved: false };
      }
      return;
    }
    interaction.current = { kind: 'marquee', start: p, current: p, additive: e.shiftKey, initial: e.shiftKey ? selection : [] };
    if (!e.shiftKey) setSelection([]);
    force(n => n + 1);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = toBoard(e.clientX, e.clientY);
    lastPointer.current = p;
    if (!readOnly) session.cursor(p.x, p.y, selection);

    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinch.current.zoom * dist / pinch.current.dist));
      const r = svgRef.current!.getBoundingClientRect();
      const bx = (pinch.current.mid.x - r.left - pinch.current.pan.x) / pinch.current.zoom;
      const by = (pinch.current.mid.y - r.top - pinch.current.pan.y) / pinch.current.zoom;
      setZoom(z);
      setPan({ x: mid.x - r.left - bx * z, y: mid.y - r.top - by * z });
      return;
    }

    const it = interaction.current;
    if (!it) {
      if (effectiveTool === 'select' && !readOnly && e.pointerType === 'mouse') {
        const h = hitTest(doc, p, 6 / zoom, s => s.type === 'line' || s.type === 'pen' || s.type === 'text');
        setHover(h?.id ?? null);
      } else if (effectiveTool === 'line') {
        setLineTarget(connectorTarget(p));
      }
      return;
    }
    switch (it.kind) {
      case 'pan':
        setPan({ x: it.pan.x + e.clientX - it.start.x, y: it.pan.y + e.clientY - it.start.y });
        break;
      case 'marquee':
        it.current = p;
        {
          const r = normRect(it.start, p);
          // Alt selects everything the frame touches, otherwise what it fully covers.
          const hits = doc.order.filter(id => {
            const b = boundsOf(doc, doc.shapes[id]);
            return e.altKey ? intersects(r, b) : contains(r, b);
          });
          setSelection([...new Set([...it.initial, ...hits])]);
        }
        break;
      case 'move': {
        let dx = p.x - it.start.x;
        let dy = p.y - it.start.y;
        if (!it.moved && Math.hypot(dx, dy) * zoom < 3) return;
        it.moved = true;
        // Snap the moved group's corner to the grid.
        const first = it.ids.map(id => it.base.shapes[id]).find(s => s && isBox(s)) as BoxShape | undefined;
        if (first && grid && !e.altKey) {
          dx = snap(first.x + dx, GRID, true) - first.x;
          dy = snap(first.y + dy, GRID, true) - first.y;
        }
        const ops: Op[] = [];
        for (const id of it.ids) {
          const s = it.base.shapes[id];
          if (!s || s.locked) continue;
          if (s.type === 'pen') ops.push({ op: 'put', shape: { ...s, points: s.points.map((v, i) => v + (i % 2 ? dy : dx)) } });
          else if (s.type === 'line') {
            const mv = (end: EndPoint) => (end.shapeId && it.base.shapes[end.shapeId] ? end : { ...end, shapeId: undefined, x: end.x + dx, y: end.y + dy });
            ops.push({ op: 'put', shape: { ...s, from: mv(s.from), to: mv(s.to) } });
          } else ops.push({ op: 'put', shape: { ...s, x: s.x + dx, y: s.y + dy } });
        }
        session.live(ops);
        break;
      }
      case 'resize': {
        const { box, handle } = it;
        let x1 = box.x, y1 = box.y, x2 = box.x + box.w, y2 = box.y + box.h;
        const px = grid && !e.altKey ? snap(p.x, GRID, true) : p.x;
        const py = grid && !e.altKey ? snap(p.y, GRID, true) : p.y;
        if (handle.includes('w')) x1 = Math.min(px, x2 - 8);
        if (handle.includes('e')) x2 = Math.max(px, x1 + 8);
        if (handle.includes('n')) y1 = Math.min(py, y2 - 8);
        if (handle.includes('s')) y2 = Math.max(py, y1 + 8);
        if (e.shiftKey && handle.length === 2) {
          const ratio = box.w / Math.max(box.h, 1);
          const w = x2 - x1;
          const h = w / ratio;
          if (handle.includes('n')) y1 = y2 - h; else y2 = y1 + h;
        }
        const sx = (x2 - x1) / Math.max(box.w, 1);
        const sy = (y2 - y1) / Math.max(box.h, 1);
        const ops: Op[] = [];
        for (const id of it.ids) {
          const s = it.base.shapes[id];
          if (!s || s.locked) continue;
          if (isBox(s)) {
            ops.push({ op: 'put', shape: { ...s, x: x1 + (s.x - box.x) * sx, y: y1 + (s.y - box.y) * sy, w: Math.max(8, s.w * sx), h: Math.max(8, s.h * sy) } });
          } else if (s.type === 'pen') {
            ops.push({ op: 'put', shape: { ...s, points: s.points.map((v, i) => (i % 2 ? y1 + (v - box.y) * sy : x1 + (v - box.x) * sx)) } });
          } else {
            const sc = (end: EndPoint) => (end.shapeId ? end : { ...end, x: x1 + (end.x - box.x) * sx, y: y1 + (end.y - box.y) * sy });
            ops.push({ op: 'put', shape: { ...s, from: sc(s.from), to: sc(s.to) } });
          }
        }
        session.live(ops);
        break;
      }
      case 'create': {
        const cur = { x: snap(p.x, GRID, grid && !e.altKey), y: snap(p.y, GRID, grid && !e.altKey) };
        let r = normRect(it.start, cur);
        if (e.shiftKey) { const m = Math.max(r.w, r.h); r = { x: cur.x < it.start.x ? it.start.x - m : it.start.x, y: cur.y < it.start.y ? it.start.y - m : it.start.y, w: m, h: m }; }
        const s = session.doc.shapes[it.id] as BoxShape;
        if (s) session.live([{ op: 'put', shape: { ...s, ...r } }]);
        break;
      }
      case 'line':
      case 'endpoint': {
        const s = session.doc.shapes[it.id] as LineShape;
        if (!s) break;
        const which = it.kind === 'line' ? 'to' : it.which;
        const other = which === 'to' ? s.from : s.to;
        const hit = connectorTarget(p, other.shapeId);
        setLineTarget(hit);
        const end: EndPoint = hit ? { x: p.x, y: p.y, shapeId: hit.id, side: hit.side ?? 'auto' } : { x: snap(p.x, GRID, grid && !e.altKey), y: snap(p.y, GRID, grid && !e.altKey) };
        session.live([{ op: 'put', shape: { ...s, [which]: end } }]);
        break;
      }
      case 'pen': {
        it.points.push(p.x, p.y);
        const s = session.doc.shapes[it.id] as PenShape;
        if (s) session.live([{ op: 'put', shape: { ...s, points: [...it.points] } }]);
        break;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pinch.current) { if (pointers.current.size < 2) pinch.current = null; return; }
    const it = interaction.current;
    interaction.current = null;
    setLineTarget(null);
    if (!it) return;
    const finish = (base: Doc, ids: string[]) => {
      const ops: Op[] = ids.map(id => session.doc.shapes[id]).filter(Boolean).map(shape => ({ op: 'put', shape }) as Op);
      session.finishLive(base, ops);
    };
    switch (it.kind) {
      case 'move':
        if (it.moved) finish(it.base, it.ids); else session.finishLive(it.base, []);
        break;
      case 'resize':
        finish(it.base, it.ids);
        break;
      case 'create': {
        const s = session.doc.shapes[it.id] as BoxShape;
        if (!s) break;
        const [dw, dh] = DEFAULT_SIZE[it.type];
        const sized = s.w < 6 && s.h < 6 ? { ...s, x: s.x - (it.type === 'text' ? 0 : dw / 2), y: s.y - (it.type === 'text' ? 0 : dh / 2), w: dw, h: dh } : s;
        session.finishLive(it.base, [{ op: 'put', shape: sized }]);
        setSelection([sized.id]);
        if (!toolLock) setTool('select');
        if (it.type === 'text' || it.type === 'note') setEditing(sized.id);
        break;
      }
      case 'line':
      case 'endpoint': {
        const s = session.doc.shapes[it.id] as LineShape;
        if (!s) break;
        const len = Math.hypot(s.from.x - s.to.x, s.from.y - s.to.y);
        if (it.kind === 'line' && len * zoom < 8 && !s.to.shapeId) { session.finishLive(it.base, []); break; }
        finish(it.base, [it.id]);
        setSelection([it.id]);
        if (it.kind === 'line' && !toolLock) setTool('select');
        break;
      }
      case 'pen': {
        const s = session.doc.shapes[it.id] as PenShape;
        if (!s) break;
        session.finishLive(it.base, [{ op: 'put', shape: { ...s, points: simplify(s.points.map(v => Math.round(v * 10) / 10), 1.5 / zoom) } }]);
        break;
      }
      case 'marquee':
      case 'pan':
        force(n => n + 1);
        break;
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (readOnly) return;
    const p = toBoard(e.clientX, e.clientY);
    const hit = hitTest(doc, p, 6 / zoom);
    if (hit && hit.type !== 'pen') {
      setSelection([hit.id]);
      setEditing(hit.id);
      return;
    }
    if (!hit) {
      const box = newBox('text', { x: snap(p.x, GRID, grid), y: snap(p.y - 16, GRID, grid), w: 220, h: 40 });
      commit([{ op: 'put', shape: box }]);
      setSelection([box.id]);
      setEditing(box.id);
    }
  };

  // ── Rendering ────────────────────────────────────────────────────────────

  const editingShape = editing ? doc.shapes[editing] : undefined;
  const marquee = interaction.current?.kind === 'marquee' ? normRect(interaction.current.start, interaction.current.current) : null;
  const cursor = interaction.current?.kind === 'pan' ? 'grabbing'
    : space || effectiveTool === 'hand' ? 'grab'
      : effectiveTool === 'select' ? 'default' : 'crosshair';
  const hovered = hover && !selection.includes(hover) ? doc.shapes[hover] : null;
  const anchorShape = !readOnly && (effectiveTool === 'line' ? (lineTarget ? doc.shapes[lineTarget.id] : null)
    : effectiveTool === 'select' && !interaction.current ? (hovered ?? (selectedShapes.length === 1 ? selectedShapes[0] : null)) : null);
  const peers = [...session.peers.values()].filter(pp => Date.now() - pp.seen < 30_000);

  // The theme is a class on <body>: follow its changes, not only board edits.
  const [dark, setDark] = useState(() => document.body.classList.contains('dark-theme'));
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(document.body.classList.contains('dark-theme')));
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);
  const themeVars = useMemo(() => {
    return {
      '--wb-ink': dark ? '#e5e7eb' : '#1f2937',
      '--wb-paper': dark ? '#2b2d31' : '#ffffff',
      '--wb-grid': dark ? 'rgba(255,255,255,.07)' : 'rgba(15,23,42,.08)',
    } as CSSProperties;
  }, [dark]);

  const gs = GRID * zoom * (zoom < 0.5 ? 5 : 1);

  return (
    <div ref={wrapRef} style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden', background: 'var(--bg-primary)', touchAction: 'none', ...themeVars }}>
      <svg
        ref={svgRef}
        role="application"
        aria-label={t('wb_canvas')}
        width="100%"
        height="100%"
        style={{ display: 'block', position: 'absolute', inset: 0, width: '100%', height: '100%', cursor, userSelect: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={onDoubleClick}
        onContextMenu={e => e.preventDefault()}
      >
        {grid && (
          <>
            <defs>
              <pattern id="wb-grid" width={gs} height={gs} patternUnits="userSpaceOnUse" x={pan.x % gs} y={pan.y % gs}>
                <circle cx={1} cy={1} r={1} fill="var(--wb-grid)" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#wb-grid)" />
          </>
        )}
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
          <g ref={contentRef}>
            {doc.order.map(id => {
              const s = doc.shapes[id];
              return s ? <ShapeView key={id} shape={s} doc={doc} editing={editing === id} /> : null;
            })}
          </g>

          {/* Collaborators' selections */}
          {peers.flatMap(pp => pp.selection.map(id => doc.shapes[id] && (() => {
            const b = boundsOf(doc, doc.shapes[id]);
            const hue = [...pp.user.id].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
            return <rect key={`${pp.channel}:${id}`} x={b.x - 4} y={b.y - 4} width={b.w + 8} height={b.h + 8} fill="none" stroke={`hsl(${hue},70%,55%)`} strokeWidth={1.5 / zoom} strokeDasharray={`${4 / zoom} ${3 / zoom}`} pointerEvents="none" />;
          })()))}

          {hovered && (() => {
            const b = boundsOf(doc, hovered);
            return <rect x={b.x - 2} y={b.y - 2} width={b.w + 4} height={b.h + 4} fill="none" stroke="var(--accent-primary)" strokeOpacity={0.5} strokeWidth={1 / zoom} pointerEvents="none" />;
          })()}

          {selBounds && !singleLine && (
            <g>
              <rect x={selBounds.x} y={selBounds.y} width={selBounds.w} height={selBounds.h} fill="none" stroke="var(--accent-primary)" strokeWidth={1.5 / zoom} pointerEvents="none" />
              {selectedShapes.length > 1 && selectedShapes.map(s => {
                const b = boundsOf(doc, s);
                return <rect key={s.id} x={b.x} y={b.y} width={b.w} height={b.h} fill="none" stroke="var(--accent-primary)" strokeOpacity={0.45} strokeWidth={1 / zoom} pointerEvents="none" />;
              })}
              {!readOnly && !selectedShapes.some(s => s.locked) && HANDLES.map(h => {
                const hx = selBounds.x + (h.includes('w') ? 0 : h.includes('e') ? selBounds.w : selBounds.w / 2);
                const hy = selBounds.y + (h.includes('n') ? 0 : h.includes('s') ? selBounds.h : selBounds.h / 2);
                const size = (mobile ? 14 : 9) / zoom;
                return (
                  <rect key={h} data-handle={h} x={hx - size / 2} y={hy - size / 2} width={size} height={size} rx={2 / zoom}
                    fill="#fff" stroke="var(--accent-primary)" strokeWidth={1.5 / zoom} style={{ cursor: HANDLE_CURSORS[h] }} />
                );
              })}
            </g>
          )}

          {singleLine && !readOnly && (['from', 'to'] as const).map(which => {
            const pts = (() => {
              const end = which === 'from' ? singleLine.from : singleLine.to;
              const other = which === 'from' ? singleLine.to : singleLine.from;
              const target = end.shapeId ? doc.shapes[end.shapeId] : undefined;
              if (target && isBox(target)) {
                const side = !end.side || end.side === 'auto'
                  ? facingSide(target, other.shapeId && doc.shapes[other.shapeId] && isBox(doc.shapes[other.shapeId]) ? (() => { const o = doc.shapes[other.shapeId!] as BoxShape; return { x: o.x + o.w / 2, y: o.y + o.h / 2 }; })() : other)
                  : end.side;
                return anchorPoint(target, side);
              }
              return end;
            })();
            return <circle key={which} data-endpoint={which} cx={pts.x} cy={pts.y} r={(mobile ? 9 : 6) / zoom} fill="#fff" stroke="var(--accent-primary)" strokeWidth={2 / zoom} style={{ cursor: 'move' }} />;
          })}

          {anchorShape && isBox(anchorShape) && anchorShape.type !== 'text' && SIDES.map(side => {
            const a = anchorPoint(anchorShape, side);
            const active = lineTarget?.id === anchorShape.id && lineTarget.side === side;
            return (
              <g key={side} data-anchor={`${anchorShape.id}:${side}`} style={{ cursor: 'crosshair' }}>
                <circle cx={a.x} cy={a.y} r={12 / zoom} fill="transparent" />
                <circle cx={a.x} cy={a.y} r={(active ? 6 : 4.5) / zoom} fill={active ? 'var(--accent-primary)' : '#fff'} stroke="var(--accent-primary)" strokeWidth={1.5 / zoom} />
              </g>
            );
          })}
          {lineTarget && !lineTarget.side && doc.shapes[lineTarget.id] && (() => {
            const b = boundsOf(doc, doc.shapes[lineTarget.id]);
            return <rect x={b.x - 3} y={b.y - 3} width={b.w + 6} height={b.h + 6} rx={4 / zoom} fill="rgba(var(--accent-rgb), .08)" stroke="var(--accent-primary)" strokeWidth={1.5 / zoom} pointerEvents="none" />;
          })()}

          {marquee && (
            <rect x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} fill="rgba(var(--accent-rgb), .08)" stroke="var(--accent-primary)" strokeWidth={1 / zoom} strokeDasharray={`${4 / zoom} ${3 / zoom}`} pointerEvents="none" />
          )}
        </g>
      </svg>

      {peers.map(pp => {
        const hue = [...pp.user.id].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
        return (
          <div key={pp.channel} style={{ position: 'absolute', left: pp.x * zoom + pan.x, top: pp.y * zoom + pan.y, pointerEvents: 'none', transition: 'left .1s linear, top .1s linear', zIndex: 3 }}>
            <svg width="18" height="18" viewBox="0 0 18 18"><path d="M1 1 L16 8 L9 10 L7 17 Z" fill={`hsl(${hue},70%,55%)`} stroke="#fff" strokeWidth="1.2" /></svg>
            <span style={{ position: 'absolute', left: 14, top: 14, whiteSpace: 'nowrap', fontSize: 11, fontWeight: 700, color: '#fff', background: `hsl(${hue},70%,45%)`, padding: '1px 6px', borderRadius: 6 }}>
              {pp.user.nickname || pp.user.username}
            </span>
          </div>
        );
      })}

      {editingShape && editingShape.type !== 'pen' && (
        <TextEditor
          key={editingShape.id}
          shape={editingShape}
          doc={doc}
          zoom={zoom}
          pan={pan}
          onDone={(text, height) => {
            setEditing(null);
            const s = session.doc.shapes[editingShape.id];
            if (!s || s.type === 'pen') return;
            if (s.type === 'text' && !text.trim()) { commit([{ op: 'del', id: s.id }]); return; }
            const next = { ...s, text } as Shape;
            if (s.type === 'text' && height && isBox(next)) next.h = Math.max(s.h, height);
            if (text !== s.text || (isBox(next) && isBox(s) && next.h !== s.h)) commit([{ op: 'put', shape: next }]);
          }}
        />
      )}

      <Toolbar tool={tool} setTool={setTool} lock={toolLock} setLock={setToolLock} readOnly={readOnly} mobile={mobile} />
      <ZoomBar zoom={zoom} setZoom={z => zoomAt(z)} fit={fit} grid={grid} setGrid={setGrid} session={session} readOnly={readOnly} mobile={mobile} />
      {selectedShapes.length > 0 && !readOnly && !editing && (
        <PropertiesPanel
          shapes={selectedShapes}
          mobile={mobile}
          update={updateShapes}
          onDelete={deleteSelection}
          onDuplicate={() => duplicate(selectedShapes)}
          onReorder={reorder}
          onEditText={() => selectedShapes.length === 1 && setEditing(selectedShapes[0].id)}
        />
      )}
      {doc.order.length === 0 && !readOnly && (
        <div style={{ position: 'absolute', left: '50%', top: '42%', transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none', color: 'var(--text-tertiary)' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>{t('wb_empty')}</div>
          <div style={{ fontSize: 13, lineHeight: 1.6, maxWidth: 380 }}>{t('wb_empty_hint')}</div>
        </div>
      )}
    </div>
  );
}

function TextEditor({ shape, doc, zoom, pan, onDone }: {
  shape: Exclude<Shape, PenShape>; doc: Doc; zoom: number; pan: Pt; onDone: (text: string, height?: number) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(shape.text);
  const done = useRef(false);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    const h = ref.current ? ref.current.scrollHeight / zoom : undefined;
    onDone(text, h);
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  const b = shape.type === 'line' ? (() => { const r = boundsOf(doc, shape); return { x: r.x + r.w / 2 - 110, y: r.y + r.h / 2 - 18, w: 220, h: 36 }; })() : boundsOf(doc, shape);
  const st = shape.style;
  const isText = shape.type === 'text';
  return (
    <textarea
      ref={ref}
      value={text}
      onChange={e => {
        setText(e.target.value);
        if (isText && ref.current) { ref.current.style.height = 'auto'; ref.current.style.height = `${ref.current.scrollHeight}px`; }
      }}
      onBlur={finish}
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); finish(); }
      }}
      onPointerDown={e => e.stopPropagation()}
      style={{
        position: 'absolute', left: b.x * zoom + pan.x, top: b.y * zoom + pan.y, width: Math.max(b.w * zoom, 60), height: Math.max(b.h * zoom, 30),
        zIndex: 2, resize: 'none', border: '2px solid var(--accent-primary)', borderRadius: 6, outline: 'none', boxSizing: 'border-box',
        padding: (shape.type === 'note' ? 12 : isText ? 2 : 8) * zoom, fontSize: st.fontSize * zoom * (shape.type === 'line' ? 0.85 : 1), fontWeight: st.bold ? 700 : 400,
        textAlign: shape.type === 'line' ? 'center' : st.align, lineHeight: 1.3, fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, sans-serif',
        background: shape.type === 'note' ? st.fill : 'var(--bg-secondary)', color: shape.type === 'note' ? '#1f2937' : 'var(--text-primary)',
        overflow: 'hidden',
      }}
    />
  );
}
