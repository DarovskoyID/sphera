import { openModuleSocket, reportError, type ModuleSocket } from '@sfera/sdk';
import { api, type Conn } from './api';
import { uid } from './geometry';
import type { Doc, Op, Shape } from './types';
import type { UserBrief } from './ui';

export interface Peer {
  channel: string;
  user: UserBrief;
  x: number;
  y: number;
  selection: string[];
  seen: number;
}

export function applyOps(doc: Doc, ops: Op[]): Doc {
  const shapes = { ...doc.shapes };
  let order = doc.order;
  for (const op of ops) {
    if (op.op === 'put') {
      if (!shapes[op.shape.id]) order = [...order, op.shape.id];
      shapes[op.shape.id] = op.shape;
    } else if (op.op === 'del') {
      if (shapes[op.id]) {
        delete shapes[op.id];
        order = order.filter(x => x !== op.id);
      }
    } else if (op.op === 'order') {
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

  private conn: Conn;
  readonly boardId: string;

  constructor(conn: Conn, boardId: string, doc: Doc, version: number, name: string) {
    this.conn = conn;
    this.boardId = boardId;
    this.doc = doc;
    this.version = version;
    this.name = name;
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
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
      this.doc = b.doc;
      this.version = b.version;
      this.emit();
    } catch { /* offline */ }
  }

  private onFrame(f: { type: string; [k: string]: unknown }) {
    switch (f.type) {
      case 'snapshot':
        if (typeof f.version === 'number' && f.version >= this.version) {
          this.doc = f.doc as Doc;
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
    this.doc = applyOps(this.doc, ops);
    this.pendingLive = [...(this.pendingLive ?? []).filter(p => !ops.some(o => sameTarget(o, p))), ...ops];
    if (!this.liveTimer) this.liveTimer = setTimeout(() => this.flushLive(), 100);
    this.emit();
  }

  private flushLive() {
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = null;
    // Previews only go over the socket; the final state is always committed.
    if (this.pendingLive?.length) this.socket?.send({ type: 'ops', ops: this.pendingLive, seq: ++this.seq, client_id: this.clientId });
    this.pendingLive = null;
  }

  /** Replace the preview of a drag with its final state, as one undo step from `base`. */
  finishLive(base: Doc, ops: Op[]) {
    this.pendingLive = null;
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = null;
    this.doc = base;
    this.commit(ops, base);
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    const ops = e.undo;
    this.doc = applyOps(this.doc, ops);
    this.redoStack.push(e);
    this.send(ops);
    this.emit();
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    this.doc = applyOps(this.doc, e.redo);
    this.undoStack.push(e);
    this.send(e.redo);
    this.emit();
  }

  cursor(x: number, y: number, selection: string[]) {
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
