import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Settings, Home, Plus, LogIn, X, Compass, Rss, LogOut, Trash2, Folder, FolderMinus, NotebookPen, Bot } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import ConfirmModal from './ConfirmModal';
import type { Guild, LayoutEntry } from '../types';
import { openSferonik } from '../utils/botsApi';
import { useAnchoredMenu } from './useAnchoredMenu';
import { LONG_PRESS_SAFE, useDragArm, useIsTouch, useLongPress } from './useLongPress';

function CreateGuildModal({ onClose }: { onClose: () => void }) {
  const { createGuild, selectGuild } = useApp();
  const tr = useTranslation();
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    const guild = await createGuild(name.trim(), desc.trim());
    setLoading(false);
    if (guild) { selectGuild(guild); onClose(); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: 400 }}>
        <div className="modal-header">
          <span>{tr('guild_create_server_title')}</span>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 0 0' }}>
          <input
            className="input-field"
            placeholder={tr('guild_server_name')}
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={100}
            autoFocus
          />
          <input
            className="input-field"
            placeholder={tr('guild_description')}
            value={desc}
            onChange={e => setDesc(e.target.value)}
            maxLength={500}
          />
          <button className="btn-primary" type="submit" disabled={loading || !name.trim()}>
            {loading ? tr('guild_creating') : tr('guild_create')}
          </button>
        </form>
      </div>
    </div>
  );
}

function CreatePersonalChannelModal({ onClose }: { onClose: () => void }) {
  const { createPersonalChannel, selectGuild } = useApp();
  const tr = useTranslation();
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    const guild = await createPersonalChannel(name.trim(), desc.trim());
    setLoading(false);
    if (guild) { selectGuild(guild); onClose(); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: 400 }}>
        <div className="modal-header">
          <span>{tr('guild_create_channel_title')}</span>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '8px 0 12px' }}>
          {tr('guild_channel_desc')}
        </p>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            className="input-field"
            placeholder={tr('guild_channel_name')}
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={100}
            autoFocus
          />
          <input
            className="input-field"
            placeholder={tr('guild_description')}
            value={desc}
            onChange={e => setDesc(e.target.value)}
            maxLength={500}
          />
          <button className="btn-primary" type="submit" disabled={loading || !name.trim()}>
            {loading ? tr('guild_creating') : tr('guild_create_channel_btn')}
          </button>
        </form>
      </div>
    </div>
  );
}

function JoinGuildModal({ onClose, channel = false }: { onClose: () => void; channel?: boolean }) {
  const { joinGuild, selectGuild } = useApp();
  const tr = useTranslation();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setLoading(true);
    const guild = await joinGuild(code.trim());
    setLoading(false);
    if (guild) { selectGuild(guild); onClose(); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: 400 }}>
        <div className="modal-header">
          <span>{tr(channel ? 'guild_join_channel_title' : 'guild_join_server_title')}</span>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 0 0' }}>
          <input
            className="input-field"
            placeholder={tr(channel ? 'guild_channel_invite_code' : 'guild_invite_code')}
            value={code}
            onChange={e => setCode(e.target.value)}
            autoFocus
          />
          <button className="btn-primary" type="submit" disabled={loading || !code.trim()}>
            {loading ? tr('guild_joining') : tr('guild_join')}
          </button>
        </form>
      </div>
    </div>
  );
}

// A lively, name-derived gradient so icon-less servers still look distinct and fun.
function nameGradient(name: string): string {
  const h = Math.abs((name.charCodeAt(0) || 65) * 47 + (name.charCodeAt(1) || 0) * 13) % 360;
  return `linear-gradient(135deg, hsl(${h},72%,58%), hsl(${(h + 40) % 360},70%,48%))`;
}

function GuildIcon({ guild, active, onClick, serverIP }: { guild: Guild; active: boolean; onClick: () => void; serverIP: string }) {
  const tr = useTranslation();
  const [broken, setBroken] = useState(false);
  const initials = guild.name.split(' ').filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || guild.name.slice(0, 2).toUpperCase();
  const iconUrl = guild.icon && !broken ? (guild.icon.startsWith('http') ? guild.icon : `${serverIP}${guild.icon}`) : null;
  const isChannel = guild.is_personal_channel;
  const isDiary = guild.is_private;
  // Servers = softer squircle, channels/diary = rounder — a simple, modern look.
  const radius = isChannel ? 14 : 16;
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <button
        className={`server-icon ${active ? 'active' : ''}`}
        onClick={onClick}
        title={isDiary ? `${guild.name} (${tr('pcf_diary')})` : isChannel ? `${guild.name} (${tr('pcf_channel')})` : guild.name}
        style={{ borderRadius: radius, padding: 0, overflow: 'hidden', background: iconUrl ? 'var(--bg-tertiary)' : nameGradient(guild.name), border: 'none' }}
      >
        {iconUrl ? (
          <img src={iconUrl} alt={guild.name} onError={() => setBroken(true)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: 0.3, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,.25)' }}>{initials}</span>
        )}
      </button>
      {isChannel && (
        <span
          title={isDiary ? tr('pcf_diary') : tr('pcf_personal_channel')}
          style={{
            position: 'absolute', bottom: -3, right: -3, width: 17, height: 17, borderRadius: '50%',
            background: isDiary ? '#a855f7' : 'var(--accent-primary)', border: '2.5px solid var(--bg-secondary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
            boxShadow: '0 1px 4px rgba(0,0,0,.3)',
          }}
        >
          {isDiary ? <NotebookPen size={8.5} color="#fff" /> : <Rss size={8.5} color="#fff" />}
        </span>
      )}
    </div>
  );
}

type RenderItem =
  | { type: 'guild'; guild: Guild }
  | { type: 'folder'; folder: { id: string; name: string; color?: string; guilds: Guild[] } };

type AddAction = 'server' | 'channel' | 'join-server' | 'join-channel';

/**
 * A server icon whose menu opens on right-click and, on touch, on long press.
 * Its own component because hooks cannot live inside the list callback.
 */
const GuildIconWithMenu: React.FC<{
  guild: Guild;
  active: boolean;
  serverIP: string;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
}> = ({ guild, active, serverIP, onOpen, onMenu }) => {
  const press = useLongPress(onMenu);
  return (
    <div
      style={LONG_PRESS_SAFE}
      onContextMenu={e => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}
      {...press}
    >
      <GuildIcon guild={guild} active={active} onClick={onOpen} serverIP={serverIP} />
    </div>
  );
};

/** Live boolean for a media query. */
const useMediaQuery = (query: string): boolean => {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [query]);
  return matches;
};

/**
 * One reorderable slot in the server bar.
 *
 * Its own component because the touch-drag hook cannot be called from inside
 * the list callback. On desktop it is a plain HTML5 drag source; on touch the
 * finger arms `onArm` after a second and the parent takes over from there.
 */
const ReorderSlot: React.FC<{
  itemKey: string;
  draggable: boolean;
  onArm: (key: string) => void;
  style: React.CSSProperties;
  children: React.ReactNode;
} & Pick<React.HTMLAttributes<HTMLDivElement>,
  'onDragStart' | 'onDragOver' | 'onDragLeave' | 'onDrop' | 'onDragEnd'>
> = ({ itemKey, draggable, onArm, style, children, ...dragProps }) => {
  const arm = useDragArm(useCallback(() => onArm(itemKey), [onArm, itemKey]));
  return (
    <div
      data-drag-key={itemKey}
      draggable={draggable}
      {...dragProps}
      {...arm}
      style={{ ...LONG_PRESS_SAFE, ...style }}
    >
      {children}
    </div>
  );
};

/**
 * The "+" menu at the foot of the server bar. Its own component so it can use
 * the shared anchoring hook — the version inlined here wrote its clamped
 * position back over the anchor it had just been given, so the second pass
 * clamped an already-clamped point and the menu crept up the screen.
 */
const AddMenu: React.FC<{
  pos: { x: number; y: number };
  anchorButton: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onPick: (what: AddAction) => void;
}> = ({ pos, anchorButton, onClose, onPick }) => {
  const tr = useTranslation();
  const { ref, style, portal } = useAnchoredMenu(pos, onClose, anchorButton);

  return portal(
    <div ref={ref} className="context-menu" style={{ ...style, minWidth: 180, zIndex: 9999 }}>
      <button className="context-menu-item" onClick={() => onPick('server')}>
        <Plus size={14} /> {tr('guild_create_server')}
      </button>
      <button className="context-menu-item" onClick={() => onPick('channel')}>
        <Rss size={14} /> {tr('guild_create_channel')}
      </button>
      <button className="context-menu-item" onClick={() => onPick('join-server')}>
        <LogIn size={14} /> {tr('guild_join_server')}
      </button>
      <button className="context-menu-item" onClick={() => onPick('join-channel')}>
        <Rss size={14} /> {tr('guild_join_channel')}
      </button>
    </div>
  );
};

export const ServerSidebar: React.FC = () => {
  const {
    currentServer, setCurrentServer, isMobileSidebarOpen, guilds, selectGuild,
    currentServerIP, leaveGuild, deleteGuild, currentUser, serverLayout, saveLayout,
    authToken, setCurrentChat, setMobileActivePanel,
  } = useApp();
  const tr = useTranslation();
  const isRu = tr('nav_explore') === 'Исследовать';
  const isChild = !!currentUser?.is_child;
  // Сфероник lives in the DM list, but it is reached from here: it is a tool,
  // not a contact, so it gets a pinned icon next to Explore.
  const [openingSferonik, setOpeningSferonik] = useState(false);
  const goToSferonik = useCallback(async () => {
    if (openingSferonik || !authToken) return;
    setOpeningSferonik(true);
    try {
      const { bot } = await openSferonik({ token: authToken, serverIP: currentServerIP });
      setCurrentServer('home');
      setCurrentChat(bot.user_id);
      setMobileActivePanel('chat-view');
    } catch {
      // Nothing to do: the sidebar stays as it was and the user can retry.
    } finally {
      setOpeningSferonik(false);
    }
  }, [authToken, currentServerIP, openingSferonik, setCurrentChat, setCurrentServer, setMobileActivePanel]);
  // Right-click a server icon (desktop) → context menu → leave / delete.
  const [guildMenu, setGuildMenu] = useState<{ guild: Guild; x: number; y: number } | null>(null);
  const [confirmLeave, setConfirmLeave] = useState<Guild | null>(null);
  const [confirmDiary, setConfirmDiary] = useState<Guild | null>(null);
  const [diaryPwd, setDiaryPwd] = useState('');
  const [diaryErr, setDiaryErr] = useState('');
  const [diaryBusy, setDiaryBusy] = useState(false);
  const guildMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!guildMenu) return;
    const close = (e: MouseEvent) => {
      if (guildMenuRef.current && !guildMenuRef.current.contains(e.target as Node)) setGuildMenu(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [guildMenu]);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [showJoinChannel, setShowJoinChannel] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const isTouch = useIsTouch();
  // Below this width the stylesheet turns the side bar into a bottom dock, and
  // the reorder axis turns with it.
  const horizontalBar = useMediaQuery('(max-width: 768px)');
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  // Server bar = ordered list of top-level items (guilds + folders), synced via
  // serverLayout. Drag reorders top-level items; folders are created/edited via
  // the right-click menu.
  const [dragKey, setDragKey] = useState<string | null>(null);   // 'g:<id>' or 'f:<id>'
  const [dropInfo, setDropInfo] = useState<{ key: string; mode: 'before' | 'after' | 'into' } | null>(null);
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const folderPopupRef = useRef<HTMLDivElement>(null);

  const guildById = useMemo(() => {
    const m = new Map<string, Guild>();
    for (const g of guilds) m.set(String(g.id), g);
    return m;
  }, [guilds]);

  // Build the render model from the saved layout, reconciled with the live guild
  // list: drop stale ids, append newly-joined guilds at the end.
  const renderItems = useMemo<RenderItem[]>(() => {
    const used = new Set<string>();
    const items: RenderItem[] = [];
    for (const e of serverLayout || []) {
      if (e.kind === 'guild') {
        const g = guildById.get(e.id);
        if (g && !used.has(e.id)) { used.add(e.id); items.push({ type: 'guild', guild: g }); }
      } else if (e.kind === 'folder') {
        const inner: Guild[] = [];
        for (const id of e.items) {
          const g = guildById.get(id);
          if (g && !used.has(id)) { used.add(id); inner.push(g); }
        }
        if (inner.length) items.push({ type: 'folder', folder: { id: e.id, name: e.name, color: e.color, guilds: inner } });
      }
    }
    for (const g of guilds) if (!used.has(String(g.id))) items.push({ type: 'guild', guild: g });
    return items;
  }, [serverLayout, guilds, guildById]);

  // Serialize the current render model back to a layout array (full coverage).
  const toLayout = useCallback((items: RenderItem[]): LayoutEntry[] =>
    items.map(it => it.type === 'guild'
      ? { kind: 'guild' as const, id: String(it.guild.id) }
      : { kind: 'folder' as const, id: it.folder.id, name: it.folder.name, color: it.folder.color, items: it.folder.guilds.map(g => String(g.id)) }
    ), []);

  const keyOf = (it: RenderItem) => it.type === 'guild' ? `g:${it.guild.id}` : `f:${it.folder.id}`;

  const newFolderId = () => `f_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  // Pull a guild out of wherever it lives; returns the rest (empty folders dropped)
  // plus the guild. Used by every drag op so a guild can freely move between the
  // top level and folders.
  const extractGuild = (items: RenderItem[], guildId: string): [RenderItem[], Guild | null] => {
    let g: Guild | null = null;
    const out: RenderItem[] = [];
    for (const it of items) {
      if (it.type === 'guild') {
        if (String(it.guild.id) === guildId) { g = it.guild; continue; }
        out.push(it);
      } else {
        const inner = it.folder.guilds.filter(x => { if (String(x.id) === guildId) { g = x; return false; } return true; });
        if (inner.length) out.push({ type: 'folder', folder: { ...it.folder, guilds: inner } });
      }
    }
    return [out, g];
  };

  // Where a drop lands: near an edge → reorder; over the middle of a server/folder
  // → merge into a folder (never for a diary, and never onto a diary).
  //
  // The bar runs down the side on desktop and along the bottom on a phone, so
  // "edge" means top/bottom in one case and left/right in the other — the axis
  // follows the same 768px breakpoint the stylesheet turns the bar into a dock.
  const computeModeAt = (
    targetItem: RenderItem,
    dk: string | null,
    rect: DOMRect,
    point: { x: number; y: number },
  ): 'before' | 'after' | 'into' => {
    const horizontal = window.matchMedia('(max-width: 768px)').matches;
    const pos = horizontal ? point.x - rect.left : point.y - rect.top;
    const size = (horizontal ? rect.width : rect.height) || 1;
    const dg = dk?.startsWith('g:') ? guildById.get(dk.slice(2)) || null : null;
    const draggingServer = !!dk?.startsWith('g:');
    const draggedIsDiary = !!dg?.is_private;
    const targetIsDiary = targetItem.type === 'guild' && !!targetItem.guild.is_private;
    const canInto = draggingServer && !draggedIsDiary && !targetIsDiary && dk !== keyOf(targetItem);
    if (canInto && pos > size * 0.28 && pos < size * 0.72) return 'into';
    return pos < size / 2 ? 'before' : 'after';
  };

  const computeMode = (targetItem: RenderItem, e: React.DragEvent): 'before' | 'after' | 'into' =>
    computeModeAt(targetItem, dragKey, (e.currentTarget as HTMLElement).getBoundingClientRect(),
      { x: e.clientX, y: e.clientY });

  const applyDrop = (targetItem: RenderItem) => {
    const info = dropInfo; const dk = dragKey;
    setDragKey(null); setDropInfo(null);
    if (!dk || !info) return;
    const targetKey = keyOf(targetItem);
    if (dk === targetKey && info.mode === 'into') return;

    // Folders only reorder among the top level.
    if (dk.startsWith('f:')) {
      const items = [...renderItems];
      const from = items.findIndex(it => keyOf(it) === dk);
      if (from < 0) return;
      const [moved] = items.splice(from, 1);
      const to = items.findIndex(it => keyOf(it) === targetKey);
      if (to < 0) { items.push(moved); } else { items.splice(info.mode === 'after' ? to + 1 : to, 0, moved); }
      saveLayout(toLayout(items)); return;
    }

    const guildId = dk.slice(2);
    const [base, g] = extractGuild(renderItems, guildId);
    if (!g) return;

    if (info.mode === 'into') {
      if (targetItem.type === 'folder') {
        saveLayout(toLayout(base.map(it => it.type === 'folder' && it.folder.id === targetItem.folder.id
          ? { ...it, folder: { ...it.folder, guilds: [...it.folder.guilds, g] } } : it)));
        return;
      }
      // Onto a server → make a folder from the two, in the target's slot.
      const idx = base.findIndex(it => keyOf(it) === targetKey);
      if (idx < 0) return;
      const target = base[idx] as Extract<RenderItem, { type: 'guild' }>;
      const items = [...base];
      items.splice(idx, 1, { type: 'folder', folder: { id: newFolderId(), name: '', guilds: [target.guild, g] } });
      saveLayout(toLayout(items)); return;
    }

    // before/after → drop as a top-level item (this is also how a guild is pulled
    // out of a folder: reorder it next to a top-level item).
    const items = [...base];
    const idx = items.findIndex(it => keyOf(it) === targetKey);
    if (idx < 0) items.push({ type: 'guild', guild: g });
    else items.splice(info.mode === 'after' ? idx + 1 : idx, 0, { type: 'guild', guild: g });
    saveLayout(toLayout(items));
  };

  // Dropped on empty bar space → pull the guild out to the end of the top level.
  const dropToTopLevel = () => {
    const dk = dragKey; setDragKey(null); setDropInfo(null);
    if (!dk || !dk.startsWith('g:')) return;
    const [base, g] = extractGuild(renderItems, dk.slice(2));
    if (!g) return;
    saveLayout(toLayout([...base, { type: 'guild', guild: g }]));
  };

  // --- Touch reordering -----------------------------------------------------
  // Touch has no HTML5 drag-and-drop, so once the long press escalates past a
  // second the finger is tracked by hand: `touchmove` finds the icon underneath
  // with elementFromPoint, `touchend` drops. The listeners are native and
  // non-passive because the move has to be preventDefault-ed — otherwise the
  // dock scrolls sideways under the finger instead of the icon following it.
  const itemByKey = useMemo(() => {
    const m = new Map<string, RenderItem>();
    for (const it of renderItems) m.set(keyOf(it), it);
    return m;
  }, [renderItems]);

  // The listeners outlive the render that created them, so they read the live
  // values through refs rather than a stale closure.
  const itemByKeyRef = useRef(itemByKey);
  itemByKeyRef.current = itemByKey;
  const dropInfoRef = useRef(dropInfo);
  dropInfoRef.current = dropInfo;
  const applyDropRef = useRef(applyDrop);
  applyDropRef.current = applyDrop;
  const computeModeAtRef = useRef(computeModeAt);
  computeModeAtRef.current = computeModeAt;

  const startTouchDrag = useCallback((key: string) => {
    // The menu opened half a second ago; the hold has turned into a drag.
    setGuildMenu(null);
    setOpenFolder(null);
    setDragKey(key);
    setDropInfo(null);

    const onMove = (ev: TouchEvent) => {
      const t = ev.touches[0];
      if (!t) return;
      ev.preventDefault();
      const host = (document.elementFromPoint(t.clientX, t.clientY) as HTMLElement | null)
        ?.closest<HTMLElement>('[data-drag-key]');
      const targetKey = host?.dataset.dragKey;
      const target = targetKey && targetKey !== key ? itemByKeyRef.current.get(targetKey) : null;
      if (!host || !target || !targetKey) { setDropInfo(null); return; }
      setDropInfo({
        key: targetKey,
        mode: computeModeAtRef.current(target, key, host.getBoundingClientRect(), { x: t.clientX, y: t.clientY }),
      });
    };

    const onEnd = () => {
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
      const info = dropInfoRef.current;
      const target = info ? itemByKeyRef.current.get(info.key) : null;
      if (target) applyDropRef.current(target);
      else { setDragKey(null); setDropInfo(null); }
    };

    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renameFolder = (folderId: string, name: string) => {
    saveLayout(toLayout(renderItems.map(it =>
      it.type === 'folder' && it.folder.id === folderId ? { ...it, folder: { ...it.folder, name } } : it)));
  };

  const ungroupFolder = (folderId: string) => {
    const items: RenderItem[] = [];
    for (const it of renderItems) {
      if (it.type === 'folder' && it.folder.id === folderId) {
        for (const g of it.folder.guilds) items.push({ type: 'guild', guild: g });
      } else items.push(it);
    }
    setOpenFolder(null);
    saveLayout(toLayout(items));
  };

  useEffect(() => {
    if (!openFolder) return;
    const close = (e: MouseEvent) => {
      if (folderPopupRef.current && !folderPopupRef.current.contains(e.target as Node)) setOpenFolder(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [openFolder]);

  return (
    <>
      <aside className={`server-sidebar ${isMobileSidebarOpen ? 'mobile-open' : ''}`} data-tour="server-dock">
        <div className="server-list">
          {/* Pinned top: Settings + DMs */}
          <button
            className={`server-icon ${currentServer === 'settings' ? 'active' : ''}`}
            onClick={() => setCurrentServer('settings')}
            title={tr('nav_settings')}
            data-tour="nav-settings"
          >
            <Settings size={20} />
          </button>

          <button
            className={`server-icon ${currentServer === 'home' ? 'active' : ''}`}
            onClick={() => setCurrentServer('home')}
            title={tr('nav_direct_messages')}
            data-tour="nav-home"
          >
            <Home size={20} />
          </button>

          <div className="server-divider" />

          <button
            className={`server-icon ${currentServer === 'explore' ? 'active' : ''}`}
            onClick={() => setCurrentServer('explore')}
            title={tr('nav_explore')}
            data-tour="nav-explore"
          >
            <Compass size={20} />
          </button>

          {/* Сфероник registers bots, which a managed account cannot do — so
              the way in goes too, not just the tools it leads to. */}
          {!isChild && (
            <button
              className="server-icon"
              onClick={goToSferonik}
              title={isRu ? 'Сфероник — создание ботов' : 'Sferonik — bot registration'}
              style={{ opacity: openingSferonik ? 0.6 : 1 }}
            >
              <Bot size={20} />
            </button>
          )}

          {/* Scrollable guild list */}
          <div
            className="server-guild-scroll"
            onDragOver={e => { if (dragKey?.startsWith('g:')) e.preventDefault(); }}
            onDrop={e => { e.preventDefault(); dropToTopLevel(); }}
          >
            {renderItems.map(item => {
              const k = keyOf(item);
              const isInto = dropInfo?.key === k && dropInfo.mode === 'into';
              const isBefore = dropInfo?.key === k && dropInfo.mode === 'before';
              const isAfter = dropInfo?.key === k && dropInfo.mode === 'after';
              const wrap = (children: React.ReactNode) => (
                <ReorderSlot
                  key={k}
                  itemKey={k}
                  // On touch, `draggable` is what swallowed the long press:
                  // Android starts a native drag and the context menu never
                  // opens. HTML5 drag does not work there anyway — a held
                  // finger arms `startTouchDrag` instead.
                  draggable={!isTouch}
                  onArm={startTouchDrag}
                  onDragStart={e => { setDragKey(k); e.dataTransfer.effectAllowed = 'move'; }}
                  onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (dragKey && dragKey !== k) setDropInfo({ key: k, mode: computeMode(item, e) }); }}
                  onDragLeave={() => setDropInfo(prev => prev?.key === k ? null : prev)}
                  onDrop={e => { e.preventDefault(); e.stopPropagation(); applyDrop(item); }}
                  onDragEnd={() => { setDragKey(null); setDropInfo(null); }}
                  style={{
                    cursor: 'grab',
                    opacity: dragKey === k ? 0.4 : 1,
                    // The insertion marker sits on whichever edge the drop
                    // would land against — the bar is vertical on desktop and
                    // horizontal in the phone dock.
                    ...(horizontalBar
                      ? {
                        borderLeft: isBefore ? '2px solid var(--accent-primary)' : '2px solid transparent',
                        borderRight: isAfter ? '2px solid var(--accent-primary)' : '2px solid transparent',
                      }
                      : {
                        borderTop: isBefore ? '2px solid var(--accent-primary)' : '2px solid transparent',
                        borderBottom: isAfter ? '2px solid var(--accent-primary)' : '2px solid transparent',
                      }),
                    borderRadius: 8,
                    boxShadow: isInto ? '0 0 0 2px var(--accent-primary)' : 'none',
                    transition: 'box-shadow .12s',
                  }}
                >
                  {children}
                </ReorderSlot>
              );
              if (item.type === 'guild') {
                const guild = item.guild;
                return wrap(
                  <GuildIconWithMenu
                    guild={guild}
                    active={currentServer === String(guild.id)}
                    serverIP={currentServerIP}
                    onOpen={() => selectGuild(guild)}
                    onMenu={(x, y) => setGuildMenu({ guild, x, y })}
                  />
                );
              }
              const f = item.folder;
              const hasActive = f.guilds.some(g => currentServer === String(g.id));
              return wrap(
                <button
                  className={`server-icon ${hasActive ? 'active' : ''}`}
                  title={f.name || tr('folder_untitled')}
                  onClick={() => setOpenFolder(prev => prev === f.id ? null : f.id)}
                  style={{ borderRadius: 16, padding: 0 }}
                >
                  <span style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, width: 34, height: 34 }}>
                    {f.guilds.slice(0, 4).map(g => (
                      <span key={g.id} style={{ position: 'relative', width: '100%', height: '100%', borderRadius: 5, overflow: 'hidden', background: nameGradient(g.name), color: '#fff', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {g.name[0]?.toUpperCase()}
                        {g.icon && <img src={g.icon.startsWith('http') ? g.icon : `${currentServerIP}${g.icon}`} alt="" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
                      </span>
                    ))}
                  </span>
                </button>
              );
            })}

            <button
              ref={addBtnRef}
              data-tour="nav-add"
              className="server-icon server-icon-add"
              onClick={() => {
                const r = addBtnRef.current?.getBoundingClientRect();
                if (r) setMenuPos({ x: r.right + 8, y: r.top });
                setShowAddMenu(v => !v);
              }}
              title={tr('srv_add_title')}
            >
              <Plus size={20} />
            </button>
          </div>
        </div>
      </aside>

      {showAddMenu && menuPos && (
        <AddMenu
          pos={menuPos}
          anchorButton={addBtnRef}
          onClose={() => setShowAddMenu(false)}
          onPick={what => {
            setShowAddMenu(false);
            if (what === 'server') setShowCreate(true);
            else if (what === 'channel') setShowCreateChannel(true);
            else if (what === 'join-server') setShowJoin(true);
            else setShowJoinChannel(true);
          }}
        />
      )}

      {guildMenu && (() => {
        const g = guildMenu.guild;
        const isOwner = !!currentUser && String(g.owner_id) === String(currentUser.id);
        const isDiary = isOwner && !!g.is_private;
        const ownsChannel = isOwner && g.is_personal_channel && !g.is_private;
        return (
          <div
            ref={guildMenuRef}
            className="context-menu"
            style={{ position: 'fixed', left: Math.min(guildMenu.x, window.innerWidth - 210), top: Math.min(guildMenu.y, window.innerHeight - 120), minWidth: 190, zIndex: 9999 }}
          >
            {isDiary ? (
              <button className="context-menu-item" style={{ color: '#ef4444' }} onClick={() => { setGuildMenu(null); setConfirmDiary(g); }}>
                <Trash2 size={14} /> {tr('diary_delete')}
              </button>
            ) : ownsChannel ? (
              <button className="context-menu-item" style={{ color: '#ef4444' }} onClick={() => { setGuildMenu(null); setConfirmLeave(g); }}>
                <Trash2 size={14} /> {tr('guild_delete_channel')}
              </button>
            ) : (
              <button className="context-menu-item" style={{ color: '#ef4444' }} onClick={() => { setGuildMenu(null); setConfirmLeave(g); }}>
                <LogOut size={14} /> {g.is_personal_channel ? tr('pcf_leave_channel') : tr('guild_leave_server')}
              </button>
            )}
          </div>
        );
      })()}

      {confirmDiary && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => { setConfirmDiary(null); setDiaryPwd(''); setDiaryErr(''); }}>
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 12, padding: 22, maxWidth: 380, width: '100%', border: '1px solid var(--border-color)' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 8px', color: 'var(--text-primary)', fontSize: 17, fontWeight: 700 }}>{tr('diary_delete')}</h3>
            <p style={{ margin: '0 0 14px', color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.5 }}>
              {tr('diary_delete_hint')}
            </p>
            <form onSubmit={e => e.preventDefault()}>
              <input
                type="password"
                autoFocus
                autoComplete="current-password"
                value={diaryPwd}
                onChange={e => { setDiaryPwd(e.target.value); setDiaryErr(''); }}
                placeholder={tr('pcf_password')}
                style={{ width: '100%', padding: '9px 11px', borderRadius: 8, fontSize: 14, border: `1px solid ${diaryErr ? '#ef4444' : 'var(--border-color)'}`, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box' }}
              />
            </form>
            {diaryErr && <div style={{ color: '#ef4444', fontSize: 12, marginTop: 6 }}>{diaryErr}</div>}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={() => { setConfirmDiary(null); setDiaryPwd(''); setDiaryErr(''); }} style={{ padding: '8px 18px', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 14, cursor: 'pointer' }}>{tr('cancel')}</button>
              <button
                disabled={diaryBusy || !diaryPwd}
                onClick={async () => {
                  setDiaryBusy(true);
                  const ok = await deleteGuild(confirmDiary.id, diaryPwd);
                  setDiaryBusy(false);
                  if (ok) { setConfirmDiary(null); setDiaryPwd(''); setDiaryErr(''); }
                  else setDiaryErr(tr('pcf_wrong_password'));
                }}
                style={{ padding: '8px 18px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: (diaryBusy || !diaryPwd) ? 0.6 : 1 }}
              >
                {diaryBusy ? tr('pcf_deleting') : tr('pcf_delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmLeave && (() => {
        const g = confirmLeave;
        const isOwner = !!currentUser && String(g.owner_id) === String(currentUser.id);
        const ownsChannel = isOwner && g.is_personal_channel && !g.is_private;
        return (
          <ConfirmModal
            title={ownsChannel ? tr('guild_delete_channel') : (g.is_personal_channel ? tr('pcf_leave_channel') : tr('guild_leave_server'))}
            message={ownsChannel
              ? `${tr('pcf_delete')} «${g.name}»? ${tr('pcf_irreversible')}`
              : `${tr('pcf_leave')} «${g.name}»?`}
            confirmLabel={ownsChannel ? tr('guild_delete_channel') : tr('guild_leave_server')}
            cancelLabel={tr('cancel')}
            onCancel={() => setConfirmLeave(null)}
            onConfirm={async () => {
              const target = g;
              setConfirmLeave(null);
              if (ownsChannel) { await deleteGuild(target.id); }
              else { await leaveGuild(target.id); }
            }}
          />
        );
      })()}

      {openFolder && (() => {
        const f = renderItems.find(it => it.type === 'folder' && it.folder.id === openFolder) as Extract<RenderItem, { type: 'folder' }> | undefined;
        if (!f) return null;
        return (
          <div
            ref={folderPopupRef}
            style={{
              position: 'fixed', left: 84, top: 90, zIndex: 9998, width: 320, maxWidth: 'calc(100vw - 100px)',
              background: 'var(--bg-secondary)', borderRadius: 14, padding: 14,
              border: '1px solid var(--border-color)', boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Folder size={16} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
              <input
                value={f.folder.name}
                onChange={e => renameFolder(f.folder.id, e.target.value)}
                placeholder={tr('folder_name')}
                maxLength={60}
                style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', borderBottom: '1px solid var(--border-color)', color: 'var(--text-primary)', fontSize: 15, fontWeight: 600, outline: 'none', padding: '2px 0' }}
              />
              <button onClick={() => ungroupFolder(f.folder.id)} title={tr('folder_ungroup')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted, #949ba4)', flexShrink: 0 }}>
                <FolderMinus size={16} />
              </button>
              <button onClick={() => setOpenFolder(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted, #949ba4)', flexShrink: 0 }}>
                <X size={16} />
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 56px)', gap: 10, justifyContent: 'start' }}>
              {f.folder.guilds.map(g => (
                <div
                  key={g.id}
                  draggable={!isTouch}
                  onDragStart={e => { setDragKey(`g:${g.id}`); e.dataTransfer.effectAllowed = 'move'; setOpenFolder(null); }}
                  onDragEnd={() => { setDragKey(null); setDropInfo(null); }}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, cursor: 'grab' }}
                >
                  <GuildIconWithMenu
                    guild={g}
                    active={currentServer === String(g.id)}
                    serverIP={currentServerIP}
                    onOpen={() => { setOpenFolder(null); selectGuild(g); }}
                    onMenu={(x, y) => { setOpenFolder(null); setGuildMenu({ guild: g, x, y }); }}
                  />
                  <span style={{ fontSize: 10, color: 'var(--text-tertiary)', maxWidth: 56, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>{g.name}</span>
                </div>
              ))}
              <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--text-tertiary)', paddingTop: 4 }}>{tr('folder_drag_out_hint')}</div>
            </div>
          </div>
        );
      })()}

      {showCreate && <CreateGuildModal onClose={() => setShowCreate(false)} />}
      {showCreateChannel && <CreatePersonalChannelModal onClose={() => setShowCreateChannel(false)} />}
      {showJoin && <JoinGuildModal onClose={() => setShowJoin(false)} />}
      {showJoinChannel && <JoinGuildModal channel onClose={() => setShowJoinChannel(false)} />}
    </>
  );
};
