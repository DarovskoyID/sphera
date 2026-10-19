import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import {
  ArrowLeft, Copy, Download, FileJson, Image as ImageIcon, MoreHorizontal, PenTool, Pencil, Plus, Search, Share2, Trash2, Upload, UserMinus, Wifi, WifiOff,
} from 'lucide-react';
import { navigate, reportError, useCore, useModuleStore, useModuleT } from '@sfera/sdk';
import { api, type Conn } from './api';
import { Editor, type EditorApi } from './Editor';
import { workspaceWritable } from '../../commercial/store';
import { BoardSession } from './session';
import * as boards from './store';
import type { Board, BoardBrief, Doc, Role } from './types';
import {
  Avatar, Button, Confirm, Empty, Field, IconButton, MenuItem, Modal, PopMenu, UserPicker, displayName, inputStyle, useIsMobile,
} from './ui';

export const ROUTE = 'whiteboard';

function useConn(): Conn {
  const { authToken, currentServerIP } = useCore();
  return useMemo(() => ({ token: authToken, serverIP: currentServerIP }), [authToken, currentServerIP]);
}

/** Save a generated file through a temporary link (user-initiated export). */
function saveFile(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const safeName = (n: string) => n.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'board';

async function svgToPng(svg: string, scale = 2): Promise<Blob> {
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((ok, fail) => { img.onload = () => ok(); img.onerror = () => fail(new Error('render')); img.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(8000, img.width * scale);
    canvas.height = Math.min(8000, img.height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(canvas.width / img.width, canvas.height / img.height);
    ctx.drawImage(img, 0, 0);
    return await new Promise((ok, fail) => canvas.toBlob(b => (b ? ok(b) : fail(new Error('png'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function ShareDialog({ board, onClose, onChanged }: { board: Board; onClose: () => void; onChanged: (b: Board) => void }) {
  const t = useModuleT();
  const conn = useConn();
  const { currentServerIP } = useCore();
  const [role, setRole] = useState<Role>('editor');
  const owner = board.role === 'owner';
  const search = useCallback((q: string) => api.users(conn, q), [conn]);
  const run = async (p: Promise<unknown>) => {
    try {
      await p;
      onChanged(await api.board(conn, board.id));
    } catch (e) { reportError(e); }
  };
  return (
    <Modal title={<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Share2 size={17} /> {t('wb_share')}</span>} onClose={onClose} width={480}>
      {owner ? (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <UserPicker search={search} serverIP={currentServerIP} exclude={board.members.map(m => m.id)} placeholder={t('wb_invite_ph')}
              onPick={u => void run(api.addMember(conn, board.id, u.id, role))} />
          </div>
          <select value={role} onChange={e => setRole(e.target.value as Role)} style={{ ...inputStyle(), width: 140 }}>
            <option value="editor">{t('wb_role_editor')}</option>
            <option value="viewer">{t('wb_role_viewer')}</option>
          </select>
        </div>
      ) : (
        <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-secondary)' }}>{t('wb_share_owner_only')}</p>
      )}
      {board.members.map(m => (
        <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0' }}>
          <Avatar user={m} size={32} serverIP={currentServerIP} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{displayName(m)}</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>@{m.username}</div>
          </div>
          {owner && m.role !== 'owner' ? (
            <>
              <select value={m.role} onChange={e => void run(api.setRole(conn, board.id, m.id, e.target.value as Role))} style={{ ...inputStyle(), width: 130, padding: '5px 8px' }}>
                <option value="editor">{t('wb_role_editor')}</option>
                <option value="viewer">{t('wb_role_viewer')}</option>
              </select>
              <IconButton title={t('wb_remove_member')} onClick={() => void run(api.removeMember(conn, board.id, m.id))}><UserMinus size={15} /></IconButton>
            </>
          ) : <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 600 }}>{t(`wb_role_${m.role}`)}</span>}
        </div>
      ))}
    </Modal>
  );
}

function BoardScreen({ boardId }: { boardId: string }) {
  const t = useModuleT();
  const conn = useConn();
  const { setCurrentServer } = useCore();
  const mobile = useIsMobile();
  const [board, setBoard] = useState<Board | null>(null);
  const [session, setSession] = useState<BoardSession | null>(null);
  const [error, setError] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [share, setShare] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const exporter = useRef<{ svg: () => string | null; api: EditorApi } | null>(null);

  useEffect(() => {
    let s: BoardSession | null = null;
    let dead = false;
    setError(false);
    api.board(conn, boardId).then(b => {
      if (dead) return;
      setBoard(b);
      setName(b.name);
      s = new BoardSession(conn, boardId, b.doc, b.version, b.name);
      s.connect();
      setSession(s);
    }).catch(() => { if (!dead) setError(true); });
    return () => { dead = true; s?.close(); setSession(null); };
  }, [conn, boardId]);

  const tick = useSyncExternalStore(session?.subscribe ?? (() => () => {}), session?.snapshot ?? (() => 0));
  void tick;

  useEffect(() => {
    if (session?.removed) { void boards.refresh(); setCurrentServer(navigate.moduleRoute(ROUTE, '')); }
  }, [session?.removed, session, setCurrentServer]);

  if (error) return <Empty icon={<PenTool size={30} />} title={t('wb_missing')} action={<Button onClick={() => setCurrentServer(navigate.moduleRoute(ROUTE, ''))}>{t('wb_back')}</Button>} />;
  if (!board || !session) return <div style={{ flex: 1, background: 'var(--bg-primary)' }} />;

  const readOnly = board.role === 'viewer' || !workspaceWritable('whiteboard');
  const title = session.name;

  const commitName = async () => {
    setRenaming(false);
    const v = name.trim();
    if (!v || v === title) { setName(title); return; }
    try {
      await api.rename(conn, board.id, v);
      session.name = v;
      void boards.refresh();
    } catch (e) { reportError(e); }
  };

  const exportAs = async (kind: 'png' | 'svg' | 'json') => {
    setMenu(null);
    if (kind === 'json') {
      saveFile(`${safeName(title)}.sfera-board.json`, new Blob([JSON.stringify({ format: 'sfera-whiteboard', version: 1, name: title, doc: session.doc }, null, 2)], { type: 'application/json' }));
      return;
    }
    const svg = exporter.current?.svg();
    if (!svg) { reportError(new Error(t('wb_export_empty'))); return; }
    if (kind === 'svg') saveFile(`${safeName(title)}.svg`, new Blob([svg], { type: 'image/svg+xml' }));
    else {
      try { saveFile(`${safeName(title)}.png`, await svgToPng(svg)); } catch (e) { reportError(e); }
    }
  };

  const duplicateBoard = async () => {
    setMenu(null);
    try {
      const copy = await api.create(conn, `${title} (${t('wb_copy')})`, session.doc);
      void boards.refresh();
      setCurrentServer(navigate.moduleRoute(ROUTE, copy.id));
    } catch (e) { reportError(e); }
  };

  const peers = [...session.peers.values()];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-secondary)' }}>
        <IconButton title={t('wb_all_boards')} onClick={() => setCurrentServer(navigate.moduleRoute(ROUTE, ''))}><ArrowLeft size={17} /></IconButton>
        <PenTool size={17} color="var(--accent-primary)" />
        {renaming ? (
          <input autoFocus value={name} onChange={e => setName(e.target.value)} onBlur={() => void commitName()}
            onKeyDown={e => { if (e.key === 'Enter') void commitName(); if (e.key === 'Escape') { setName(title); setRenaming(false); } }}
            style={{ ...inputStyle(), width: 260, padding: '5px 8px', fontWeight: 700 }} />
        ) : (
          <h1 onDoubleClick={() => !readOnly && setRenaming(true)} title={readOnly ? title : t('wb_rename_hint')}
            style={{ margin: 0, fontSize: 15.5, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            {title}
          </h1>
        )}
        {readOnly && <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>{t('wb_view_only')}</span>}
        <span title={session.connected ? t('wb_live') : t('wb_offline')} style={{ display: 'inline-flex', color: session.connected ? '#10b981' : 'var(--text-tertiary)' }}>
          {session.connected ? <Wifi size={14} /> : <WifiOff size={14} />}
        </span>
        <div style={{ flex: 1 }} />
        {!mobile && peers.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {peers.slice(0, 5).map((p, i) => <span key={p.channel} style={{ marginLeft: i ? -8 : 0 }}><Avatar user={p.user} size={26} ring /></span>)}
          </div>
        )}
        <Button small kind="primary" onClick={() => setShare(true)}><Share2 size={14} /> {!mobile && t('wb_share')}</Button>
        <IconButton title={t('wb_more')} onClick={e => setMenu({ x: e.clientX - 180, y: e.clientY + 12 })}><MoreHorizontal size={17} /></IconButton>
      </header>

      <Editor session={session} readOnly={readOnly} onExportReady={fn => { exporter.current = fn; }} />

      {share && <ShareDialog board={board} onClose={() => setShare(false)} onChanged={setBoard} />}
      {menu && (
        <PopMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <MenuItem icon={<ImageIcon size={14} />} label={t('wb_export_png')} onClick={() => void exportAs('png')} />
          <MenuItem icon={<Download size={14} />} label={t('wb_export_svg')} onClick={() => void exportAs('svg')} />
          <MenuItem icon={<FileJson size={14} />} label={t('wb_export_json')} onClick={() => void exportAs('json')} />
          <MenuItem icon={<Copy size={14} />} label={t('wb_duplicate_board')} onClick={() => void duplicateBoard()} />
          {!readOnly && <MenuItem icon={<Pencil size={14} />} label={t('wb_rename')} onClick={() => { setMenu(null); setRenaming(true); }} />}
        </PopMenu>
      )}
    </div>
  );
}

function BoardCard({ b, onOpen, onMenu }: { b: BoardBrief; onOpen: () => void; onMenu: (e: React.MouseEvent) => void }) {
  const t = useModuleT();
  const { language } = useCore();
  const hue = [...b.id].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return (
    <div
      role="button" tabIndex={0} onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter') onOpen(); }}
      onContextMenu={e => { e.preventDefault(); onMenu(e); }}
      style={{ borderRadius: 14, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', cursor: 'pointer', overflow: 'hidden', transition: 'transform .15s, box-shadow .15s' }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = 'var(--shadow-md)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}
    >
      <div style={{
        height: 110, position: 'relative',
        background: `radial-gradient(circle at 1px 1px, rgba(127,127,127,.25) 1px, transparent 0) 0 0 / 12px 12px, linear-gradient(135deg, hsla(${hue},70%,60%,.18), hsla(${(hue + 50) % 360},70%,55%,.08))`,
      }}>
        <svg viewBox="0 0 200 110" preserveAspectRatio="xMidYMid meet" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.75 }}>
          <rect x="28" y="30" width="52" height="30" rx="6" fill="none" stroke={`hsl(${hue},60%,55%)`} strokeWidth="2" />
          <path d="M80 45 H110 V70 H128" fill="none" stroke={`hsl(${hue},60%,55%)`} strokeWidth="2" />
          <path d="M150 50 L172 70 L150 90 L128 70 Z" fill="none" stroke={`hsl(${(hue + 50) % 360},60%,55%)`} strokeWidth="2" />
        </svg>
        <button type="button" aria-label={t('wb_more')} onClick={e => { e.stopPropagation(); onMenu(e); }}
          style={{ position: 'absolute', right: 8, top: 8, width: 28, height: 28, borderRadius: 8, border: 'none', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <MoreHorizontal size={15} />
        </button>
      </div>
      <div style={{ padding: '10px 12px' }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
          {t('wb_shapes_count').replace('{n}', String(b.shapes))} · {new Date(b.updated_at).toLocaleDateString(language, { day: 'numeric', month: 'short' })}
          {b.role !== 'owner' && ` · ${t(`wb_role_${b.role}`)}`}
        </div>
      </div>
    </div>
  );
}

const TEMPLATES: { id: string; build: (tr: (k: string) => string) => Doc }[] = [
  { id: 'blank', build: () => ({ shapes: {}, order: [] }) },
  {
    id: 'flow',
    build: tr => {
      const st = { fill: 'paper', stroke: 'ink', strokeWidth: 2, dash: 'solid' as const, opacity: 1, fontSize: 16, textColor: 'ink', align: 'center' as const, vAlign: 'middle' as const, bold: false, radius: 8 };
      const shapes: Doc['shapes'] = {
        s: { id: 's', type: 'ellipse', x: 0, y: 0, w: 160, h: 70, text: tr('wb_tpl_start'), style: { ...st, fill: '#dcfce7', stroke: '#22c55e' } },
        a: { id: 'a', type: 'rect', x: 0, y: 130, w: 160, h: 80, text: tr('wb_tpl_step'), style: st },
        d: { id: 'd', type: 'diamond', x: 0, y: 270, w: 160, h: 120, text: tr('wb_tpl_check'), style: { ...st, fill: '#fef9c3', stroke: '#eab308' } },
        e: { id: 'e', type: 'ellipse', x: 0, y: 450, w: 160, h: 70, text: tr('wb_tpl_end'), style: { ...st, fill: '#fee2e2', stroke: '#ef4444' } },
        f: { id: 'f', type: 'rect', x: 260, y: 290, w: 160, h: 80, text: tr('wb_tpl_fix'), style: st },
      };
      const line = (id: string, from: string, to: string, text = '', fromSide?: 'right' | 'top', toSide?: 'right' | 'top') => ({
        id, type: 'line' as const, from: { x: 0, y: 0, shapeId: from, side: fromSide ?? 'auto' as const }, to: { x: 0, y: 0, shapeId: to, side: toSide ?? 'auto' as const },
        route: 'orthogonal' as const, arrowStart: 'none' as const, arrowEnd: 'triangle' as const, text, style: { ...st, fill: 'transparent', fontSize: 14 },
      });
      Object.assign(shapes, {
        l1: line('l1', 's', 'a'), l2: line('l2', 'a', 'd'), l3: line('l3', 'd', 'e', tr('wb_tpl_yes')),
        l4: line('l4', 'd', 'f', tr('wb_tpl_no'), 'right'), l5: line('l5', 'f', 'a', '', 'top', 'right'),
      });
      return { shapes, order: Object.keys(shapes) };
    },
  },
];

function Home() {
  const t = useModuleT();
  const conn = useConn();
  const { setCurrentServer } = useCore();
  const list = useModuleStore(boards.store, s => s.boards);
  const loaded = useModuleStore(boards.store, s => s.loaded);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [menu, setMenu] = useState<{ b: BoardBrief; x: number; y: number } | null>(null);
  const [deleting, setDeleting] = useState<BoardBrief | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const open = (id: string) => setCurrentServer(navigate.moduleRoute(ROUTE, id));

  const create = async (doc?: Doc, boardName = name.trim()) => {
    if (!boardName) return;
    try {
      const b = await api.create(conn, boardName, doc);
      setCreating(null);
      setName('');
      void boards.refresh();
      open(b.id);
    } catch (e) { reportError(e); }
  };

  const importFile = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (data?.format !== 'sfera-whiteboard' || !data.doc?.shapes) throw new Error(t('wb_import_bad'));
      await create(data.doc, String(data.name || file.name.replace(/\.json$/i, '')).slice(0, 120));
    } catch (e) { reportError(e); }
  };

  const shown = list.filter(b => b.name.toLowerCase().includes(query.trim().toLowerCase()));
  const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 };

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '20px 20px 40px', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
          <div style={{ width: 40, height: 40, borderRadius: 12, background: 'linear-gradient(135deg,#f97316,#ec4899)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <PenTool size={21} color="#fff" />
          </div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: 'var(--text-primary)', flex: 1 }}>{t('wb_title')}</h1>
          <div style={{ position: 'relative', width: 220 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--text-tertiary)' }} />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('wb_search')} style={{ ...inputStyle(), paddingLeft: 30 }} />
          </div>
          <Button onClick={() => fileRef.current?.click()}><Upload size={15} /> {t('wb_import')}</Button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} />
        </div>

        <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 10 }}>{t('wb_new_board')}</div>
        <div style={{ ...grid, marginBottom: 26 }}>
          {TEMPLATES.map(tpl => (
            <button key={tpl.id} type="button" onClick={() => { setCreating(tpl.id); setName(tpl.id === 'blank' ? '' : t('wb_tpl_flow')); }}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, border: '1px dashed var(--border-color)', background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
              <span style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(var(--accent-rgb), .12)', color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {tpl.id === 'blank' ? <Plus size={20} /> : <PenTool size={18} />}
              </span>
              <span>
                <span style={{ display: 'block', fontWeight: 700, color: 'var(--text-primary)', fontSize: 14 }}>{t(`wb_tpl_${tpl.id}`)}</span>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--text-tertiary)' }}>{t(`wb_tpl_${tpl.id}_hint`)}</span>
              </span>
            </button>
          ))}
        </div>

        <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 10 }}>{t('wb_my_boards')}</div>
        {loaded && list.length === 0 ? (
          <Empty icon={<PenTool size={30} />} title={t('wb_no_boards')} hint={t('wb_no_boards_hint')} />
        ) : (
          <div style={grid}>
            {shown.map(b => <BoardCard key={b.id} b={b} onOpen={() => open(b.id)} onMenu={e => setMenu({ b, x: e.clientX, y: e.clientY })} />)}
          </div>
        )}
      </div>

      {creating && (
        <Modal title={t('wb_new_board')} onClose={() => setCreating(null)} footer={
          <>
            <Button onClick={() => setCreating(null)}>{t('wb_cancel')}</Button>
            <Button kind="primary" disabled={!name.trim()} onClick={() => void create(TEMPLATES.find(x => x.id === creating)?.build(t))}>{t('wb_create')}</Button>
          </>
        }>
          <Field label={t('wb_board_name')}>
            <input autoFocus value={name} maxLength={120} onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void create(TEMPLATES.find(x => x.id === creating)?.build(t)); }}
              placeholder={t('wb_board_name_ph')} style={inputStyle()} />
          </Field>
        </Modal>
      )}
      {menu && (
        <PopMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <MenuItem icon={<PenTool size={14} />} label={t('wb_open')} onClick={() => { open(menu.b.id); setMenu(null); }} />
          {menu.b.role === 'owner' && <MenuItem danger icon={<Trash2 size={14} />} label={t('wb_delete_board')} onClick={() => { setDeleting(menu.b); setMenu(null); }} />}
        </PopMenu>
      )}
      {deleting && (
        <Confirm title={t('wb_delete_board')} message={t('wb_delete_board_hint').replace('{name}', deleting.name)} confirmLabel={t('wb_delete')} cancelLabel={t('wb_cancel')}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const b = deleting;
            setDeleting(null);
            try { await api.remove(conn, b.id); void boards.refresh(); } catch (e) { reportError(e); }
          }} />
      )}
    </div>
  );
}

export function WhiteboardView({ style }: { style?: CSSProperties }) {
  const { currentServer } = useCore();
  const rest = navigate.parseModuleRoute(currentServer, ROUTE) ?? '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--bg-primary)', overflow: 'hidden', ...style }}>
      {rest ? <BoardScreen key={rest} boardId={rest} /> : <Home />}
    </div>
  );
}
