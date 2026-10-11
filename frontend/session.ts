import { openModuleSocket, reportError, type ModuleSocket } from '@sfera/sdk';
import { api, type Conn } from './api';
import {
  emptyData, type Block, type Cell, type Data, type DeckData, type DocData, type DocFull, type Kind, type Op,
  type Role, type SheetData, type Slide,
} from './types';
import type { UserBrief } from './ui';

export interface Peer {
  channel: string;
  user: UserBrief;
  /** Block id, cell ref or slide id the caret sits in. */
  at: string;
  seen: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const int = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback);

/**
 * Content comes from other clients and from older versions of this module: give
 * every item the fields rendering relies on, or drop it, instead of breaking
 * the document for everybody.
 */
export function normalizeBlock(raw: unknown): Block | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.type !== 'string') return null;
  const block: Block = { id: raw.id, type: raw.type as Block['type'], text: str(raw.text) };
  if (raw.done !== undefined) block.done = !!raw.done;
  if (raw.lang !== undefined) block.lang = str(raw.lang);
  if (raw.url !== undefined) block.url = str(raw.url);
  if (raw.alt !== undefined) block.alt = str(raw.alt);
  if (Array.isArray(raw.rows)) block.rows = raw.rows.map(row => (Array.isArray(row) ? row.map(c => str(c)) : []));
  if (isObject(raw.style)) block.style = raw.style as Block['style'];
  return block;
}

export function normalizeSlide(raw: unknown): Slide | null {
  if (!isObject(raw) || typeof raw.id !== 'string') return null;
  return {
    id: raw.id,
    layout: (typeof raw.layout === 'string' ? raw.layout : 'text') as Slide['layout'],
    title: str(raw.title), body: str(raw.body), notes: str(raw.notes), image: str(raw.image),
    bullets: Array.isArray(raw.bullets) ? raw.bullets.map(b => str(b)) : [],
    ...(isObject(raw.style) ? { style: raw.style as Slide['style'] } : {}),
  };
}

export function normalizeData(kind: Kind, raw: unknown): Data {
  const d = isObject(raw) ? raw : {};
  if (kind === 'sheet') {
    const cells: Record<string, Cell> = {};
    for (const [at, value] of Object.entries(isObject(d.cells) ? d.cells : {})) {
      if (!isObject(value)) continue;
      cells[at.toUpperCase()] = { v: str(value.v), ...(isObject(value.style) ? { style: value.style as Cell['style'] } : {}) };
    }
    const widths: Record<string, number> = {};
    for (const [col, w] of Object.entries(isObject(d.widths) ? d.widths : {})) widths[col] = int(w, 110);
    return { cells, rows: Math.max(1, int(d.rows, 50)), cols: Math.max(1, int(d.cols, 12)), widths };
  }
  if (kind === 'deck') {
    const slides: Record<string, Slide> = {};
    for (const [id, value] of Object.entries(isObject(d.slides) ? d.slides : {})) {
      const slide = normalizeSlide(value);
      if (slide && slide.id === id) slides[id] = slide;
    }
    const order = (Array.isArray(d.order) ? d.order : []).filter((id): id is string => typeof id === 'string' && !!slides[id]);
    for (const id of Object.keys(slides)) if (!order.includes(id)) order.push(id);
    return { slides, order, theme: (str(d.theme, 'light') as DeckData['theme']) };
  }
  const blocks: Record<string, Block> = {};
  for (const [id, value] of Object.entries(isObject(d.blocks) ? d.blocks : {})) {
    const block = normalizeBlock(value);
    if (block && block.id === id) blocks[id] = block;
  }
  const order = (Array.isArray(d.order) ? d.order : []).filter((id): id is string => typeof id === 'string' && !!blocks[id]);
  for (const id of Object.keys(blocks)) if (!order.includes(id)) order.push(id);
  return { blocks, order };
}

function reorder(order: string[], keys: Record<string, unknown>, next: unknown): string[] {
  const wanted = (Array.isArray(next) ? next : []).filter((id): id is string => typeof id === 'string' && id in keys);
  const seen = new Set(wanted);
  return [...wanted, ...order.filter(id => !seen.has(id) && id in keys)];
}

/** Replay ops locally the same way the server does (ops.py). */
export function applyOps(kind: Kind, data: Data, ops: Op[]): Data {
  if (kind === 'doc') {
    const d = data as DocData;
    const blocks = { ...d.blocks };
    let order = [...d.order];
    for (const op of ops) {
      if (op.op === 'block.put') {
        const block = normalizeBlock(op.block);
        if (!block) continue;
        if (!blocks[block.id]) {
          if (op.at === undefined) order.push(block.id);
          else order.splice(Math.max(0, Math.min(order.length, op.at)), 0, block.id);
        }
        blocks[block.id] = block;
      } else if (op.op === 'block.del') {
        delete blocks[op.id];
        order = order.filter(x => x !== op.id);
      } else if (op.op === 'order') {
        order = reorder(order, blocks, op.order);
      }
    }
    return { blocks, order: order.filter(id => blocks[id]) };
  }
  if (kind === 'sheet') {
    const d = data as SheetData;
    const cells = { ...d.cells };
    let { rows, cols } = d;
    const widths = { ...d.widths };
    for (const op of ops) {
      if (op.op === 'cell.set') {
        if (!op.cell.v && !op.cell.style) delete cells[op.ref];
        else cells[op.ref] = op.cell;
      } else if (op.op === 'cell.clear') {
        delete cells[op.ref];
      } else if (op.op === 'size') {
        rows = Math.max(1, op.rows ?? rows);
        cols = Math.max(1, op.cols ?? cols);
      } else if (op.op === 'width') {
        widths[String(op.col)] = op.w;
      }
    }
    return { cells, rows, cols, widths };
  }
  const d = data as DeckData;
  const slides = { ...d.slides };
  let order = [...d.order];
  let theme = d.theme;
  for (const op of ops) {
    if (op.op === 'slide.put') {
      const slide = normalizeSlide(op.slide);
      if (!slide) continue;
      if (!slides[slide.id]) {
        if (op.at === undefined) order.push(slide.id);
        else order.splice(Math.max(0, Math.min(order.length, op.at)), 0, slide.id);
      }
      slides[slide.id] = slide;
    } else if (op.op === 'slide.del') {
      delete slides[op.id];
      order = order.filter(x => x !== op.id);
    } else if (op.op === 'order') {
      order = reorder(order, slides, op.order);
    } else if (op.op === 'theme') {
      theme = op.theme;
    }
  }
  return { slides, order: order.filter(id => slides[id]), theme };
}

/** Ops that turn the current content back into `before` for what the batch touched. */
export function inverseOps(kind: Kind, before: Data, ops: Op[]): Op[] {
  const out: Op[] = [];
  const touched = new Set<string>();
  let orderChanged = false;
  for (const op of ops) {
    if (op.op === 'order') { orderChanged = true; continue; }
    if (op.op === 'block.put' || op.op === 'block.del') {
      const id = op.op === 'block.put' ? op.block.id : op.id;
      if (touched.has(id)) continue;
      touched.add(id);
      const prev = (before as DocData).blocks[id];
      out.push(prev ? { op: 'block.put', block: prev } : { op: 'block.del', id });
      if (!prev || op.op === 'block.del') orderChanged = true;
    } else if (op.op === 'slide.put' || op.op === 'slide.del') {
      const id = op.op === 'slide.put' ? op.slide.id : op.id;
      if (touched.has(id)) continue;
      touched.add(id);
      const prev = (before as DeckData).slides[id];
      out.push(prev ? { op: 'slide.put', slide: prev } : { op: 'slide.del', id });
      if (!prev || op.op === 'slide.del') orderChanged = true;
    } else if (op.op === 'cell.set' || op.op === 'cell.clear') {
      if (touched.has(op.ref)) continue;
      touched.add(op.ref);
      const prev = (before as SheetData).cells[op.ref];
      out.push(prev ? { op: 'cell.set', ref: op.ref, cell: prev } : { op: 'cell.clear', ref: op.ref });
    } else if (op.op === 'size') {
      const sheet = before as SheetData;
      out.push({ op: 'size', rows: sheet.rows, cols: sheet.cols });
    } else if (op.op === 'theme') {
      out.push({ op: 'theme', theme: (before as DeckData).theme });
    } else if (op.op === 'width') {
      out.push({ op: 'width', col: op.col, w: (before as SheetData).widths[String(op.col)] ?? 110 });
    }
  }
  if (orderChanged) {
    const order = kind === 'doc' ? (before as DocData).order : kind === 'deck' ? (before as DeckData).order : null;
    if (order) out.push({ op: 'order', order });
  }
  return out;
}

interface Entry { redo: Op[]; undo: Op[] }

/**
 * One document being edited: the local content, undo history and the live
 * socket. Local edits show at once, the server orders them, and co-authors' ops
 * are applied as they arrive (last write wins per block, cell or slide).
 *
 * Keystrokes are coalesced: typing in one block sends at most one op every
 * COALESCE ms, so a busy document costs a handful of writes a second instead of
 * one per character.
 */
export class DocSession {
  data: Data;
  version: number;
  title: string;
  role: Role;
  readonly clientId = Math.random().toString(36).slice(2, 10);
  peers = new Map<string, Peer>();
  connected = false;
  removed = false;
  saving = false;

  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private listeners = new Set<() => void>();
  private socket: ModuleSocket | null = null;
  private seq = 0;
  private httpChain: Promise<unknown> = Promise.resolve();
  private tick = 0;
  private cursorAt = 0;
  private pending: Op[] = [];
  private pendingBefore: Data | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  static readonly COALESCE = 400;

  private readonly conn: Conn;
  readonly kind: Kind;
  readonly docId: string;

  constructor(conn: Conn, kind: Kind, docId: string, doc: DocFull) {
    this.conn = conn;
    this.kind = kind;
    this.docId = docId;
    this.data = normalizeData(kind, doc.data);
    this.version = doc.version;
    this.title = doc.title;
    this.role = doc.role;
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
  get canEdit() { return this.role !== 'viewer'; }
  get doc() { return this.data as DocData; }
  get sheet() { return this.data as SheetData; }
  get deck() { return this.data as DeckData; }

  connect() {
    this.socket = openModuleSocket({
      serverIP: this.conn.serverIP,
      token: this.conn.token,
      path: `/ws/m/office/${this.docId}/`,
      onFrame: f => this.onFrame(f),
      onReopen: () => { void this.resync(); },
      onStatus: open => { this.connected = open; this.emit(); },
    });
  }

  close() {
    this.flush();
    this.socket?.close();
    this.socket = null;
  }

  private async resync() {
    try {
      const doc = await api.doc(this.conn, this.docId);
      this.data = normalizeData(this.kind, doc.data);
      this.version = doc.version;
      this.title = doc.title;
      this.role = doc.role;
      this.emit();
    } catch { /* offline */ }
  }

  private onFrame(f: { type: string;[k: string]: unknown }) {
    switch (f.type) {
      case 'snapshot':
        if (typeof f.version === 'number' && f.version >= this.version) {
          this.data = normalizeData(this.kind, f.data);
          this.version = f.version;
          if (typeof f.role === 'string') this.role = f.role as Role;
          this.emit();
        }
        break;
      case 'ops':
        if (f.client_id === this.clientId) return;
        this.data = applyOps(this.kind, this.data, (f.ops as Op[]) ?? []);
        this.version = Math.max(this.version, Number(f.version) || 0);
        this.emit();
        break;
      case 'replaced':
        this.data = normalizeData(this.kind, f.data);
        this.version = Number(f.version) || this.version;
        this.undoStack = [];
        this.redoStack = [];
        this.emit();
        break;
      case 'ack':
        this.version = Math.max(this.version, Number(f.version) || 0);
        this.saving = false;
        this.emit();
        break;
      case 'error':
        reportError(new Error(`office: ${String(f.error)}`));
        void this.resync();
        break;
      case 'cursor': {
        const channel = String(f.channel);
        this.peers.set(channel, { channel, user: f.user as UserBrief, at: String(f.at ?? ''), seen: Date.now() });
        this.emit();
        break;
      }
      case 'leave':
        this.peers.delete(String(f.channel));
        this.emit();
        break;
      case 'renamed':
        this.title = String(f.title);
        this.emit();
        break;
      case 'role':
        this.role = String(f.role) as Role;
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
    this.saving = true;
    if (this.socket?.send({ type: 'ops', ops, seq: ++this.seq, client_id: this.clientId })) return;
    // No socket (offline gateway, proxy): the same edit over HTTP, in order.
    this.httpChain = this.httpChain
      .then(() => api.ops(this.conn, this.docId, ops, this.clientId))
      .then(r => { this.version = Math.max(this.version, r.version); this.saving = false; this.emit(); })
      .catch(e => { this.saving = false; reportError(e); void this.resync(); });
  }

  /** Apply and send a finished edit, recorded as one undo step. */
  commit(ops: Op[]) {
    if (!ops.length || !this.canEdit) return;
    this.flush();
    const before = this.data;
    const undo = inverseOps(this.kind, before, ops);
    this.data = applyOps(this.kind, this.data, ops);
    this.push({ redo: ops, undo });
    this.send(ops);
    this.emit();
  }

  /**
   * Typing: shown at once, sent coalesced. Ops that hit the same target replace
   * each other, so holding a key down is still one write.
   */
  type(ops: Op[]) {
    if (!ops.length || !this.canEdit) return;
    if (!this.pendingBefore) this.pendingBefore = this.data;
    this.data = applyOps(this.kind, this.data, ops);
    this.pending = [...this.pending.filter(p => !ops.some(o => sameTarget(o, p))), ...ops];
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), DocSession.COALESCE);
    this.emit();
  }

  /** Send whatever typing is still pending and close the undo step. */
  flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const ops = this.pending;
    const before = this.pendingBefore;
    this.pending = [];
    this.pendingBefore = null;
    if (!ops.length || !before) return;
    this.push({ redo: ops, undo: inverseOps(this.kind, before, ops) });
    this.send(ops);
  }

  private push(entry: Entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    this.flush();
    const e = this.undoStack.pop();
    if (!e) return;
    this.data = applyOps(this.kind, this.data, e.undo);
    this.redoStack.push(e);
    this.send(e.undo);
    this.emit();
  }

  redo() {
    this.flush();
    const e = this.redoStack.pop();
    if (!e) return;
    this.data = applyOps(this.kind, this.data, e.redo);
    this.undoStack.push(e);
    this.send(e.redo);
    this.emit();
  }

  /** At most 20 caret frames a second. */
  cursor(at: string) {
    const now = Date.now();
    if (now - this.cursorAt < 50) return;
    this.cursorAt = now;
    this.socket?.send({ type: 'cursor', at });
  }

  /** Co-authors whose caret sits on this block / cell / slide. */
  peersAt(at: string) {
    const fresh = Date.now() - 60_000;
    return [...this.peers.values()].filter(p => p.at === at && p.seen > fresh);
  }

  livePeers() {
    const fresh = Date.now() - 60_000;
    return [...this.peers.values()].filter(p => p.seen > fresh);
  }

  rename(title: string) {
    this.title = title;
    this.emit();
    void api.rename(this.conn, this.docId, title).catch(reportError);
  }
}

function sameTarget(a: Op, b: Op) {
  const key = (op: Op) =>
    op.op === 'block.put' ? `b:${op.block.id}`
      : op.op === 'block.del' ? `b:${op.id}`
        : op.op === 'slide.put' ? `s:${op.slide.id}`
          : op.op === 'slide.del' ? `s:${op.id}`
            : op.op === 'cell.set' || op.op === 'cell.clear' ? `c:${op.ref}`
              : op.op === 'width' ? `w:${op.col}` : op.op;
  return key(a) === key(b);
}

export const freshData = emptyData;
