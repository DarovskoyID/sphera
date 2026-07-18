import React, { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { Settings, Home, Plus, LogIn, X, Compass, Rss, LogOut, Trash2, Folder, FolderPlus, FolderMinus, NotebookPen } from 'lucide-react';
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

function GuildIcon({ guild, active, onClick, serverIP }: { guild: Guild; active: boolean; onClick: () => void; serverIP: string }) {
  const tr = useTranslation();
  const initials = guild.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const iconUrl = guild.icon ? (guild.icon.startsWith('http') ? guild.icon : `${serverIP}${guild.icon}`) : null;
  const isChannel = guild.is_personal_channel;
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <button
        className={`server-icon ${active ? 'active' : ''}`}
        onClick={onClick}
        title={isChannel ? `${guild.name} (${tr('pcf_channel')})` : guild.name}
        style={isChannel ? { borderRadius: 12 } : undefined}
      >
        {iconUrl ? (
          <img src={iconUrl} alt={guild.name} style={{ width: 36, height: 36, borderRadius: isChannel ? 12 : '50%', objectFit: 'cover' }} />
        ) : (
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.5 }}>{initials}</span>
        )}
      </button>
      {isChannel && (
        <span
          title={guild.is_private ? tr('pcf_diary') : tr('pcf_personal_channel')}
          style={{
            position: 'absolute', bottom: -2, right: -2, width: 16, height: 16, borderRadius: '50%',
            background: guild.is_private ? '#a855f7' : 'var(--accent-primary)', border: '2px solid var(--bg-secondary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
          }}
        >
          {guild.is_private ? <NotebookPen size={8} color="#fff" /> : <Rss size={8} color="#fff" />}
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
  const [overKey, setOverKey] = useState<string | null>(null);
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

  const reorder = (targetKey: string) => {
    const src = dragKey;
    setDragKey(null); setOverKey(null);
    if (!src || src === targetKey) return;
    const items = [...renderItems];
    const from = items.findIndex(it => keyOf(it) === src);
    const to = items.findIndex(it => keyOf(it) === targetKey);
    if (from < 0 || to < 0) return;
    items.splice(to, 0, items.splice(from, 1)[0]);
    saveLayout(toLayout(items));
  };

  const newFolderId = () => `f_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const moveGuildToFolder = (guildId: string, folderId: string | 'new') => {
    let items = renderItems
      .map(it => it.type === 'folder'
        ? { ...it, folder: { ...it.folder, guilds: it.folder.guilds.filter(g => String(g.id) !== guildId) } }
        : it)
      .filter(it => it.type !== 'folder' || it.folder.guilds.length > 0);
    const g = guildById.get(guildId);
    if (!g) return;
    items = items.filter(it => !(it.type === 'guild' && String(it.guild.id) === guildId));
    if (folderId === 'new') {
      items.push({ type: 'folder', folder: { id: newFolderId(), name: '', guilds: [g] } });
    } else {
      const f = items.find(it => it.type === 'folder' && it.folder.id === folderId) as Extract<RenderItem, { type: 'folder' }> | undefined;
      if (f) f.folder.guilds.push(g);
      else items.push({ type: 'folder', folder: { id: folderId, name: '', guilds: [g] } });
    }
    saveLayout(toLayout(items));
  };

  const removeGuildFromFolder = (guildId: string) => {
    const g = guildById.get(guildId);
    if (!g) return;
    const items = renderItems
      .map(it => it.type === 'folder'
        ? { ...it, folder: { ...it.folder, guilds: it.folder.guilds.filter(x => String(x.id) !== guildId) } }
        : it)
      .filter(it => it.type !== 'folder' || it.folder.guilds.length > 0);
    items.push({ type: 'guild', guild: g });
    saveLayout(toLayout(items));
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

  const folderOf = (guildId: string) =>
    (renderItems.find(it => it.type === 'folder' && it.folder.guilds.some(g => String(g.id) === guildId)) as Extract<RenderItem, { type: 'folder' }> | undefined)?.folder;

  const allFolders = renderItems.filter(it => it.type === 'folder') as Extract<RenderItem, { type: 'folder' }>[];

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
          <div className="server-guild-scroll">
            {renderItems.map(item => {
              const k = keyOf(item);
              const wrap = (children: React.ReactNode) => (
                <div
                  key={k}
                  draggable
                  onDragStart={e => { setDragKey(k); e.dataTransfer.effectAllowed = 'move'; }}
                  onDragOver={e => { e.preventDefault(); if (dragKey && dragKey !== k) setOverKey(k); }}
                  onDragLeave={() => setOverKey(prev => prev === k ? null : prev)}
                  onDrop={e => { e.preventDefault(); reorder(k); }}
                  onDragEnd={() => { setDragKey(null); setOverKey(null); }}
                  style={{
                    cursor: 'grab',
                    opacity: dragKey === k ? 0.4 : 1,
                    borderTop: overKey === k ? '2px solid var(--accent-primary)' : '2px solid transparent',
                    borderRadius: 4,
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
                      g.icon
                        ? <img key={g.id} src={g.icon.startsWith('http') ? g.icon : `${currentServerIP}${g.icon}`} alt="" style={{ width: '100%', height: '100%', borderRadius: 5, objectFit: 'cover' }} />
                        : <span key={g.id} style={{ width: '100%', height: '100%', borderRadius: 5, background: 'var(--accent-primary)', color: '#fff', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{g.name[0]?.toUpperCase()}</span>
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
        const ownsChannel = isOwner && g.is_personal_channel;
        return (
          <div
            ref={guildMenuRef}
            className="context-menu"
            style={{ position: 'fixed', left: Math.min(guildMenu.x, window.innerWidth - 210), top: Math.min(guildMenu.y, window.innerHeight - 260), minWidth: 190, zIndex: 9999 }}
          >
            {folderOf(String(g.id)) ? (
              <button className="context-menu-item" onClick={() => { setGuildMenu(null); removeGuildFromFolder(String(g.id)); }}>
                <FolderMinus size={14} /> {tr('folder_remove_from')}
              </button>
            ) : (
              <>
                <button className="context-menu-item" onClick={() => { setGuildMenu(null); moveGuildToFolder(String(g.id), 'new'); }}>
                  <FolderPlus size={14} /> {tr('folder_new')}
                </button>
                {allFolders.map(fit => (
                  <button key={fit.folder.id} className="context-menu-item" onClick={() => { setGuildMenu(null); moveGuildToFolder(String(g.id), fit.folder.id); }}>
                    <Folder size={14} /> {fit.folder.name || tr('folder_untitled')}
                  </button>
                ))}
              </>
            )}
            <div style={{ height: 1, background: 'var(--border-color)', margin: '4px 0' }} />
            {ownsChannel ? (
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

      {confirmLeave && (() => {
        const g = confirmLeave;
        const isOwner = !!currentUser && String(g.owner_id) === String(currentUser.id);
        const ownsChannel = isOwner && g.is_personal_channel;
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
                <div key={g.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
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
