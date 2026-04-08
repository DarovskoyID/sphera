/**
 * Shared user profile modal — used in both ChatSidebar and GuildSidebar.
 */
import React, { useState, useEffect } from 'react';
import { X, Phone, Video, UserMinus, UserPlus } from 'lucide-react';
import { useApp } from '../context/AppContext';

export type ProfileUser = {
  id: string;
  username: string;
  nickname: string;
  avatar: string;
  bio?: string;
  status: string;
};

const STATUS_COLOR: Record<string, string> = {
  online: 'var(--status-online)',
  idle: 'var(--status-idle)',
  dnd: 'var(--status-dnd)',
  offline: 'var(--status-offline)',
};

const STATUS_LABEL: Record<string, string> = {
  online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', offline: 'Offline',
};

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

export const ProfileModal: React.FC<{
  user: ProfileUser;
  onClose: () => void;
  /** Optional — if provided, shows Call/Video buttons */
  onCall?: (withVideo: boolean) => void;
}> = ({ user, onClose, onCall }) => {
  const { currentServerIP, authToken, friends, sendFriendRequest, removeFriend } = useApp();
  const [mutualFriends, setMutualFriends] = useState<ProfileUser[]>([]);
  const [note, setNote] = useState(() => localStorage.getItem(`note_${user.id}`) ?? '');
  const displayName = user.nickname || user.username;
  const isFriend = friends.some(f => String(f.id) === String(user.id));

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          `${currentServerIP}/api/auth/users/${user.id}/mutual-friends/`,
          { headers: { Authorization: `Bearer ${authToken}` } }
        );
        if (res.ok) setMutualFriends(await res.json());
      } catch { /* ignore */ }
    })();
  }, [user.id, currentServerIP, authToken]);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
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
          position: 'relative', flexShrink: 0,
        }}>
          <button onClick={onClose} style={{
            position: 'absolute', top: 10, right: 10,
            background: 'rgba(0,0,0,0.4)', border: 'none', borderRadius: 6,
            color: '#fff', cursor: 'pointer', padding: 4, display: 'flex',
          }}>
            <X size={16} />
          </button>
        </div>

        {/* Avatar overlapping banner */}
        <div style={{ padding: '0 20px 20px', marginTop: -40 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 12 }}>
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <div style={{ width: 80, height: 80, borderRadius: '50%', border: '4px solid var(--bg-secondary)', overflow: 'hidden' }}>
                <Avatar name={displayName} avatar={user.avatar} size={80} />
              </div>
              <span style={{
                position: 'absolute', bottom: 4, right: 4,
                width: 16, height: 16, borderRadius: '50%',
                background: STATUS_COLOR[user.status] ?? STATUS_COLOR.offline,
                border: '3px solid var(--bg-secondary)',
              }} />
            </div>
            <div style={{ paddingBottom: 4, minWidth: 0 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.2 }}>{displayName}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>@{user.username}</div>
              <div style={{ fontSize: 12, color: STATUS_COLOR[user.status] ?? STATUS_COLOR.offline, marginTop: 2 }}>
                {STATUS_LABEL[user.status] ?? 'Offline'}
              </div>
            </div>
          </div>

          {/* Bio */}
          {user.bio && (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 12, padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
              {user.bio}
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {onCall && (
              <>
                <button onClick={() => onCall(false)} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '9px 0', background: 'var(--accent-primary)', border: 'none', borderRadius: 8, color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                  <Phone size={15} /> Call
                </button>
                <button onClick={() => onCall(true)} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '9px 0', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                  <Video size={15} /> Video
                </button>
              </>
            )}
            {isFriend ? (
              <button onClick={() => { removeFriend(user.id); onClose(); }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '9px 12px', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, color: '#ef4444', fontWeight: 600, fontSize: 13, cursor: 'pointer' }} title="Remove friend">
                <UserMinus size={15} />
              </button>
            ) : (
              <button onClick={() => sendFriendRequest(user.id)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '9px 12px', background: 'var(--accent-primary)', border: 'none', borderRadius: 8, color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }} title="Add friend">
                <UserPlus size={15} />
              </button>
            )}
          </div>

          {/* Note */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: 0.5, marginBottom: 5, textTransform: 'uppercase' }}>Note (only visible to you)</div>
            <textarea value={note} onChange={e => { setNote(e.target.value); localStorage.setItem(`note_${user.id}`, e.target.value); }} placeholder="Add a note about this person..." style={{ width: '100%', padding: '8px 10px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', resize: 'vertical', minHeight: 64, outline: 'none' }} />
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
                    <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{mf.nickname || mf.username}</span>
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
