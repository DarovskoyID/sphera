import React, { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { Settings, Home, Plus, LogIn, X, Compass, Rss } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import type { Guild } from '../types';

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
  const initials = guild.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const iconUrl = guild.icon ? (guild.icon.startsWith('http') ? guild.icon : `${serverIP}${guild.icon}`) : null;
  const isChannel = guild.is_personal_channel;
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <button
        className={`server-icon ${active ? 'active' : ''}`}
        onClick={onClick}
        title={isChannel ? `${guild.name} (канал)` : guild.name}
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
          title="Личный канал"
          style={{
            position: 'absolute', bottom: -2, right: -2, width: 16, height: 16, borderRadius: '50%',
            background: 'var(--accent-primary)', border: '2px solid var(--bg-secondary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
          }}
        >
          <Rss size={8} color="#fff" />
        </span>
      )}
    </div>
  );
}

export const ServerSidebar: React.FC = () => {
  const { currentServer, setCurrentServer, isMobileSidebarOpen, guilds, currentGuild, selectGuild, currentServerIP } = useApp();
  const tr = useTranslation();
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [showJoinChannel, setShowJoinChannel] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);

  // Custom server order (drag to reorder) — persisted locally per device.
  const ORDER_KEY = 'serverOrder';
  const [order, setOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(ORDER_KEY) || '[]'); } catch { return []; }
  });
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const orderedGuilds = useMemo(() => {
    const pos = new Map(order.map((id, i) => [id, i]));
    return [...guilds]
      .map((g, i) => ({ g, i }))
      .sort((a, b) => {
        const pa = pos.has(String(a.g.id)) ? (pos.get(String(a.g.id)) as number) : Infinity;
        const pb = pos.has(String(b.g.id)) ? (pos.get(String(b.g.id)) as number) : Infinity;
        return pa === pb ? a.i - b.i : pa - pb; // stable: fall back to original order
      })
      .map(x => x.g);
  }, [guilds, order]);

  const dropOnGuild = (targetId: string) => {
    const src = dragId;
    setDragId(null);
    setOverId(null);
    if (!src || src === targetId) return;
    const ids = orderedGuilds.map(g => String(g.id));
    const from = ids.indexOf(src);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    setOrder(ids);
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
  };

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
            {orderedGuilds.map(guild => (
              <div
                key={guild.id}
                draggable
                onDragStart={e => { setDragId(String(guild.id)); e.dataTransfer.effectAllowed = 'move'; }}
                onDragOver={e => { e.preventDefault(); if (dragId && dragId !== String(guild.id)) setOverId(String(guild.id)); }}
                onDragLeave={() => setOverId(prev => prev === String(guild.id) ? null : prev)}
                onDrop={e => { e.preventDefault(); dropOnGuild(String(guild.id)); }}
                onDragEnd={() => { setDragId(null); setOverId(null); }}
                style={{
                  cursor: 'grab',
                  opacity: dragId === String(guild.id) ? 0.4 : 1,
                  borderTop: overId === String(guild.id) ? '2px solid var(--accent-primary)' : '2px solid transparent',
                  borderRadius: 4,
                }}
              >
                <GuildIcon
                  guild={guild}
                  active={currentServer === String(guild.id)}
                  onClick={() => selectGuild(guild)}
                  serverIP={currentServerIP}
                />
              </div>
            ))}

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

      {showCreate && <CreateGuildModal onClose={() => setShowCreate(false)} />}
      {showCreateChannel && <CreatePersonalChannelModal onClose={() => setShowCreateChannel(false)} />}
      {showJoin && <JoinGuildModal onClose={() => setShowJoin(false)} />}
      {showJoinChannel && <JoinGuildModal channel onClose={() => setShowJoinChannel(false)} />}
    </>
  );
};
