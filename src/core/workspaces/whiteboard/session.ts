import { openModuleSocket, reportError, type ModuleSocket } from '@sfera/sdk';
import { workspaceWritable, subscribeCommercial } from '../../commercial/store';
import { api, type Conn } from './api';
import { uid } from './geometry';
import { DEFAULT_STYLE, type Doc, type Op, type Shape } from './types';
import type { UserBrief } from './ui';

export interface Peer {
  channel: string;
  user: UserBrief;
  x: number;
  y: number;
  selection: string[];
  seen: number;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * Shapes come from other clients and older versions: give every one the fields
 * rendering relies on, or drop it, instead of breaking the board for everybody.
 */
export function normalizeShape(raw: unknown): Shape | null {
  const s = raw as Record<string, unknown> | null;
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || typeof s.type !== 'string') return null;
  const style = { ...DEFAULT_STYLE, stroke: 'ink', textColor: 'ink', fill: 'paper', ...(s.style && typeof s.style === 'object' ? s.style : {}) };
  if (s.type === 'pen') {
    const points = Array.isArray(s.points) ? s.points.filter(v => typeof v === 'number' && Number.isFinite(v)) : [];
    if (points.length < 2) return null;
    return { ...(s as object), id: s.id, type: 'pen', points: points.length % 2 ? points.slice(0, -1) : points, style } as Shape;
  }
  if (s.type === 'line') {
    const end = (e: unknown) => {
      const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
      return { ...o, x: num(o.x), y: num(o.y), shapeId: typeof o.shapeId === 'string' ? o.shapeId : undefined };
    };
    return {
      arrowStart: 'none', arrowEnd: 'triangle', route: 'orthogonal', text: '', ...(s as object),
      id: s.id, type: 'line', from: end(s.from), to: end(s.to), style,
    } as Shape;
  }
  return {
    ...(s as object), id: s.id, type: s.type, x: num(s.x), y: num(s.y), w: Math.max(1, num(s.w, 100)), h: Math.max(1, num(s.h, 60)),
    text: typeof s.text === 'string' ? s.text : '', style,
  } as Shape;
}

export function normalizeDoc(raw: unknown): Doc {
  const d = (raw && typeof raw === 'object' ? raw : {}) as { shapes?: Record<string, unknown>; order?: unknown };
  const shapes: Record<string, Shape> = {};
  for (const [id, v] of Object.entries(d.shapes ?? {})) {
    const shape = normalizeShape(v);
    if (shape && shape.id === id) shapes[id] = shape;
  }
  const order = (Array.isArray(d.order) ? d.order : []).filter((id): id is string => typeof id === 'string' && !!shapes[id]);
  for (const id of Object.keys(shapes)) if (!order.includes(id)) order.push(id);
  return { shapes, order };
}

export function applyOps(doc: Doc, ops: Op[]): Doc {
  const shapes = { ...doc.shapes };
  let order = doc.order;
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || typeof op !== 'object') continue;
    if (op.op === 'put') {
      const shape = normalizeShape(op.shape);
      if (!shape) continue;
      if (!shapes[shape.id]) order = [...order, shape.id];
      shapes[shape.id] = shape;
    } else if (op.op === 'del') {
      if (shapes[op.id]) {
        delete shapes[op.id];
        order = order.filter(x => x !== op.id);
      }
    } else if (op.op === 'order' && Array.isArray(op.order)) {
      const next = op.order.filter(id => shapes[id]);
      const seen = new Set(next);
      order = [...next, ...order.filter(id => !seen.has(id))];
    }
  }
  return { shapes, order: order.filter(id => shapes[id]) };
}

/** Ops that turn `after` back into `before` for the shapes the batch touched. */
export function inverseOps(before: Doc, ops: Op[]): Op[] {
  const out: Op[] = [];
  const touched = new Set<string>();
  let orderChanged = false;
  for (const op of ops) {
    if (op.op === 'order') { orderChanged = true; continue; }
    const id = op.op === 'put' ? op.shape.id : op.id;
    if (touched.has(id)) continue;
    touched.add(id);
    const prev = before.shapes[id];
    if (prev) out.push({ op: 'put', shape: prev });
    else out.push({ op: 'del', id });
    if (op.op === 'del' || !prev) orderChanged = true;
  }
  if (orderChanged) out.push({ op: 'order', order: before.order });
  return out;
}

interface Entry { redo: Op[]; undo: Op[] }

/**
 * A board being edited: the local document, undo history and the live socket.
 * Local edits apply at once; the server orders them, and collaborators' ops are
 * applied as they arrive (last write wins per shape).
 */
export class BoardSession {
  doc: Doc;
  version: number;
  readonly clientId = uid();
  peers = new Map<string, Peer>();
  connected = false;
  removed = false;
  name: string;
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private listeners = new Set<() => void>();
  private socket: ModuleSocket | null = null;
  private seq = 0;
  private httpChain: Promise<unknown> = Promise.resolve();
  private pendingLive: Op[] | null = null;
  private liveTimer: ReturnType<typeof setTimeout> | null = null;
  private tick = 0;
  private previewTouched = new Set<string>();
  private previewSent = false;
  private cursorAt = 0;

  private conn: Conn;
  readonly boardId: string;

  constructor(conn: Conn, boardId: string, doc: Doc, version: number, name: string) {
    this.conn = conn;
    this.boardId = boardId;
    this.doc = normalizeDoc(doc);
    this.version = version;
    this.name = name;
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    const release = subscribeCommercial(() => { this.tick++; l(); });
    return () => { this.listeners.delete(l); release(); };
  };

  snapshot = () => this.tick;

  private emit() {
    this.tick++;
    this.listeners.forEach(l => l());
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  connect() {
    this.socket = openModuleSocket({
      serverIP: this.conn.serverIP,
      token: this.conn.token,
      path: `/ws/m/whiteboard/${this.boardId}/`,
      onFrame: f => this.onFrame(f),
      onReopen: () => { void this.resync(); },
      onStatus: open => { this.connected = open; this.emit(); },
    });
  }

  close() {
    this.flushLive();
    this.socket?.close();
    this.socket = null;
  }

  private async resync() {
    try {
      const b = await api.board(this.conn, this.boardId);
      this.doc = normalizeDoc(b.doc);
      this.version = b.version;
      this.emit();
    } catch { /* offline */ }
  }

  private onFrame(f: { type: string; [k: string]: unknown }) {
    switch (f.type) {
      case 'snapshot':
        if (typeof f.version === 'number' && f.version >= this.version) {
          this.doc = normalizeDoc(f.doc);
          this.version = f.version;
          this.emit();
        }
        break;
      case 'ops':
        if (f.client_id === this.clientId) return;
        this.doc = applyOps(this.doc, f.ops as Op[]);
        this.version = Math.max(this.version, Number(f.version) || 0);
        this.emit();
        break;
      case 'ack':
        this.version = Math.max(this.version, Number(f.version) || 0);
        break;
      case 'error':
        reportError(new Error(`whiteboard: ${String(f.error)}`));
        void this.resync();
        break;
      case 'cursor': {
        const channel = String(f.channel);
        this.peers.set(channel, {
          channel, user: f.user as UserBrief, x: Number(f.x), y: Number(f.y),
          selection: (f.selection as string[]) ?? [], seen: Date.now(),
        });
        this.emit();
        break;
      }
      case 'leave':
        this.peers.delete(String(f.channel));
        this.emit();
        break;
      case 'renamed':
        this.name = String(f.name);
        this.emit();
        break;
      case 'removed':
        this.removed = true;
        this.emit();
        break;
      case 'access_changed':
        void this.resync();
        break;
    }
  }

  private send(ops: Op[]) {
    if (this.socket?.send({ type: 'ops', ops, seq: ++this.seq, client_id: this.clientId })) return;
    // No socket (offline gateway, proxy): the same edit over HTTP, in order.
    this.httpChain = this.httpChain
      .then(() => api.ops(this.conn, this.boardId, ops, this.clientId))
      .then(r => { this.version = Math.max(this.version, r.version); })
      .catch(e => { reportError(e); void this.resync(); });
  }

  /** Apply and send a finished edit, recorded for undo. */
  commit(ops: Op[], before: Doc = this.doc) {
    if (!workspaceWritable('whiteboard')) return;
    if (!ops.length) return;
    this.flushLive();
    const undo = inverseOps(before, ops);
    this.doc = applyOps(this.doc, ops);
    this.undoStack.push({ redo: ops, undo });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.send(ops);
    this.emit();
  }

  /** In-between states of a drag: shown at once, sent to others at most every 100 ms, not in history. */
  live(ops: Op[]) {
    if (!workspaceWritable('whiteboard')) return;
    for (const op of ops) this.previewTouched.add(op.op === 'put' ? op.shape.id : op.op === 'del' ? op.id : '');
    this.doc = applyOps(this.doc, ops);
    this.pendingLive = [...(this.pendingLive ?? []).filter(p => !ops.some(o => sameTarget(o, p))), ...ops];
    if (!this.liveTimer) this.liveTimer = setTimeout(() => this.flushLive(), 100);
    this.emit();
  }

  private flushLive() {
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = null;
    // Previews only go over the socket; the final state is always committed.
    if (this.pendingLive?.length && this.socket?.send({ type: 'ops', ops: this.pendingLive, seq: ++this.seq, client_id: this.clientId })) {
      this.previewSent = true;
    }
    this.pendingLive = null;
  }

  /** Replace the preview of a drag with its final state, as one undo step from `base`. */
  finishLive(base: Doc, ops: Op[]) {
    this.pendingLive = null;
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = null;
    // Shapes the preview touched but the result does not keep go back to how they
    // were — only those, so collaborators' edits made meanwhile stay.
    const kept = new Set(ops.map(op => (op.op === 'put' ? op.shape.id : op.op === 'del' ? op.id : '')));
    const revert: Op[] = [];
    for (const id of this.previewTouched) {
      if (!id || kept.has(id)) continue;
      revert.push(base.shapes[id] ? { op: 'put', shape: base.shapes[id] } : { op: 'del', id });
    }
    if (revert.length) {
      this.doc = applyOps(this.doc, revert);
      // Others already saw the preview: take it back for them too.
      if (this.previewSent) this.send(revert);
    }
    this.previewTouched.clear();
    this.previewSent = false;
    if (ops.length) this.commit(ops, base);
    else this.emit();
  }

  undo() {
    if (!workspaceWritable('whiteboard')) return;
    const e = this.undoStack.pop();
    if (!e) return;
    const ops = e.undo;
    this.doc = applyOps(this.doc, ops);
    this.redoStack.push(e);
    this.send(ops);
    this.emit();
  }

  redo() {
    if (!workspaceWritable('whiteboard')) return;
    const e = this.redoStack.pop();
    if (!e) return;
    this.doc = applyOps(this.doc, e.redo);
    this.undoStack.push(e);
    this.send(e.redo);
    this.emit();
  }

  /** At most 20 cursor frames a second. */
  cursor(x: number, y: number, selection: string[]) {
    if (!workspaceWritable('whiteboard')) return;
    const now = Date.now();
    if (now - this.cursorAt < 50) return;
    this.cursorAt = now;
    this.socket?.send({ type: 'cursor', x: Math.round(x), y: Math.round(y), selection });
  }

  shape<T extends Shape = Shape>(id: string) {
    return this.doc.shapes[id] as T | undefined;
  }
}

function sameTarget(a: Op, b: Op) {
  if (a.op === 'order' || b.op === 'order') return a.op === b.op;
  const ia = a.op === 'put' ? a.shape.id : a.id;
  const ib = b.op === 'put' ? b.shape.id : b.id;
  return ia === ib;
}
