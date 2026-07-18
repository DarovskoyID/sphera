import React, { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { Settings, Home, Plus, LogIn, X, Compass, Rss, LogOut, Trash2, Folder, FolderMinus, NotebookPen } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import ConfirmModal from './ConfirmModal';
import type { Guild, LayoutEntry } from '../types';

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

export const ServerSidebar: React.FC = () => {
  const { currentServer, setCurrentServer, isMobileSidebarOpen, guilds, currentGuild, selectGuild, currentServerIP, leaveGuild, deleteGuild, currentUser, serverLayout, saveLayout } = useApp();
  const tr = useTranslation();
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
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);

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

  const draggedGuild = (): Guild | null =>
    dragKey && dragKey.startsWith('g:') ? (guildById.get(dragKey.slice(2)) || null) : null;

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
  const computeMode = (targetItem: RenderItem, e: React.DragEvent): 'before' | 'after' | 'into' => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - rect.top; const h = rect.height || 1;
    const dg = draggedGuild();
    const draggingServer = !!dragKey?.startsWith('g:');
    const draggedIsDiary = !!dg?.is_private;
    const targetIsDiary = targetItem.type === 'guild' && !!targetItem.guild.is_private;
    const canInto = draggingServer && !draggedIsDiary && !targetIsDiary && dragKey !== keyOf(targetItem);
    if (canInto && y > h * 0.28 && y < h * 0.72) return 'into';
    return y < h / 2 ? 'before' : 'after';
  };

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

  useLayoutEffect(() => {
    const el = addMenuRef.current;
    if (!el || !menuPos) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight - 68;
    const x = Math.min(Math.max(menuPos.x, 8), vw - width - 8);
    const y = Math.min(Math.max(menuPos.y, 8), vh - height);
    if (x !== menuPos.x || y !== menuPos.y) setMenuPos({ x, y });
  }, [menuPos?.x, menuPos?.y]);

  useEffect(() => {
    if (!showAddMenu) return;
    const handler = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node) &&
          addBtnRef.current && !addBtnRef.current.contains(e.target as Node)) {
        setShowAddMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showAddMenu]);

  return (
    <>
      <aside className={`server-sidebar ${isMobileSidebarOpen ? 'mobile-open' : ''}`}>
        <div className="server-list">
          {/* Pinned top: Settings + DMs */}
          <button
            className={`server-icon ${currentServer === 'settings' ? 'active' : ''}`}
            onClick={() => setCurrentServer('settings')}
            title={tr('nav_settings')}
          >
            <Settings size={20} />
          </button>

          <button
            className={`server-icon ${currentServer === 'home' ? 'active' : ''}`}
            onClick={() => setCurrentServer('home')}
            title={tr('nav_direct_messages')}
          >
            <Home size={20} />
          </button>

          <div className="server-divider" />

          <button
            className={`server-icon ${currentServer === 'explore' ? 'active' : ''}`}
            onClick={() => setCurrentServer('explore')}
            title={tr('nav_explore')}
          >
            <Compass size={20} />
          </button>

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
                <div
                  key={k}
                  draggable
                  onDragStart={e => { setDragKey(k); e.dataTransfer.effectAllowed = 'move'; }}
                  onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (dragKey && dragKey !== k) setDropInfo({ key: k, mode: computeMode(item, e) }); }}
                  onDragLeave={() => setDropInfo(prev => prev?.key === k ? null : prev)}
                  onDrop={e => { e.preventDefault(); e.stopPropagation(); applyDrop(item); }}
                  onDragEnd={() => { setDragKey(null); setDropInfo(null); }}
                  style={{
                    cursor: 'grab',
                    opacity: dragKey === k ? 0.4 : 1,
                    borderTop: isBefore ? '2px solid var(--accent-primary)' : '2px solid transparent',
                    borderBottom: isAfter ? '2px solid var(--accent-primary)' : '2px solid transparent',
                    borderRadius: 8,
                    boxShadow: isInto ? '0 0 0 2px var(--accent-primary)' : 'none',
                    transition: 'box-shadow .12s',
                  }}
                >
                  {children}
                </div>
              );
              if (item.type === 'guild') {
                const guild = item.guild;
                return wrap(
                  <div onContextMenu={e => { e.preventDefault(); setGuildMenu({ guild, x: e.clientX, y: e.clientY }); }}>
                    <GuildIcon
                      guild={guild}
                      active={currentServer === String(guild.id)}
                      onClick={() => selectGuild(guild)}
                      serverIP={currentServerIP}
                    />
                  </div>
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
        <div
          ref={addMenuRef}
          className="context-menu"
          style={{ position: 'fixed', left: menuPos.x, top: menuPos.y, minWidth: 180, zIndex: 9999 }}
        >
          <button className="context-menu-item" onClick={() => { setShowAddMenu(false); setShowCreate(true); }}>
            <Plus size={14} /> {tr('guild_create_server')}
          </button>
          <button className="context-menu-item" onClick={() => { setShowAddMenu(false); setShowCreateChannel(true); }}>
            <Rss size={14} /> {tr('guild_create_channel')}
          </button>
          <button className="context-menu-item" onClick={() => { setShowAddMenu(false); setShowJoin(true); }}>
            <LogIn size={14} /> {tr('guild_join_server')}
          </button>
          <button className="context-menu-item" onClick={() => { setShowAddMenu(false); setShowJoinChannel(true); }}>
            <Rss size={14} /> {tr('guild_join_channel')}
          </button>
        </div>
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
                  draggable
                  onDragStart={e => { setDragKey(`g:${g.id}`); e.dataTransfer.effectAllowed = 'move'; setOpenFolder(null); }}
                  onDragEnd={() => { setDragKey(null); setDropInfo(null); }}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, cursor: 'grab' }}
                >
                  <div onContextMenu={e => { e.preventDefault(); setOpenFolder(null); setGuildMenu({ guild: g, x: e.clientX, y: e.clientY }); }}>
                    <GuildIcon
                      guild={g}
                      active={currentServer === String(g.id)}
                      onClick={() => { setOpenFolder(null); selectGuild(g); }}
                      serverIP={currentServerIP}
                    />
                  </div>
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
