import React, { useState, useRef, useEffect } from 'react';
import { Hash, Volume2, Plus, Trash2, LogOut, Copy, Users, ChevronDown, ChevronRight, Crown, Shield, UserPlus, Ban, User } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import { ProfileModal, type ProfileUser } from './ProfileModal';
import { UserProfile } from './ChatSidebar';
import type { GuildChannel, GuildMember } from '../types';

// ── Member context menu ──────────────────────────────────────────────────────
function MemberContextMenu({
  member, myRole, guildId, pos, onClose, onOpenProfile,
}: {
  member: GuildMember;
  myRole: string;
  guildId: number;
  pos: { x: number; y: number };
  onClose: () => void;
  onOpenProfile: () => void;
}) {
  const { kickMember, setMemberRole, blockUser, sendFriendRequest, friends, userIDonServer } = useApp();
  const tr = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const isFriend = friends.some(f => String(f.id) === member.id);
  const isSelf = member.id === userIDonServer;
  const canManage = (myRole === 'owner' || myRole === 'admin') && !isSelf && member.role !== 'owner';

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Clamp so menu never goes off bottom of screen
  const menuHeight = 160;
  const top = Math.min(pos.y, window.innerHeight - menuHeight);

  return (
    <div ref={ref} className="context-menu" style={{ position: 'fixed', left: pos.x, top, minWidth: 190, zIndex: 9999 }}>
      <button className="context-menu-item" onClick={() => { onOpenProfile(); onClose(); }}>
        <User size={13} /> {tr('guild_view_profile')}
      </button>
      {!isSelf && !isFriend && (
        <button className="context-menu-item" onClick={() => { sendFriendRequest(member.id); onClose(); }}>
          <UserPlus size={13} /> {tr('guild_add_friend')}
        </button>
      )}
      {!isSelf && canManage && myRole === 'owner' && member.role === 'member' && (
        <button className="context-menu-item" onClick={() => { setMemberRole(guildId, member.id, 'admin'); onClose(); }}>
          <Shield size={13} /> {tr('guild_make_admin')}
        </button>
      )}
      {!isSelf && canManage && myRole === 'owner' && member.role === 'admin' && (
        <button className="context-menu-item" onClick={() => { setMemberRole(guildId, member.id, 'member'); onClose(); }}>
          <Shield size={13} /> {tr('guild_remove_admin')}
        </button>
      )}
      {!isSelf && canManage && (
        <button className="context-menu-item danger" onClick={() => { kickMember(guildId, member.id); onClose(); }}>
          <Trash2 size={13} /> {tr('guild_kick')}
        </button>
      )}
      {!isSelf && (myRole === 'owner' || myRole === 'admin') && (
        <button className="context-menu-item danger" onClick={() => { kickMember(guildId, member.id); blockUser(member.id); onClose(); }}>
          <Ban size={13} /> {tr('guild_block')}
        </button>
      )}
    </div>
  );
}

// ── Member row ───────────────────────────────────────────────────────────────
function MemberRow({ member, myRole, guildId }: { member: GuildMember; myRole: string; guildId: number }) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [showProfile, setShowProfile] = useState(false);

  const statusColor: Record<string, string> = {
    online: '#3ba55c', idle: '#faa81a', dnd: '#ed4245', offline: '#747f8d',
  };

  const profileUser: ProfileUser = {
    id: member.id,
    username: member.username,
    nickname: member.nickname,
    avatar: member.avatar,
    status: member.status,
  };

  return (
    <>
      <div
        className="member-row"
        onContextMenu={e => { e.preventDefault(); setMenuPos({ x: e.clientX, y: e.clientY }); }}
        onClick={() => setShowProfile(true)}
        style={{ cursor: 'pointer' }}
      >
        <div className="member-avatar-wrap">
          {member.avatar ? (
            <img src={member.avatar} alt={member.username} className="member-avatar" />
          ) : (
            <div className="member-avatar member-avatar-placeholder">
              {(member.nickname || member.username)[0].toUpperCase()}
            </div>
          )}
          <span className="status-dot" style={{ background: statusColor[member.status] ?? '#747f8d' }} />
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
          <span className="member-name">{member.nickname || member.username}</span>
          {member.role === 'owner' && <Crown size={11} style={{ color: '#faa81a', flexShrink: 0 }} />}
          {member.role === 'admin' && <Shield size={11} style={{ color: '#5865f2', flexShrink: 0 }} />}
        </div>
      </div>

      {menuPos && (
        <MemberContextMenu
          member={member} myRole={myRole} guildId={guildId}
          pos={menuPos}
          onClose={() => setMenuPos(null)}
          onOpenProfile={() => setShowProfile(true)}
        />
      )}

      {showProfile && (
        <ProfileModal user={profileUser} onClose={() => setShowProfile(false)} />
      )}
    </>
  );
}

// ── Main sidebar ─────────────────────────────────────────────────────────────
export const GuildSidebar: React.FC = () => {
  const {
    currentGuild, currentGuildChannel, selectGuildChannel,
    createChannel, deleteChannel, deleteGuild, leaveGuild,
  } = useApp();
  const tr = useTranslation();

  const [showChannelMenu, setShowChannelMenu] = useState<number | null>(null);
  const [addingChannel, setAddingChannel] = useState<'text' | 'voice' | null>(null);
  const [newChName, setNewChName] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!currentGuild) return null;

  const myRole = currentGuild.my_role;
  const isAdmin = myRole === 'owner' || myRole === 'admin';
  const textChannels = currentGuild.channels.filter(c => c.type === 'text');
  const voiceChannels = currentGuild.channels.filter(c => c.type === 'voice');

  const handleAddChannel = async (type: 'text' | 'voice') => {
    if (!newChName.trim()) return;
    await createChannel(currentGuild.id, newChName.trim(), type);
    setNewChName('');
    setAddingChannel(null);
  };

  const handleCopyInvite = () => {
    navigator.clipboard.writeText(currentGuild.invite_code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const online = currentGuild.members.filter(m => m.status !== 'offline');
  const offline = currentGuild.members.filter(m => m.status === 'offline');

  return (
    <div className="guild-sidebar">
      {/* Header */}
      <div className="guild-sidebar-header" onClick={() => setShowSettings(v => !v)}>
        <span className="guild-name">{currentGuild.name}</span>
        <ChevronDown size={16} style={{ transform: showSettings ? 'rotate(180deg)' : 'none', transition: '0.15s' }} />
      </div>

      {showSettings && (
        <div className="guild-settings-dropdown">
          <button className="context-menu-item" onClick={handleCopyInvite}>
            <Copy size={13} /> {copied ? tr('guild_copied') : tr('guild_copy_invite')}
          </button>
          {myRole === 'owner' && (
            <button className="context-menu-item danger" onClick={() => deleteGuild(currentGuild.id)}>
              <Trash2 size={13} /> {tr('guild_delete_server')}
            </button>
          )}
          {myRole !== 'owner' && (
            <button className="context-menu-item danger" onClick={() => leaveGuild(currentGuild.id)}>
              <LogOut size={13} /> {tr('guild_leave_server')}
            </button>
          )}
        </div>
      )}

      {/* Channel list */}
      <div className="guild-channel-list">
        <div className="channel-category">
          <div className="channel-category-header">
            <ChevronRight size={12} />
            <span>{tr('guild_text_channels')}</span>
            {isAdmin && (
              <button className="icon-btn-small" onClick={() => setAddingChannel(t => t === 'text' ? null : 'text')} title={tr('guild_add_channel')}>
                <Plus size={13} />
              </button>
            )}
          </div>
          {addingChannel === 'text' && (
            <form onSubmit={e => { e.preventDefault(); handleAddChannel('text'); }} style={{ padding: '4px 8px' }}>
              <input className="input-field" style={{ fontSize: 12, padding: '4px 8px' }} placeholder={tr('guild_channel_name_placeholder')} value={newChName} onChange={e => setNewChName(e.target.value)} autoFocus onKeyDown={e => e.key === 'Escape' && setAddingChannel(null)} />
            </form>
          )}
          {textChannels.map(ch => (
            <div
              key={ch.id}
              className={`channel-item ${currentGuildChannel?.id === ch.id ? 'active' : ''}`}
              onClick={() => selectGuildChannel(ch)}
              onContextMenu={e => { e.preventDefault(); setShowChannelMenu(showChannelMenu === ch.id ? null : ch.id); }}
            >
              <Hash size={15} className="channel-icon" />
              <span style={{ flex: 1 }}>{ch.name}</span>
              {showChannelMenu === ch.id && isAdmin && (
                <div className="context-menu" style={{ left: '100%', top: 0, minWidth: 160 }} onMouseLeave={() => setShowChannelMenu(null)}>
                  <button className="context-menu-item danger" onClick={() => { deleteChannel(currentGuild.id, ch.id); setShowChannelMenu(null); }}>
                    <Trash2 size={13} /> {tr('guild_delete_channel')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="channel-category">
          <div className="channel-category-header">
            <ChevronRight size={12} />
            <span>{tr('guild_voice_channels')}</span>
            {isAdmin && (
              <button className="icon-btn-small" onClick={() => setAddingChannel(t => t === 'voice' ? null : 'voice')} title={tr('guild_add_channel')}>
                <Plus size={13} />
              </button>
            )}
          </div>
          {addingChannel === 'voice' && (
            <form onSubmit={e => { e.preventDefault(); handleAddChannel('voice'); }} style={{ padding: '4px 8px' }}>
              <input className="input-field" style={{ fontSize: 12, padding: '4px 8px' }} placeholder={tr('guild_channel_name_placeholder')} value={newChName} onChange={e => setNewChName(e.target.value)} autoFocus onKeyDown={e => e.key === 'Escape' && setAddingChannel(null)} />
            </form>
          )}
          {voiceChannels.map(ch => (
            <div key={ch.id} className="channel-item" style={{ cursor: 'default' }}>
              <Volume2 size={15} className="channel-icon" />
              <span>{ch.name}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Members — fixed height */}
      <div className="guild-members-panel">
        <div className="members-toggle">
          <Users size={14} />
          <span>{tr('guild_members')} — {currentGuild.members.length}</span>
        </div>
        <div className="members-list">
          {online.length > 0 && (
            <>
              <div className="members-group-label">{tr('guild_online')} — {online.length}</div>
              {online.map(m => <MemberRow key={m.id} member={m} myRole={myRole} guildId={currentGuild.id} />)}
            </>
          )}
          {offline.length > 0 && (
            <>
              <div className="members-group-label">{tr('guild_offline')} — {offline.length}</div>
              {offline.map(m => <MemberRow key={m.id} member={m} myRole={myRole} guildId={currentGuild.id} />)}
            </>
          )}
        </div>
      </div>

      <UserProfile />
    </div>
  );
};
