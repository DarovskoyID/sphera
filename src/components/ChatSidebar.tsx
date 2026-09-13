import React, { useState, useEffect, useCallback } from 'react';
import { useSlot } from '../sdk/slots';
import { SlotList } from '../core/modules/Slots';
import {
  Sun, Moon, Search, Menu, UserPlus, Check, X, LogOut,
  Phone, Ban, BellOff, Copy, Trash2, UserMinus, ChevronUp,
} from 'lucide-react';
import { useApp, reportError } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import ConfirmModal from './ConfirmModal';
import type { ServerUser } from '../types';
import { AccountBadge, SuperuserBadge, accountDisplayName } from './BotBadge';
import { useAnchoredMenu } from './useAnchoredMenu';
import { ListSkeleton } from './Skeleton';
import { ProfileModal as SharedProfileModal } from './ProfileModal';

// ── Mobile detection ─────────────────────────────────────────────────────────

function useIsMobile() {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = () => setMobile(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return mobile;
}

// ── Types ────────────────────────────────────────────────────────────────────

type FriendInfo = {
  id: string; username: string; nickname: string;
  avatar: string; bio: string; status: string;
};
type CtxState = { x: number; y: number; friend: FriendInfo } | null;

// ── Mute helpers ─────────────────────────────────────────────────────────────

const MUTE_OPTIONS = [
  { key: 'mute_15min' as const, ms: 15 * 60 * 1000 },
  { key: 'mute_1hour' as const, ms: 60 * 60 * 1000 },
  { key: 'mute_1day' as const,  ms: 24 * 60 * 60 * 1000 },
  { key: 'mute_1week' as const, ms: 7 * 24 * 60 * 60 * 1000 },
  { key: 'mute_forever' as const, ms: -1 },
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
    blockUser, removeFriend, currentUser,
  } = useApp();
  const [showMuteMenu, setShowMuteMenu] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [showBlockConfirm, setShowBlockConfirm] = useState(false);
  const [showDeleteDialogConfirm, setShowDeleteDialogConfirm] = useState(false);
  const [deleteLoginInput, setDeleteLoginInput] = useState('');
  const tr = useTranslation();
  const { ref, style: position, portal } = useAnchoredMenu(ctx, onClose);

  if (!ctx) return null;
  const { friend } = ctx;

  const isActiveFriend = String(currentChat) === String(friend.id);

  // Returns the existing conversation id without creating a new one if absent
  const getConvoId = async (): Promise<string | null> => {
    if (isActiveFriend && chatConversationId) return chatConversationId;
    try {
      const res = await fetch(`${currentServerIP}/api/conversations/create/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ user_id: friend.id }),
      });
      if (!res.ok) return null;
      return (await res.json()).id as string;
    } catch { return null; }
  };

  const handleCopyChannelId = async () => {
    onClose();
    const id = await getConvoId();
    if (id != null) navigator.clipboard.writeText(String(id)).catch(() => {});
  };

  const handleDeleteDialog = () => {
    setDeleteLoginInput('');
    setShowDeleteDialogConfirm(true);
  };

  const confirmDeleteDialog = async () => {
    setShowDeleteDialogConfirm(false);
    onClose();
    const id = await getConvoId();
    if (id == null) return;
    try {
      const res = await fetch(`${currentServerIP}/api/conversations/${id}/delete/`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok && isActiveFriend) {
        setCurrentChat('');
      }
    } catch (e) { reportError(e); }
  };

  const handleBlock = () => {
    setShowBlockConfirm(true);
  };

  const confirmBlock = async () => {
    setShowBlockConfirm(false);
    onClose();
    try { await blockUser(friend.id); } catch (e) { reportError(e); }
  };

  const handleRemove = () => {
    setShowRemoveConfirm(true);
  };

  const confirmRemove = async () => {
    setShowRemoveConfirm(false);
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
    ...position,
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

  return portal(
    <div ref={ref} style={s}>
      {/* Header */}
      <div style={{ padding: '8px 14px 6px', borderBottom: '1px solid var(--border-color)', marginBottom: 2 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
          {accountDisplayName(friend)}<AccountBadge account={friend} />
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>@{friend.username}</div>
      </div>

      <button style={itemBase} onMouseEnter={h} onMouseLeave={l}
        onClick={() => { onOpenProfile(friend); onClose(); }}>
        <Search size={14} />{tr('ctx_open_profile')}
      </button>
      <button style={itemBase} onMouseEnter={h} onMouseLeave={l} onClick={handleStartCall}>
        <Phone size={14} />{tr('ctx_start_call')}
      </button>
      <button style={itemBase} onMouseEnter={h} onMouseLeave={l} onClick={handleCopyChannelId}>
        <Copy size={14} />{tr('ctx_copy_channel_id')}
      </button>

      {/* Mute submenu */}
      <div style={{ position: 'relative' }}
        onMouseEnter={() => setShowMuteMenu(true)}
        onMouseLeave={() => setShowMuteMenu(false)}>
        <button style={{ ...itemBase, justifyContent: 'space-between' }} onMouseEnter={h} onMouseLeave={l}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <BellOff size={14} />{isMuted ? tr('ctx_muted') : tr('ctx_mute')}
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
                {tr('ctx_unmute')}
              </button>
            )}
            {MUTE_OPTIONS.map(opt => (
              <button key={opt.key} style={itemBase} onMouseEnter={h} onMouseLeave={l}
                onClick={() => { saveMute(friend.id, opt.ms); onClose(); }}>
                {tr(opt.key)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ height: 1, background: 'var(--border-color)', margin: '3px 0' }} />

      <button style={itemBase} onMouseEnter={h} onMouseLeave={l} onClick={handleRemove}>
        <UserMinus size={14} />{tr('ctx_remove_friend')}
      </button>
      <button style={dangerStyle} onMouseEnter={h} onMouseLeave={l} onClick={handleBlock}>
        <Ban size={14} />{tr('ctx_block_user')}
      </button>
      <button style={dangerStyle} onMouseEnter={h} onMouseLeave={l} onClick={handleDeleteDialog}>
        <Trash2 size={14} />{tr('ctx_delete_dialog')}
      </button>

      {showRemoveConfirm && (
        <ConfirmModal
          title={tr('remove_friend_title')}
          message={tr('remove_friend_confirm')}
          confirmLabel={tr('remove_friend_button')}
          cancelLabel={tr('cancel')}
          onConfirm={confirmRemove}
          onCancel={() => setShowRemoveConfirm(false)}
        />
      )}

      {showBlockConfirm && (
        <ConfirmModal
          title={tr('block_user_title')}
          message={tr('block_user_confirm')}
          confirmLabel={tr('block_user_button')}
          cancelLabel={tr('cancel')}
          onConfirm={confirmBlock}
          onCancel={() => setShowBlockConfirm(false)}
        />
      )}

      {showDeleteDialogConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000 }}>
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 12, padding: 24, maxWidth: 420, width: '90%', border: '1px solid var(--border-color)' }}>
            <h3 style={{ margin: '0 0 12px', color: 'var(--text-primary)', fontSize: 18, fontWeight: 700 }}>{tr('delete_dialog_title')}</h3>
            <div style={{
              background: 'rgba(239, 68, 68, 0.15)', border: '2px solid #ef4444', borderRadius: 8,
              padding: '12px 14px', marginBottom: 16, textAlign: 'center',
            }}>
              <span style={{ color: '#ef4444', fontSize: 15, fontWeight: 800, letterSpacing: 0.3, lineHeight: 1.4 }}>
                ⚠ {tr('delete_dialog_warning')}
              </span>
            </div>
            <p style={{ margin: '0 0 8px', color: 'var(--text-secondary)', fontSize: 14 }}>{tr('delete_dialog_confirm')}</p>
            <input
              type="text"
              value={deleteLoginInput}
              onChange={e => setDeleteLoginInput(e.target.value)}
              placeholder={currentUser?.username ?? ''}
              autoFocus
              style={{
                width: '100%', padding: '8px 12px', fontSize: 14, borderRadius: 8,
                border: '1px solid var(--border-color)', background: 'var(--bg-tertiary)',
                color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box', marginBottom: 16,
              }}
            />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowDeleteDialogConfirm(false)} style={{ padding: '8px 20px', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 14, cursor: 'pointer' }}>
                {tr('cancel')}
              </button>
              <button
                onClick={confirmDeleteDialog}
                disabled={deleteLoginInput !== currentUser?.username}
                style={{
                  padding: '8px 20px', background: deleteLoginInput === currentUser?.username ? '#ef4444' : '#555',
                  color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600,
                  cursor: deleteLoginInput === currentUser?.username ? 'pointer' : 'not-allowed', opacity: deleteLoginInput === currentUser?.username ? 1 : 0.5,
                }}
              >
                {tr('delete_dialog_button')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Blocked contact context menu ─────────────────────────────────────────────

type BlockedCtxState = { x: number; y: number; user: FriendInfo } | null;

const BlockedContextMenu: React.FC<{
  ctx: BlockedCtxState;
  onClose: () => void;
}> = ({ ctx, onClose }) => {
  const { currentServerIP, authToken, setCurrentChat, currentChat, chatConversationId, unblockUser, removeBlockedContact, currentUser } = useApp();
  const [showDeleteDialogConfirm, setShowDeleteDialogConfirm] = useState(false);
  const [deleteLoginInput, setDeleteLoginInput] = useState('');
  const tr = useTranslation();
  const { ref, style: position, portal } = useAnchoredMenu(ctx, onClose);

  if (!ctx) return null;
  const { user } = ctx;
  const isActive = String(currentChat) === String(user.id);

  const getConvoId = async (): Promise<string | null> => {
    if (isActive && chatConversationId) return chatConversationId;
    try {
      const res = await fetch(`${currentServerIP}/api/conversations/create/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ user_id: user.id }),
      });
      if (!res.ok) return null;
      return (await res.json()).id as string;
    } catch { return null; }
  };

  const handleUnblock = async () => {
    onClose();
    try {
      await unblockUser(user.id);
      // Keep the current chat open — the user now appears as a friend
    } catch (e) { reportError(e); }
  };

  const handleDeleteDialog = () => {
    setDeleteLoginInput('');
    setShowDeleteDialogConfirm(true);
  };

  const confirmDeleteDialog = async () => {
    setShowDeleteDialogConfirm(false);
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
    ...position, zIndex: 9100,
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

  return portal(
    <div ref={ref} style={s}>
      <div style={{ padding: '8px 14px 6px', borderBottom: '1px solid var(--border-color)', marginBottom: 2 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{user.nickname || user.username}</div>
        <div style={{ fontSize: 11, color: '#f97316' }}>{tr('status_blocked')}</div>
      </div>
      <button style={item} onMouseEnter={h} onMouseLeave={l} onClick={handleUnblock}>
        <Ban size={14} />{tr('ctx_unblock')}
      </button>
      <button style={danger} onMouseEnter={h} onMouseLeave={l} onClick={handleDeleteDialog}>
        <Trash2 size={14} />{tr('ctx_delete_dialog')}
      </button>

      {showDeleteDialogConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000 }}>
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 12, padding: 24, maxWidth: 420, width: '90%', border: '1px solid var(--border-color)' }}>
            <h3 style={{ margin: '0 0 12px', color: 'var(--text-primary)', fontSize: 18, fontWeight: 700 }}>{tr('delete_dialog_title')}</h3>
            <div style={{
              background: 'rgba(239, 68, 68, 0.15)', border: '2px solid #ef4444', borderRadius: 8,
              padding: '12px 14px', marginBottom: 16, textAlign: 'center',
            }}>
              <span style={{ color: '#ef4444', fontSize: 15, fontWeight: 800, letterSpacing: 0.3, lineHeight: 1.4 }}>
                ⚠ {tr('delete_dialog_warning')}
              </span>
            </div>
            <p style={{ margin: '0 0 8px', color: 'var(--text-secondary)', fontSize: 14 }}>{tr('delete_dialog_confirm')}</p>
            <input
              type="text"
              value={deleteLoginInput}
              onChange={e => setDeleteLoginInput(e.target.value)}
              placeholder={currentUser?.username ?? ''}
              autoFocus
              style={{
                width: '100%', padding: '8px 12px', fontSize: 14, borderRadius: 8,
                border: '1px solid var(--border-color)', background: 'var(--bg-tertiary)',
                color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box', marginBottom: 16,
              }}
            />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowDeleteDialogConfirm(false)} style={{ padding: '8px 20px', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 14, cursor: 'pointer' }}>
                {tr('cancel')}
              </button>
              <button
                onClick={confirmDeleteDialog}
                disabled={deleteLoginInput !== currentUser?.username}
                style={{
                  padding: '8px 20px', background: deleteLoginInput === currentUser?.username ? '#ef4444' : '#555',
                  color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600,
                  cursor: deleteLoginInput === currentUser?.username ? 'pointer' : 'not-allowed', opacity: deleteLoginInput === currentUser?.username ? 1 : 0.5,
                }}
              >
                {tr('delete_dialog_button')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Main ChatSidebar ──────────────────────────────────────────────────────────

export const ChatSidebar: React.FC = () => {
  const modulePages = useSlot('settings.page');
  const {
    currentView, currentChat, currentSettingsPage,
    setCurrentChat, setCurrentSettingsPage, toggleTheme, theme,
    isMobileSidebarOpen, toggleMobileSidebar, setAuthToken,
    friends, friendsLoaded, blockedContacts, pendingRequests, sentRequests, sendFriendRequest, acceptFriendRequest,
    rejectFriendRequest, searchUsers,
    setCallActive, setCallTargetId, setVideoActive, currentUser, language,
  } = useApp();
  const tr = useTranslation();
  const isMobile = useIsMobile();
  const isChild = !!currentUser?.is_child;
  // Matches the avatar column in chat-sidebar.css, which widens for thumbs.
  const avatarSize = isMobile ? 44 : 36;

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ServerUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [addError, setAddError] = useState('');
  const [justAsked, setJustAsked] = useState<string[]>([]);
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<CtxState>(null);
  const [blockedCtxMenu, setBlockedCtxMenu] = useState<BlockedCtxState>(null);
  const [profileFriend, setProfileFriend] = useState<FriendInfo | null>(null);

  const query = searchQuery.trim();
  const filteredFriends = friends.filter(f =>
    (f.nickname || f.username).toLowerCase().includes(query.toLowerCase())
  );
  const filteredBlocked = blockedContacts.filter(u =>
    (u.nickname || u.username).toLowerCase().includes(query.toLowerCase())
  );

  const sidebarTitle = currentView === 'settings'
    ? tr('nav_settings') : tr('nav_direct_messages');

  // One search box, two jobs. The list above filters as you type; below it,
  // anyone on the server who is not already a contact is offered — so looking
  // for someone you have not added yet is the same gesture as finding someone
  // you have. Two letters is where a name search starts to mean anything.
  useEffect(() => {
    if (currentView !== 'home') return;
    if (query.length < 2) {
      setSearchResults([]);
      setAddError('');
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      setAddError('');
      try {
        setSearchResults(await searchUsers(query));
      } catch {
        setSearchResults([]);
        setAddError(tr('friends_search_failed'));
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, currentView]);

  // Anyone already known — a friend, a blocked contact, or you — is in the
  // list above and has no business appearing again as a stranger to add.
  const known = new Set<string>([
    String(currentUser?.id ?? ''),
    ...friends.map(f => String(f.id)),
    ...blockedContacts.map(u => String(u.id)),
  ]);
  const strangers = searchResults.filter(u => !known.has(String(u.id)));
  const askedIds = new Set<string>([
    ...sentRequests.map(u => String(u.id)),
    ...justAsked,
  ]);

  const handleSendRequest = async (user: ServerUser) => {
    setAddError('');
    // Marked as asked straight away: the row answers the tap, and the server
    // list catches up on its own.
    setJustAsked(prev => [...prev, String(user.id)]);
    try {
      await sendFriendRequest(String(user.id), user);
    } catch (e: any) {
      setJustAsked(prev => prev.filter(id => id !== String(user.id)));
      setAddError(e.message || tr('friends_search_failed'));
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
    // Prevent camera from turning on when starting a voice call (state can persist from a previous call)
    setVideoActive(withVideo);
    setCallTargetId(profileFriend.id);
    setCallActive(true);
  };

  return (
    <aside className={`chat-sidebar ${isMobileSidebarOpen ? 'mobile-open' : ''}`} data-tour="dm-sidebar">
      <div className="chat-sidebar-header">
        {/* No `glass-btn` here: the header reads better with the buttons bare
            until they are pointed at. */}
        <button className="icon-btn mobile-hamburger-btn" onClick={toggleMobileSidebar} title={tr('nav_menu')}>
          <Menu size={20} />
        </button>
        <h2>{sidebarTitle}</h2>
        <button className="icon-btn" onClick={toggleTheme} title={tr('nav_toggle_theme')}>
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>

      {currentView === 'home' && (
        <>
          {/* One field for everyone — the people you have, and the people you
              have not added yet. */}
          <div className="sidebar-search">
            <Search className="search-icon" />
            <input
              type="text"
              placeholder={tr('friends_search_any')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                className="sidebar-search-clear"
                onClick={() => setSearchQuery('')}
                title={tr('cancel')}
              >
                <X size={12} />
              </button>
            )}
          </div>

          <div className="chat-list">
            {/* Incoming requests. Someone is waiting on an answer, so they sit
                above everything else and carry their two buttons with them. */}
            {pendingRequests.length > 0 && (
              <>
                <div className="section-title">
                  {tr('friends_requests')} · {pendingRequests.length}
                </div>
                {pendingRequests.map(req => (
                  <div key={req.id} className="chat-item">
                    <div className="chat-avatar">
                      <Avatar
                        name={req.from_user.nickname || req.from_user.username}
                        avatar={req.from_user.avatar}
                        size={avatarSize}
                      />
                    </div>
                    <div className="chat-info">
                      <div className="chat-name">{req.from_user.nickname || req.from_user.username}</div>
                      <div className="chat-message">{tr('friends_wants_to_be')}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <button className="chat-item-action" style={{ color: '#22c55e' }}
                        onClick={() => handleAccept(req.id)} title={tr('friends_accept')}>
                        <Check size={16} />
                      </button>
                      <button className="chat-item-action" style={{ color: '#ef4444' }}
                        onClick={() => handleReject(req.id)} title={tr('friends_decline')}>
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* Until the first fetch settles the list is empty for a reason we
                cannot tell apart from "no friends yet" — so say neither. */}
            {!friendsLoaded && friends.length === 0 && <ListSkeleton rows={5} avatarSize={avatarSize} />}

            {filteredFriends.length > 0 && (
              <div className="section-title">{tr('friends_direct_messages')}</div>
            )}

            {filteredFriends.map(friend => (
              <div
                key={friend.id}
                className={`chat-item ${String(currentChat) === String(friend.id) ? 'active' : ''}`}
                onClick={() => setCurrentChat(friend.id)}
                onContextMenu={e => handleFriendContextMenu(e, friend as FriendInfo)}
              >
                <div className="chat-avatar">
                  <Avatar name={friend.nickname || friend.username} avatar={friend.avatar} size={avatarSize} />
                  <span style={{
                    position: 'absolute', bottom: -1, right: -1,
                    width: 11, height: 11, borderRadius: '50%',
                    background: STATUS_COLOR[friend.status] ?? STATUS_COLOR.offline,
                    border: '2px solid var(--bg-secondary)',
                  }} />
                </div>
                <div className="chat-info">
                  <div className="chat-name" style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {accountDisplayName(friend)}
                    </span>
                    <AccountBadge account={friend} />
                  </div>
                  <div className="chat-message">
                    {tr((`status_${friend.status ?? 'offline'}`) as any)}
                  </div>
                </div>
              </div>
            ))}

            {/* Blocked contacts — kept visible so the user can still read the history */}
            {filteredBlocked.length > 0 && (
              <>
                <div className="section-title"><Ban size={11} /> {tr('status_blocked')}</div>
                {filteredBlocked.map(user => (
                  <div
                    key={user.id}
                    className={`chat-item ${String(currentChat) === String(user.id) ? 'active' : ''}`}
                    onClick={() => setCurrentChat(user.id)}
                    onContextMenu={e => handleBlockedContextMenu(e, user as FriendInfo)}
                  >
                    <div className="chat-avatar">
                      <Avatar name={user.nickname || user.username} avatar={user.avatar} size={avatarSize} />
                    </div>
                    <div className="chat-info">
                      <div className="chat-name">{accountDisplayName(user)}<AccountBadge account={user} /></div>
                      <div className="chat-message" style={{ color: '#f97316' }}>{tr('status_blocked')}</div>
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* Everyone else on the server who matched. No separate screen for
                adding a friend — the search you already typed found them. */}
            {query.length >= 2 && (strangers.length > 0 || searching || !!addError) && (
              <>
                <div className="section-title">{tr('friends_discover')}</div>
                {strangers.map(u => {
                  const asked = askedIds.has(String(u.id));
                  return (
                    <div key={u.id} className="chat-item" style={{ cursor: 'default' }}>
                      <div className="chat-avatar">
                        <Avatar name={u.nickname || u.username} avatar={u.avatar} size={avatarSize} />
                      </div>
                      <div className="chat-info">
                        <div className="chat-name" style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {accountDisplayName(u)}
                          </span>
                          <AccountBadge account={u} />
                        </div>
                        <div className="chat-message">@{u.username}</div>
                      </div>
                      <button
                        className="chat-item-add"
                        disabled={asked}
                        title={asked ? tr('friends_request_pending') : tr('friends_add')}
                        onClick={() => handleSendRequest(u)}
                      >
                        {asked
                          ? <Check size={16} />
                          : <><UserPlus size={13} />{tr('friends_add_btn')}</>}
                      </button>
                    </div>
                  );
                })}
                {searching && strangers.length === 0 && !addError && (
                  <div className="sidebar-hint">{tr('loading')}</div>
                )}
                {addError && <div className="sidebar-hint" style={{ color: '#ef4444' }}>{addError}</div>}
              </>
            )}

            {/* Nothing matched anywhere — say which of the two silences it is. */}
            {friendsLoaded && filteredFriends.length === 0 && filteredBlocked.length === 0
              && pendingRequests.length === 0 && strangers.length === 0 && !searching && !addError && (
              <div className="sidebar-hint">
                {query ? tr('friends_no_users') : tr('friends_none_hint')}
              </div>
            )}
          </div>
        </>
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
          {currentUser?.is_superuser && (
            <div className={`settings-item ${currentSettingsPage === 'admin' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('admin')}>
              {language === 'ru' ? 'Админ-панель' : 'Admin panel'}
            </div>
          )}
          <div className={`settings-item ${currentSettingsPage === 'data' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('data')}>{tr('settings_data')}</div>
          <div className={`settings-item ${currentSettingsPage === 'devices' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('devices')}>{tr('settings_devices')}</div>
          <div className={`settings-item ${currentSettingsPage === 'servers' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('servers')}>{tr('settings_servers')}</div>
          {modulePages.map(p => (
            <div key={`${p.moduleId}:${p.id}`} className={`settings-item ${currentSettingsPage === p.id ? 'active' : ''}`} onClick={() => setCurrentSettingsPage(p.id)}>{typeof p.label === 'function' ? p.label() : p.label}</div>
          ))}
          <div className={`settings-item ${currentSettingsPage === 'integration' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('integration')}>{tr('settings_integration')}</div>
          <div className={`settings-item ${currentSettingsPage === 'notifications' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('notifications')}>{tr('settings_notifications')}</div>
          <div className={`settings-item ${currentSettingsPage === 'apps' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('apps')}>{tr('settings_apps')}</div>
          {/* Everything that costs money, or spends it. A child's account has
              no way to pay for any of it and no business being asked to. */}
          {!isChild && (
            <>
              <div className="settings-devider" />
              <div className={`settings-item ${currentSettingsPage === 'nitro' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('nitro')}>{tr('settings_nitro')}</div>
              <div className={`settings-item ${currentSettingsPage === 'subscribes' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('subscribes')}>{tr('settings_subscribes')}</div>
              <div className={`settings-item ${currentSettingsPage === 'gifts' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('gifts')}>{tr('settings_gifts')}</div>
              <div className={`settings-item ${currentSettingsPage === 'payments' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('payments')}>{tr('settings_payments')}</div>
            </>
          )}
          <div className="settings-devider" />
          <div className={`settings-item ${currentSettingsPage === 'view' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('view')}>{tr('settings_appearance')}</div>
          <div className={`settings-item ${currentSettingsPage === 'special' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('special')}>{tr('settings_special')}</div>
          <div className={`settings-item ${currentSettingsPage === 'voiceAndVideo' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('voiceAndVideo')}>{tr('settings_voice_video')}</div>
          <div className={`settings-item ${currentSettingsPage === 'chat' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('chat')}>{tr('settings_chat')}</div>
          <div className={`settings-item ${currentSettingsPage === 'formatting' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('formatting')}>{tr('settings_formatting')}</div>
          {!isMobile && <div className={`settings-item ${currentSettingsPage === 'binds' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('binds')}>{tr('settings_binds')}</div>}
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
        <SharedProfileModal
          user={profileFriend}
          onClose={() => setProfileFriend(null)}
          onCall={handleProfileCall}
        />
      )}
    </aside>
  );
};

// ── User Profile Footer ───────────────────────────────────────────────────────

/** The four states a person may put themselves in, in the order they read. */
const STATUS_CHOICES = ['online', 'idle', 'dnd', 'offline'] as const;

export const UserProfile: React.FC = () => {
  const {
    currentUser, isMicActive, isHeadphonesActive, setMicActive, setHeadphonesActive,
    currentServerIP, authToken, setCurrentUser,
  } = useApp();
  const tr = useTranslation();
  const displayName = currentUser?.nickname || currentUser?.username || 'You';
  // Your own avatar is the one place in the app you always know where to find,
  // so it is where your own profile opens from.
  const [showOwnProfile, setShowOwnProfile] = useState(false);
  const [statusMenu, setStatusMenu] = useState(false);

  const myStatus = currentUser?.status ?? 'offline';

  // Presence is the owner's to declare. The row paints the new state before
  // the server answers — if the request fails the next `me` fetch corrects it,
  // and a status that lags a click feels broken.
  const chooseStatus = async (next: (typeof STATUS_CHOICES)[number]) => {
    setStatusMenu(false);
    if (!currentUser || next === myStatus) return;
    const previous = myStatus;
    setCurrentUser({ ...currentUser, status: next });
    try {
      const res = await fetch(`${currentServerIP}/api/auth/me/update/`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error('status update failed');
    } catch (e) {
      setCurrentUser({ ...currentUser, status: previous });
      reportError(e);
    }
  };

  // Voice rooms listen to mute/deafen through core lifecycle events.
  const handleMute = () => setMicActive(!isMicActive);

  const handleDeafen = () => {
    const next = !isHeadphonesActive;
    setHeadphonesActive(next);
    // Discord-style: deafening also self-mutes the mic, un-deafening unmutes.
    setMicActive(next);
  };

  return (
    <>
    <SlotList slot="sidebar.userPanel" />
    <div className="user-profile-section glass-panel">
      <button
        className="profile-avatar-btn"
        onClick={() => currentUser && setShowOwnProfile(true)}
        title={tr('profile_edit')}
      >
        {currentUser?.avatar
          ? <img src={currentUser.avatar} alt={displayName} />
          : <div style={{ borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 16, lineHeight: 1 }}>
              {displayName[0].toUpperCase()}
            </div>
        }
        <span className={`status-indicator ${currentUser?.status ?? 'online'}`} />
      </button>
      {/* The status line is the control for it — the thing you want to change
          is the thing you click. */}
      <button className="profile-info profile-status-btn" onClick={() => setStatusMenu(v => !v)}>
        <div className="profile-name" style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayName}</span>
          {currentUser?.is_superuser && <SuperuserBadge />}
        </div>
        {/* No second dot here: the one on the avatar already says it, and two
            markers on one line only fight each other. */}
        <div className="profile-status">
          <span>{tr((`status_${myStatus}`) as any)}</span>
          <ChevronUp size={12} className="profile-status-caret" />
        </div>
      </button>

      {statusMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 8000 }} onClick={() => setStatusMenu(false)} />
          <div className="status-menu">
            {STATUS_CHOICES.map(key => (
              <button
                key={key}
                className={`status-menu-item ${key === myStatus ? 'active' : ''}`}
                onClick={() => chooseStatus(key)}
              >
                <span className="status-menu-dot" style={{ background: STATUS_COLOR[key] }} />
                {tr((`status_${key}`) as any)}
                {key === myStatus && <Check size={14} style={{ marginLeft: 'auto' }} />}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="profile-controls">
        <button
          className={`profile-icon-btn glass-btn ${!isMicActive ? 'muted' : ''}`}
          onClick={handleMute}
          title={tr('profile_mute')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="1" width="6" height="11" rx="3" />
            <path d="M19 10v1a7 7 0 01-14 0v-1" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
            {!isMicActive && <line x1="3" y1="3" x2="21" y2="21" stroke="#f04747" strokeWidth="2.5" />}
          </svg>
        </button>
        <button
          className={`profile-icon-btn glass-btn ${!isHeadphonesActive ? 'muted' : ''}`}
          onClick={handleDeafen}
          title={tr('profile_deafen')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 18v-6a9 9 0 0118 0v6" />
            <path d="M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3v5z" />
            <path d="M3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3v5z" />
            {!isHeadphonesActive && <line x1="3" y1="3" x2="21" y2="21" stroke="#f04747" strokeWidth="2.5" />}
          </svg>
        </button>
      </div>
    </div>
    {showOwnProfile && currentUser && (
      <SharedProfileModal
        user={{
          id: String(currentUser.id),
          username: currentUser.username,
          nickname: currentUser.nickname || '',
          avatar: currentUser.avatar || '',
          bio: currentUser.bio || '',
          status: currentUser.status || 'online',
        }}
        onClose={() => setShowOwnProfile(false)}
      />
    )}
    </>
  );
};
