import React, { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import {
  Sun, Moon, Search, Menu, UserPlus, Check, X, LogOut,
  Phone, Video, Ban, BellOff, Copy, Trash2, UserMinus, Volume2, PhoneOff,
} from 'lucide-react';
import { useApp, reportError } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import type { ServerUser } from '../types';

// ── Types ────────────────────────────────────────────────────────────────────

type FriendInfo = {
  id: string; username: string; nickname: string;
  avatar: string; bio: string; status: string;
};
type CtxState = { x: number; y: number; friend: FriendInfo } | null;

// ── Mute helpers ─────────────────────────────────────────────────────────────

const MUTE_OPTIONS = [
  { label: '15 minutes', ms: 15 * 60 * 1000 },
  { label: '1 hour',     ms: 60 * 60 * 1000 },
  { label: '1 day',      ms: 24 * 60 * 60 * 1000 },
  { label: '1 week',     ms: 7 * 24 * 60 * 60 * 1000 },
  { label: 'Until I turn it off', ms: -1 },
];

function getMuteExpiry(userId: string): number {
  const v = localStorage.getItem(`mute_${userId}`);
  return v ? parseInt(v) : 0;
}
function saveMute(userId: string, ms: number) {
  const expiry = ms === -1 ? Number.MAX_SAFE_INTEGER : Date.now() + ms;
  localStorage.setItem(`mute_${userId}`, String(expiry));
}
function clearMute(userId: string) {
  localStorage.removeItem(`mute_${userId}`);
}

// ── Status dot ───────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  online:  'var(--status-online)',
  idle:    'var(--status-idle)',
  dnd:     'var(--status-dnd)',
  offline: 'var(--status-offline)',
  blocked: '#f97316',
};

const StatusDot: React.FC<{ status: string; size?: number }> = ({ status, size = 10 }) => (
  <span style={{
    display: 'inline-block',
    width: size, height: size,
    borderRadius: '50%',
    background: STATUS_COLOR[status] ?? STATUS_COLOR.offline,
    border: '2px solid var(--bg-secondary)',
    flexShrink: 0,
  }} />
);

// ── User Avatar ───────────────────────────────────────────────────────────────

const Avatar: React.FC<{ name: string; avatar: string; size?: number }> = ({ name, avatar, size = 40 }) => (
  avatar
    ? <img src={avatar} alt={name} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover' }} />
    : <div style={{
        width: size, height: size, borderRadius: '50%',
        background: 'var(--accent-primary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#fff', fontWeight: 700, fontSize: size * 0.38, flexShrink: 0,
      }}>
        {name[0]?.toUpperCase() ?? '?'}
      </div>
);

// ── Full Profile Modal ────────────────────────────────────────────────────────

const ProfileModal: React.FC<{
  friend: FriendInfo;
  onClose: () => void;
  onCall: (withVideo: boolean) => void;
  onRemove: () => void;
}> = ({ friend, onClose, onCall, onRemove }) => {
  const { currentServerIP, authToken, friends } = useApp();
  const [mutualFriends, setMutualFriends] = useState<ServerUser[]>([]);
  const [note, setNote] = useState(() => localStorage.getItem(`note_${friend.id}`) ?? '');
  const displayName = friend.nickname || friend.username;

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          `${currentServerIP}/api/auth/users/${friend.id}/mutual-friends/`,
          { headers: { Authorization: `Bearer ${authToken}` } }
        );
        if (res.ok) setMutualFriends(await res.json());
      } catch { /* ignore */ }
    })();
  }, [friend.id, currentServerIP, authToken]);

  const isFriend = friends.some(f => String(f.id) === String(friend.id));

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9400,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg-secondary)',
          borderRadius: 16, overflow: 'hidden',
          width: 380, maxWidth: '94vw',
          maxHeight: '88vh', overflowY: 'auto',
          border: '1px solid var(--border-color)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Banner */}
        <div style={{
          height: 80,
          background: 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-active) 100%)',
          position: 'relative',
          flexShrink: 0,
        }}>
          <button
            onClick={onClose}
            style={{
              position: 'absolute', top: 10, right: 10,
              background: 'rgba(0,0,0,0.4)', border: 'none', borderRadius: 6,
              color: '#fff', cursor: 'pointer', padding: 4, display: 'flex',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Avatar overlapping banner */}
        <div style={{ padding: '0 20px 0', marginTop: -40 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 12 }}>
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <div style={{
                width: 80, height: 80, borderRadius: '50%',
                border: '4px solid var(--bg-secondary)',
                overflow: 'hidden',
              }}>
                <Avatar name={displayName} avatar={friend.avatar} size={80} />
              </div>
              <span style={{
                position: 'absolute', bottom: 4, right: 4,
                width: 16, height: 16, borderRadius: '50%',
                background: STATUS_COLOR[friend.status] ?? STATUS_COLOR.offline,
                border: '3px solid var(--bg-secondary)',
              }} />
            </div>
            <div style={{ paddingBottom: 4, minWidth: 0 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.2 }}>
                {displayName}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>@{friend.username}</div>
            </div>
          </div>

          {/* Bio */}
          {friend.bio && (
            <div style={{
              fontSize: 13, color: 'var(--text-secondary)',
              lineHeight: 1.5, marginBottom: 12,
              padding: '8px 12px',
              background: 'var(--bg-tertiary)',
              borderRadius: 8,
            }}>
              {friend.bio}
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button
              onClick={() => onCall(false)}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: 6, padding: '9px 0',
                background: 'var(--accent-primary)', border: 'none', borderRadius: 8,
                color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer',
              }}
            >
              <Phone size={15} /> Call
            </button>
            <button
              onClick={() => onCall(true)}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: 6, padding: '9px 0',
                background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)',
                borderRadius: 8, color: 'var(--text-primary)',
                fontWeight: 600, fontSize: 13, cursor: 'pointer',
              }}
            >
              <Video size={15} /> Video
            </button>
            {isFriend && (
              <button
                onClick={onRemove}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  gap: 6, padding: '9px 12px',
                  background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)',
                  borderRadius: 8, color: '#ef4444',
                  fontWeight: 600, fontSize: 13, cursor: 'pointer',
                }}
                title="Remove friend"
              >
                <UserMinus size={15} />
              </button>
            )}
          </div>

          {/* Note (visible only to me) */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: 0.5, marginBottom: 5, textTransform: 'uppercase' }}>
              Note (only visible to you)
            </div>
            <textarea
              value={note}
              onChange={e => {
                setNote(e.target.value);
                localStorage.setItem(`note_${friend.id}`, e.target.value);
              }}
              placeholder="Add a note about this person..."
              style={{
                width: '100%', padding: '8px 10px',
                background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)',
                borderRadius: 8, color: 'var(--text-primary)', fontSize: 13,
                fontFamily: 'inherit', resize: 'vertical', minHeight: 64,
                outline: 'none',
              }}
            />
          </div>

          {/* Mutual friends */}
          {mutualFriends.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: 0.5, marginBottom: 8, textTransform: 'uppercase' }}>
                {mutualFriends.length} Mutual Friend{mutualFriends.length !== 1 ? 's' : ''}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {mutualFriends.map(mf => (
                  <div key={mf.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Avatar name={mf.nickname || mf.username} avatar={mf.avatar} size={28} />
                    <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                      {mf.nickname || mf.username}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ── Friend Context Menu ───────────────────────────────────────────────────────

const FriendContextMenu: React.FC<{
  ctx: CtxState;
  onClose: () => void;
  onOpenProfile: (f: FriendInfo) => void;
}> = ({ ctx, onClose, onOpenProfile }) => {
  const {
    currentServerIP, authToken,
    setCurrentChat, setCallActive, setCallTargetId,
    chatConversationId, currentChat,
    blockUser, removeFriend,
  } = useApp();
  const [showMuteMenu, setShowMuteMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState({ x: ctx?.x ?? 0, y: ctx?.y ?? 0 });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !ctx) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight - 68;
    setAdjustedPos({
      x: Math.min(Math.max(ctx.x, 8), vw - width - 8),
      y: Math.min(Math.max(ctx.y, 8), vh - height),
    });
  }, [ctx?.x, ctx?.y]);

  if (!ctx) return null;
  const { friend } = ctx;

  const isActiveFriend = String(currentChat) === String(friend.id);

  // Returns the existing conversation id without creating a new one if absent
  const getConvoId = async (): Promise<number | null> => {
    if (isActiveFriend && chatConversationId) return chatConversationId;
    try {
      const res = await fetch(`${currentServerIP}/api/conversations/create/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ user_id: friend.id }),
      });
      if (!res.ok) return null;
      return (await res.json()).id as number;
    } catch { return null; }
  };

  const handleCopyChannelId = async () => {
    onClose();
    const id = await getConvoId();
    if (id != null) navigator.clipboard.writeText(String(id)).catch(() => {});
  };

  const handleDeleteDialog = async () => {
    onClose();
    const id = await getConvoId();
    if (id == null) return;
    try {
      const res = await fetch(`${currentServerIP}/api/conversations/${id}/delete/`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok && isActiveFriend) {
        // If this chat is open, navigate away — the WS event will also clear
        // state on the other side, but handle it locally too for the deleter
        setCurrentChat('');
      }
    } catch (e) { reportError(e); }
  };

  const handleBlock = async () => {
    onClose();
    try { await blockUser(friend.id); } catch (e) { reportError(e); }
  };

  const handleRemove = async () => {
    onClose();
    try { await removeFriend(friend.id); } catch (e) { reportError(e); }
  };

  const handleStartCall = () => {
    onClose();
    setCurrentChat(friend.id);
    setCallTargetId(friend.id);
    setCallActive(true);
  };

  const isMuted = getMuteExpiry(friend.id) > Date.now();

  const s: React.CSSProperties = {
    position: 'fixed', top: adjustedPos.y, left: adjustedPos.x,
    zIndex: 9100,
    background: 'var(--bg-primary)',
    border: '1px solid var(--border-color)',
    borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    minWidth: 210, padding: '4px 0',
  };

  const itemBase: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10,
    width: '100%', padding: '9px 14px', background: 'none',
    border: 'none', cursor: 'pointer', fontSize: 13,
    textAlign: 'left', color: 'var(--text-primary)',
  };
  const dangerStyle = { ...itemBase, color: '#ef4444' };
  const h = (e: React.MouseEvent<HTMLButtonElement>) => (e.currentTarget.style.background = 'var(--bg-secondary)');
  const l = (e: React.MouseEvent<HTMLButtonElement>) => (e.currentTarget.style.background = 'none');

  return (
    <div ref={ref} style={s}>
      {/* Header */}
      <div style={{ padding: '8px 14px 6px', borderBottom: '1px solid var(--border-color)', marginBottom: 2 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
          {friend.nickname || friend.username}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>@{friend.username}</div>
      </div>

      <button style={itemBase} onMouseEnter={h} onMouseLeave={l}
        onClick={() => { onOpenProfile(friend); onClose(); }}>
        <Search size={14} />Open profile
      </button>
      <button style={itemBase} onMouseEnter={h} onMouseLeave={l} onClick={handleStartCall}>
        <Phone size={14} />Start call
      </button>
      <button style={itemBase} onMouseEnter={h} onMouseLeave={l} onClick={handleCopyChannelId}>
        <Copy size={14} />Copy channel ID
      </button>

      {/* Mute submenu */}
      <div style={{ position: 'relative' }}
        onMouseEnter={() => setShowMuteMenu(true)}
        onMouseLeave={() => setShowMuteMenu(false)}>
        <button style={{ ...itemBase, justifyContent: 'space-between' }} onMouseEnter={h} onMouseLeave={l}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <BellOff size={14} />{isMuted ? 'Muted ✓' : 'Mute'}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>▶</span>
        </button>
        {showMuteMenu && (
          <div style={{
            position: 'absolute', left: '100%', top: 0,
            background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
            borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            minWidth: 175, padding: '4px 0', zIndex: 9200,
          }}>
            {isMuted && (
              <button style={dangerStyle} onMouseEnter={h} onMouseLeave={l}
                onClick={() => { clearMute(friend.id); onClose(); }}>
                Unmute
              </button>
            )}
            {MUTE_OPTIONS.map(opt => (
              <button key={opt.label} style={itemBase} onMouseEnter={h} onMouseLeave={l}
                onClick={() => { saveMute(friend.id, opt.ms); onClose(); }}>
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ height: 1, background: 'var(--border-color)', margin: '3px 0' }} />

      <button style={itemBase} onMouseEnter={h} onMouseLeave={l} onClick={handleRemove}>
        <UserMinus size={14} />Remove friend
      </button>
      <button style={dangerStyle} onMouseEnter={h} onMouseLeave={l} onClick={handleBlock}>
        <Ban size={14} />Block user
      </button>
      <button style={dangerStyle} onMouseEnter={h} onMouseLeave={l} onClick={handleDeleteDialog}>
        <Trash2 size={14} />Delete dialog
      </button>
    </div>
  );
};

// ── Blocked contact context menu ─────────────────────────────────────────────

type BlockedCtxState = { x: number; y: number; user: FriendInfo } | null;

const BlockedContextMenu: React.FC<{
  ctx: BlockedCtxState;
  onClose: () => void;
}> = ({ ctx, onClose }) => {
  const { currentServerIP, authToken, setCurrentChat, currentChat, chatConversationId, unblockUser, removeBlockedContact } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState({ x: ctx?.x ?? 0, y: ctx?.y ?? 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !ctx) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight - 68;
    setAdjustedPos({
      x: Math.min(Math.max(ctx.x, 8), vw - width - 8),
      y: Math.min(Math.max(ctx.y, 8), vh - height),
    });
  }, [ctx?.x, ctx?.y]);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);

  if (!ctx) return null;
  const { user } = ctx;
  const isActive = String(currentChat) === String(user.id);

  const getConvoId = async (): Promise<number | null> => {
    if (isActive && chatConversationId) return chatConversationId;
    try {
      const res = await fetch(`${currentServerIP}/api/conversations/create/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ user_id: user.id }),
      });
      if (!res.ok) return null;
      return (await res.json()).id as number;
    } catch { return null; }
  };

  const handleUnblock = async () => {
    onClose();
    try {
      await unblockUser(user.id);
      // Keep the current chat open — the user now appears as a friend
    } catch (e) { reportError(e); }
  };

  const handleDeleteDialog = async () => {
    onClose();
    removeBlockedContact(user.id);
    if (isActive) setCurrentChat('');
    const id = await getConvoId();
    if (id == null) return;
    try {
      await fetch(`${currentServerIP}/api/conversations/${id}/delete/`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` },
      });
    } catch (e) { reportError(e); }
  };

  const s: React.CSSProperties = {
    position: 'fixed', top: adjustedPos.y, left: adjustedPos.x, zIndex: 9100,
    background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
    borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    minWidth: 200, padding: '4px 0',
  };
  const item: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10,
    width: '100%', padding: '9px 14px', background: 'none',
    border: 'none', cursor: 'pointer', fontSize: 13, textAlign: 'left', color: 'var(--text-primary)',
  };
  const danger: React.CSSProperties = { ...item, color: '#ef4444' };
  const h = (e: React.MouseEvent<HTMLButtonElement>) => (e.currentTarget.style.background = 'var(--bg-secondary)');
  const l = (e: React.MouseEvent<HTMLButtonElement>) => (e.currentTarget.style.background = 'none');

  return (
    <div ref={ref} style={s}>
      <div style={{ padding: '8px 14px 6px', borderBottom: '1px solid var(--border-color)', marginBottom: 2 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{user.nickname || user.username}</div>
        <div style={{ fontSize: 11, color: '#f97316' }}>Blocked</div>
      </div>
      <button style={item} onMouseEnter={h} onMouseLeave={l} onClick={handleUnblock}>
        <Ban size={14} />Unblock
      </button>
      <button style={danger} onMouseEnter={h} onMouseLeave={l} onClick={handleDeleteDialog}>
        <Trash2 size={14} />Delete dialog
      </button>
    </div>
  );
};

// ── Main ChatSidebar ──────────────────────────────────────────────────────────

export const ChatSidebar: React.FC = () => {
  const {
    currentView, currentChat, currentSettingsPage,
    setCurrentChat, setCurrentSettingsPage, toggleTheme, theme,
    isMobileSidebarOpen, toggleMobileSidebar, setAuthToken,
    friends, blockedContacts, pendingRequests, sentRequests, sendFriendRequest, acceptFriendRequest,
    rejectFriendRequest, searchUsers,
    setCallActive, setCallTargetId, setVideoActive,
    removeFriend,
  } = useApp();
  const tr = useTranslation();

  const [searchQuery, setSearchQuery] = useState('');
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ServerUser[]>([]);
  const [addError, setAddError] = useState('');
  const [addSuccess, setAddSuccess] = useState('');
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<CtxState>(null);
  const [blockedCtxMenu, setBlockedCtxMenu] = useState<BlockedCtxState>(null);
  const [profileFriend, setProfileFriend] = useState<FriendInfo | null>(null);
  const filteredFriends = friends.filter(f =>
    (f.nickname || f.username).toLowerCase().includes(searchQuery.toLowerCase())
  );
  const filteredBlocked = blockedContacts.filter(u =>
    (u.nickname || u.username).toLowerCase().includes(searchQuery.toLowerCase())
  );

  const sidebarTitle = currentView === 'settings'
    ? tr('nav_settings') : tr('nav_direct_messages');

  const handleSearch = async () => {
    if (!addQuery.trim()) return;
    setAddError(''); setAddSuccess('');
    try {
      const results = await searchUsers(addQuery);
      setSearchResults(results);
      if (results.length === 0) setAddError(tr('friends_no_users'));
    } catch {
      setAddError(tr('friends_search_failed'));
    }
  };

  const handleSendRequest = async (userId: string) => {
    setAddError(''); setAddSuccess('');
    const user = searchResults.find(u => String(u.id) === String(userId));
    try {
      await sendFriendRequest(userId, user);
      setAddSuccess(tr('friends_request_sent'));
      setSearchResults([]); setAddQuery('');
    } catch (e: any) {
      setAddError(e.message || 'Error sending request');
    }
  };

  const handleAccept = async (id: string) => {
    try { await acceptFriendRequest(id); } catch (e) { reportError(e); }
  };

  const handleReject = async (id: string) => {
    try { await rejectFriendRequest(id); } catch (e) { reportError(e); }
  };

  const handleFriendContextMenu = useCallback((e: React.MouseEvent, friend: FriendInfo) => {
    e.preventDefault();
    const x = e.clientX;
    const y = e.clientY;
    setCtxMenu({ x, y, friend });
  }, []);

  const handleBlockedContextMenu = useCallback((e: React.MouseEvent, user: FriendInfo) => {
    e.preventDefault();
    setBlockedCtxMenu({ x: e.clientX, y: e.clientY, user });
  }, []);

  const handleProfileCall = (withVideo: boolean) => {
    if (!profileFriend) return;
    setProfileFriend(null);
    setCurrentChat(profileFriend.id);
    setCallTargetId(profileFriend.id);
    setCallActive(true);
    if (withVideo) setVideoActive(true);
  };

  const handleProfileRemove = async () => {
    if (!profileFriend) return;
    try { await removeFriend(profileFriend.id); } catch (e) { reportError(e); }
    setProfileFriend(null);
  };

  return (
    <aside className={`chat-sidebar ${isMobileSidebarOpen ? 'mobile-open' : ''}`}>
      <div className="chat-sidebar-header">
        <button className="icon-btn glass-btn mobile-hamburger-btn" onClick={toggleMobileSidebar} title={tr('nav_menu')}>
          <Menu size={20} />
        </button>
        <h2>{sidebarTitle}</h2>
        <button className="icon-btn glass-btn" onClick={toggleTheme} title={tr('nav_toggle_theme')}>
          {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
        </button>
      </div>

      {currentView === 'home' && (
        <div className="chat-list">
          {/* Friend search */}
          <div className="search-bar glass-panel">
            <Search size={18} className="search-icon" />
            <input
              type="text"
              placeholder={tr('friends_search')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Sent requests */}
          {sentRequests.length > 0 && (
            <>
              <div className="section-title">{tr('friends_requests_sent') || 'Sent requests'} ({sentRequests.length})</div>
              {sentRequests.map(user => (
                <div key={user.id} className="chat-item" style={{ gap: 8 }}>
                  <div className="chat-avatar">
                    <Avatar name={user.nickname || user.username} avatar={user.avatar} size={36} />
                  </div>
                  <div className="chat-info" style={{ flex: 1 }}>
                    <div className="chat-name">{user.nickname || user.username}</div>
                    <div className="chat-message">{tr('friends_request_pending') || 'Request sent'}</div>
                  </div>
                </div>
              ))}
            </>
          )}

          {/* Pending requests */}
          {pendingRequests.length > 0 && (
            <>
              <div className="section-title">
                {tr('friends_requests')} ({pendingRequests.length})
              </div>
              {pendingRequests.map(req => (
                <div key={req.id} className="chat-item" style={{ gap: 8 }}>
                  <div className="chat-avatar" style={{ position: 'relative' }}>
                    <Avatar
                      name={req.from_user.nickname || req.from_user.username}
                      avatar={req.from_user.avatar}
                      size={36}
                    />
                    <span style={{
                      position: 'absolute', bottom: -1, right: -1,
                      width: 10, height: 10, borderRadius: '50%',
                      background: STATUS_COLOR[req.from_user.status] ?? STATUS_COLOR.offline,
                      border: '2px solid var(--bg-secondary)',
                    }} />
                  </div>
                  <div className="chat-info" style={{ flex: 1 }}>
                    <div className="chat-name">{req.from_user.nickname || req.from_user.username}</div>
                    <div className="chat-message">{tr('friends_wants_to_be')}</div>
                  </div>
                  <button className="icon-btn glass-btn" style={{ color: '#22c55e', padding: 4 }}
                    onClick={() => handleAccept(req.id)} title={tr('friends_accept')}>
                    <Check size={16} />
                  </button>
                  <button className="icon-btn glass-btn" style={{ color: '#ef4444', padding: 4 }}
                    onClick={() => handleReject(req.id)} title={tr('friends_decline')}>
                    <X size={16} />
                  </button>
                </div>
              ))}
            </>
          )}

          <div className="section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{tr('friends_direct_messages')}</span>
            <button
              className="icon-btn glass-btn" style={{ padding: 2 }}
              onClick={() => { setShowAddFriend(v => !v); setAddError(''); setAddSuccess(''); setSearchResults([]); setAddQuery(''); }}
              title={tr('friends_add')}
            >
              <UserPlus size={16} />
            </button>
          </div>

          {showAddFriend && (
            <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  className="field-input"
                  type="text"
                  placeholder={tr('friends_search_placeholder')}
                  value={addQuery}
                  onChange={e => setAddQuery(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSearch()}
                />
                <button className="glass-btn" style={{ padding: '6px 10px', fontSize: 12, borderRadius: 8, whiteSpace: 'nowrap' }}
                  onClick={handleSearch}>{tr('friends_find')}</button>
              </div>
              {addError && <div style={{ color: '#ef4444', fontSize: 12 }}>{addError}</div>}
              {addSuccess && <div style={{ color: '#22c55e', fontSize: 12 }}>{addSuccess}</div>}
              {searchResults.map(u => (
                <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Avatar name={u.nickname || u.username} avatar={u.avatar} size={28} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>
                      {u.nickname || u.username}
                    </div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>@{u.username}</div>
                  </div>
                  <button className="glass-btn" style={{ padding: '4px 8px', fontSize: 11, borderRadius: 6 }}
                    onClick={() => handleSendRequest(u.id)}>Add</button>
                </div>
              ))}
            </div>
          )}

          {/* Unified list: friends + blocked contacts */}
          {filteredFriends.map(friend => (
            <div
              key={friend.id}
              className={`chat-item ${String(currentChat) === String(friend.id) ? 'active' : ''}`}
              onClick={() => setCurrentChat(friend.id)}
              onContextMenu={e => handleFriendContextMenu(e, friend as FriendInfo)}
            >
              <div className="chat-avatar" style={{ position: 'relative' }}>
                <Avatar name={friend.nickname || friend.username} avatar={friend.avatar} size={36} />
                <span style={{
                  position: 'absolute', bottom: -1, right: -1,
                  width: 11, height: 11, borderRadius: '50%',
                  background: STATUS_COLOR[friend.status] ?? STATUS_COLOR.offline,
                  border: '2px solid var(--bg-secondary)',
                }} />
              </div>
              <div className="chat-info">
                <div className="chat-name">{friend.nickname || friend.username}</div>
                <div className="chat-message" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <StatusDot status={friend.status} size={7} />
                  <span style={{ textTransform: 'capitalize' }}>{friend.status ?? 'offline'}</span>
                </div>
              </div>
            </div>
          ))}

          {filteredFriends.length === 0 && filteredBlocked.length === 0 && !showAddFriend && pendingRequests.length === 0 && (
            <div style={{ padding: '16px 12px', color: 'var(--text-secondary)', fontSize: 13, textAlign: 'center' }}>
              {tr('friends_none')} <UserPlus size={12} style={{ display: 'inline' }} />
            </div>
          )}

          {/* Blocked contacts — kept visible so the user can still read the history */}
          {filteredBlocked.length > 0 && (
            <>
              <div style={{ padding: '8px 12px 2px', fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Ban size={10} /> Blocked
              </div>
              {filteredBlocked.map(user => (
                <div
                  key={user.id}
                  className={`chat-item ${String(currentChat) === String(user.id) ? 'active' : ''}`}
                  onClick={() => setCurrentChat(user.id)}
                  onContextMenu={e => handleBlockedContextMenu(e, user as FriendInfo)}
                >
                  <div className="chat-avatar" style={{ position: 'relative' }}>
                    <Avatar name={user.nickname || user.username} avatar={user.avatar} size={36} />
                  </div>
                  <div className="chat-info">
                    <div className="chat-name">{user.nickname || user.username}</div>
                    <div className="chat-message" style={{ fontSize: 11, color: '#f97316' }}>Blocked</div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {currentView === 'server' && (
        <div className="channel-list">
          <div style={{ padding: 16, color: 'var(--text-secondary)', textAlign: 'center' }}>
            {tr('server_channels_soon')}
          </div>
        </div>
      )}

      {currentView === 'settings' && (
        <div className="settings-list">
          <div className={`settings-item ${currentSettingsPage === 'profile' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('profile')}>{tr('settings_my_account')}</div>
          <div className={`settings-item ${currentSettingsPage === 'content' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('content')}>{tr('settings_privacy')}</div>
          <div className={`settings-item ${currentSettingsPage === 'data' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('data')}>{tr('settings_data')}</div>
          <div className={`settings-item ${currentSettingsPage === 'devices' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('devices')}>{tr('settings_devices')}</div>
          <div className={`settings-item ${currentSettingsPage === 'family' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('family')}>{tr('settings_family')}</div>
          <div className={`settings-item ${currentSettingsPage === 'integration' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('integration')}>{tr('settings_integration')}</div>
          <div className={`settings-item ${currentSettingsPage === 'notifications' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('notifications')}>{tr('settings_notifications')}</div>
          <div className={`settings-item ${currentSettingsPage === 'apps' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('apps')}>{tr('settings_apps')}</div>
          <div className="settings-devider" />
          <div className={`settings-item ${currentSettingsPage === 'nitro' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('nitro')}>{tr('settings_nitro')}</div>
          <div className={`settings-item ${currentSettingsPage === 'subscribes' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('subscribes')}>{tr('settings_subscribes')}</div>
          <div className={`settings-item ${currentSettingsPage === 'gifts' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('gifts')}>{tr('settings_gifts')}</div>
          <div className={`settings-item ${currentSettingsPage === 'payments' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('payments')}>{tr('settings_payments')}</div>
          <div className="settings-devider" />
          <div className={`settings-item ${currentSettingsPage === 'view' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('view')}>{tr('settings_appearance')}</div>
          <div className={`settings-item ${currentSettingsPage === 'special' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('special')}>{tr('settings_special')}</div>
          <div className={`settings-item ${currentSettingsPage === 'voiceAndVideo' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('voiceAndVideo')}>{tr('settings_voice_video')}</div>
          <div className={`settings-item ${currentSettingsPage === 'chat' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('chat')}>{tr('settings_chat')}</div>
          <div className={`settings-item ${currentSettingsPage === 'binds' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('binds')}>{tr('settings_binds')}</div>
          <div className={`settings-item ${currentSettingsPage === 'language' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('language')}>{tr('settings_language')}</div>
          <div className={`settings-item ${currentSettingsPage === 'exportImport' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('exportImport')}>{tr('settings_export_import')}</div>
          <div className={`settings-item ${currentSettingsPage === 'streamer' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('streamer')}>{tr('settings_streamer')}</div>
          <div className={`settings-item ${currentSettingsPage === 'more' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('more')}>{tr('settings_more')}</div>
          <div className="settings-devider" />
          <div className={`settings-item ${currentSettingsPage === 'privacyOfActivity' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('privacyOfActivity')}>{tr('settings_activity_privacy')}</div>
          <div className={`settings-item ${currentSettingsPage === 'games' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('games')}>{tr('settings_games')}</div>
          <div className="settings-devider" />
          <div className="settings-item" style={{ color: '#ef4444' }} onClick={() => setShowLogoutModal(true)}>
            <LogOut size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
            {tr('settings_exit')}
          </div>
        </div>
      )}

      {/* Logout modal */}
      {showLogoutModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000 }}>
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 12, padding: 24, maxWidth: 380, width: '90%', border: '1px solid var(--border-color)' }}>
            <h3 style={{ margin: '0 0 8px', color: 'var(--text-primary)', fontSize: 18, fontWeight: 700 }}>{tr('logout_title')}</h3>
            <p style={{ margin: '0 0 20px', color: 'var(--text-secondary)', fontSize: 14 }}>{tr('logout_confirm')}</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowLogoutModal(false)} style={{ padding: '8px 20px', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 14, cursor: 'pointer' }}>
                {tr('cancel')}
              </button>
              <button onClick={() => { setShowLogoutModal(false); setAuthToken(''); }} style={{ padding: '8px 20px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                {tr('logout_button')}
              </button>
            </div>
          </div>
        </div>
      )}

      <UserProfile />

      {ctxMenu && (
        <FriendContextMenu
          ctx={ctxMenu}
          onClose={() => setCtxMenu(null)}
          onOpenProfile={f => setProfileFriend(f)}
        />
      )}

      {blockedCtxMenu && (
        <BlockedContextMenu
          ctx={blockedCtxMenu}
          onClose={() => setBlockedCtxMenu(null)}
        />
      )}

      {profileFriend && (
        <ProfileModal
          friend={profileFriend}
          onClose={() => setProfileFriend(null)}
          onCall={handleProfileCall}
          onRemove={handleProfileRemove}
        />
      )}
    </aside>
  );
};

// ── User Profile Footer ───────────────────────────────────────────────────────

export const UserProfile: React.FC = () => {
  const { currentUser, currentVoiceChannel, leaveVoiceChannel, setVoiceMuted, voiceLocalStream } = useApp();
  const tr = useTranslation();
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const displayName = currentUser?.nickname || currentUser?.username || 'You';

  const inVoice = !!currentVoiceChannel;

  const handleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    if (inVoice) {
      setVoiceMuted(next);
      voiceLocalStream.current?.getAudioTracks().forEach(t => { t.enabled = !next; });
    }
  };

  const handleDeafen = () => {
    const next = !isDeafened;
    setIsDeafened(next);
    // Deafen mutes all remote audio via the ref exposed from GuildVoiceRoom
    if (inVoice) {
      voiceLocalStream.current?.getAudioTracks().forEach(t => { t.enabled = !next && !isMuted; });
    }
  };

  return (
    <>
    {currentVoiceChannel && (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', flexShrink: 0,
        background: 'rgba(59,165,92,0.12)',
        borderTop: '1px solid rgba(59,165,92,0.25)',
        borderBottom: '1px solid rgba(59,165,92,0.25)',
      }}>
        <Volume2 size={13} style={{ color: '#3ba55c', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10, color: '#3ba55c', fontWeight: 600, lineHeight: 1 }}>Voice Connected</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentVoiceChannel.name}</div>
        </div>
        <button onClick={leaveVoiceChannel} title="Disconnect" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ed4245', padding: 4, borderRadius: 4, display: 'flex', alignItems: 'center' }}>
          <PhoneOff size={14} />
        </button>
      </div>
    )}
    <div className="user-profile-section glass-panel">
      <button className="profile-avatar-btn">
        {currentUser?.avatar
          ? <img src={currentUser.avatar} alt={displayName} />
          : <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 14 }}>
              {displayName[0].toUpperCase()}
            </div>
        }
        <span className={`status-indicator ${currentUser?.status ?? 'online'}`} />
      </button>
      <div className="profile-info">
        <div className="profile-name">{displayName}</div>
        <div className="profile-status" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <StatusDot status={currentUser?.status ?? 'online'} size={7} />
          <span style={{ textTransform: 'capitalize' }}>{currentUser?.status ?? 'online'}</span>
        </div>
      </div>
      <div className="profile-controls">
        <button
          className={`profile-icon-btn glass-btn ${isMuted ? 'muted' : ''}`}
          onClick={handleMute}
          title={tr('profile_mute')}
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/>
          </svg>
        </button>
        <button
          className={`profile-icon-btn glass-btn ${isDeafened ? 'muted' : ''}`}
          onClick={handleDeafen}
          title={tr('profile_deafen')}
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M9 19V6m0 0a3 3 0 013-3h0a3 3 0 013 3m0 0a3 3 0 013-3h0a3 3 0 013 3m0 0v13m0 0H9"/>
          </svg>
        </button>
      </div>
    </div>
    </>
  );
};
