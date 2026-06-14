import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { Settings, Home, Plus, LogIn, X, Compass } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import type { Guild } from '../types';

function CreateGuildModal({ onClose }: { onClose: () => void }) {
  const { createGuild, selectGuild } = useApp();
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
          <span>Create a Server</span>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 0 0' }}>
          <input
            className="input-field"
            placeholder="Server name"
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={100}
            autoFocus
          />
          <input
            className="input-field"
            placeholder="Description (optional)"
            value={desc}
            onChange={e => setDesc(e.target.value)}
            maxLength={500}
          />
          <button className="btn-primary" type="submit" disabled={loading || !name.trim()}>
            {loading ? 'Creating…' : 'Create'}
          </button>
        </form>
      </div>
    </div>
  );
}

function JoinGuildModal({ onClose }: { onClose: () => void }) {
  const { joinGuild, selectGuild } = useApp();
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
          <span>Join a Server</span>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 0 0' }}>
          <input
            className="input-field"
            placeholder="Invite code"
            value={code}
            onChange={e => setCode(e.target.value)}
            autoFocus
          />
          <button className="btn-primary" type="submit" disabled={loading || !code.trim()}>
            {loading ? 'Joining…' : 'Join'}
          </button>
        </form>
      </div>
    </div>
  );
}

function GuildIcon({ guild, active, onClick, serverIP }: { guild: Guild; active: boolean; onClick: () => void; serverIP: string }) {
  const initials = guild.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const iconUrl = guild.icon ? (guild.icon.startsWith('http') ? guild.icon : `${serverIP}${guild.icon}`) : null;
  return (
    <button
      className={`server-icon ${active ? 'active' : ''}`}
      onClick={onClick}
      title={guild.name}
    >
      {iconUrl ? (
        <img src={iconUrl} alt={guild.name} style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} />
      ) : (
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.5 }}>{initials}</span>
      )}
    </button>
  );
}

export const ServerSidebar: React.FC = () => {
  const { currentServer, setCurrentServer, isMobileSidebarOpen, guilds, currentGuild, selectGuild, currentServerIP } = useApp();
  const tr = useTranslation();
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);

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
            {guilds.map(guild => (
              <GuildIcon
                key={guild.id}
                guild={guild}
                active={currentServer === String(guild.id)}
                onClick={() => selectGuild(guild)}
                serverIP={currentServerIP}
              />
            ))}

            <button
              ref={addBtnRef}
              className="server-icon server-icon-add"
              onClick={() => {
                const r = addBtnRef.current?.getBoundingClientRect();
                if (r) setMenuPos({ x: r.right + 8, y: r.top });
                setShowAddMenu(v => !v);
              }}
              title="Add a Server"
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
            <Plus size={14} /> Create Server
          </button>
          <button className="context-menu-item" onClick={() => { setShowAddMenu(false); setShowJoin(true); }}>
            <LogIn size={14} /> Join Server
          </button>
        </div>
      )}

      {showCreate && <CreateGuildModal onClose={() => setShowCreate(false)} />}
      {showJoin && <JoinGuildModal onClose={() => setShowJoin(false)} />}
    </>
  );
};
