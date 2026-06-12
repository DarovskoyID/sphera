import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { Hash, Volume2, Plus, Trash2, LogOut, Copy, Users, ChevronDown, ChevronRight, Crown, Shield, UserPlus, Ban, User, MicOff, ShieldOff, Settings } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import { ProfileModal, type ProfileUser } from './ProfileModal';
import { UserProfile } from './ChatSidebar';
import { GuildSettingsModal } from './GuildSettings';
import type { GuildMember } from '../types';

// ── Member context menu ──────────────────────────────────────────────────────
function MemberContextMenu({
  member, myRole, guildId, pos, onClose, onOpenProfile,
}: {
  member: GuildMember;
  myRole: string;
  guildId: string;
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

  const [adjustedPos, setAdjustedPos] = useState({ x: pos.x, y: pos.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight - 68; // 60px mobile nav + 8px margin
    setAdjustedPos({
      x: Math.min(Math.max(pos.x, 8), vw - width - 8),
      y: Math.min(Math.max(pos.y, 8), vh - height),
    });
  }, [pos.x, pos.y]);

  return (
    <div ref={ref} className="context-menu" style={{ position: 'fixed', left: adjustedPos.x, top: adjustedPos.y, minWidth: 190, zIndex: 9999 }}>
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
      {!isSelf && canManage && member.role !== 'owner' && !(myRole === 'admin' && member.role === 'admin') && (
        <button className="context-menu-item danger" onClick={() => { kickMember(guildId, member.id); onClose(); }}>
          <Trash2 size={13} /> {tr('guild_kick')}
        </button>
      )}
      {!isSelf && member.role !== 'owner' && (myRole === 'owner' || myRole === 'admin') && !(myRole === 'admin' && member.role === 'admin') && (
        <button className="context-menu-item danger" onClick={() => { kickMember(guildId, member.id); blockUser(member.id); onClose(); }}>
          <Ban size={13} /> {tr('guild_block')}
        </button>
      )}
    </div>
  );
}

// ── Member row ───────────────────────────────────────────────────────────────
function MemberRow({ member, myRole, guildId }: { member: GuildMember; myRole: string; guildId: string }) {
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

// ── Voice participant row ────────────────────────────────────────────────────
function VoiceParticipantRow({ participant, myRole, guildId, members }: {
  participant: { id: string; username: string; nickname: string; avatar: string; muted: boolean };
  myRole: string;
  guildId: string;
  members: GuildMember[];
}) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const { SpeakersActive } = useApp();
  const isSpeaking = !participant.muted && SpeakersActive.includes(participant.id);

  const member: GuildMember = members.find(m => String(m.id) === String(participant.id)) ?? {
    id: participant.id,
    username: participant.username,
    nickname: participant.nickname,
    avatar: participant.avatar,
    status: 'online',
    role: 'member',
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
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '3px 4px', cursor: 'pointer', borderRadius: 6,
          outline: isSpeaking ? '2px solid var(--accent-primary)' : '2px solid transparent',
          background: isSpeaking ? 'rgba(var(--accent-primary-rgb, 88,101,242), 0.08)' : 'transparent',
          transition: 'outline 0.1s, background 0.1s',
        }}
        onContextMenu={e => { e.preventDefault(); setMenuPos({ x: e.clientX, y: e.clientY }); }}
        onClick={() => setShowProfile(true)}
      >
        {participant.avatar ? (
          <img src={participant.avatar} alt="" style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
        ) : (
          <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#fff', fontWeight: 700, flexShrink: 0 }}>
            {(participant.nickname || participant.username)[0]?.toUpperCase()}
          </div>
        )}
        <span style={{ fontSize: 13, color: isSpeaking ? 'var(--accent-primary)' : 'var(--text-secondary, #888)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, fontWeight: isSpeaking ? 600 : 400 }}>
          {participant.nickname || participant.username}
        </span>
        {participant.muted && <MicOff size={12} style={{ color: '#ed4245', flexShrink: 0 }} />}
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
    joinVoiceChannel, leaveVoiceChannel, currentVoiceChannel,
    voiceChannelParticipants, voiceParticipants, currentServerIP, authToken,
    blockedContacts, unblockUser,
    setMobileActivePanel,
  } = useApp();
  const tr = useTranslation();

  const [showChannelMenu, setShowChannelMenu] = useState<string | null>(null);
  const [addingChannel, setAddingChannel] = useState<'text' | 'voice' | null>(null);
  const [newChName, setNewChName] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState('');
  type VoicePresenceMap = Record<string, Array<{ id: string; username: string; nickname: string; avatar: string; muted: boolean }>>;

  // Local REST-polled voice presence (channel_id → participants[])
  const [localVoicePresence, setLocalVoicePresence] = useState<VoicePresenceMap>({});

  // Fetch voice presence on mount + every 3 seconds
  useEffect(() => {
    if (!currentGuild || !authToken) return;
    const fetchPresence = () => {
      fetch(`${currentServerIP}/api/guilds/${currentGuild.id}/voice-presence/`, {
        headers: { Authorization: `Bearer ${authToken}` },
      })
        .then(r => r.ok ? r.json() : {})
        .then((data: VoicePresenceMap) => {
          setLocalVoicePresence(data);
        })
        .catch(() => {});
    };
    fetchPresence();
    const interval = setInterval(fetchPresence, 3000);
    return () => clearInterval(interval);
  }, [currentGuild?.id, authToken, currentServerIP]);

  // Merge WS-realtime updates into local presence (WS updates take priority)
  const mergedPresence: VoicePresenceMap = {
    ...localVoicePresence,
    ...voiceChannelParticipants,
    ...(currentVoiceChannel ? { [currentVoiceChannel.id]: voiceParticipants } : {}),
  };

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
      <div className="guild-sidebar-header">
        <button
          className="mobile-back-btn"
          style={{ display: 'none', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '0 4px 0 0', alignItems: 'center' }}
          onClick={() => setMobileActivePanel('chat-list')}
        >
          <ChevronRight size={18} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <span className="guild-name" style={{ flex: 1, cursor: 'pointer' }} onClick={() => setShowSettings(v => !v)}>{currentGuild.name}</span>
        <ChevronDown size={16} style={{ transform: showSettings ? 'rotate(180deg)' : 'none', transition: '0.15s', cursor: 'pointer' }} onClick={() => setShowSettings(v => !v)} />
      </div>

      {showSettings && (
        <div className="guild-settings-dropdown">
          <button className="context-menu-item" onClick={handleCopyInvite}>
            <Copy size={13} /> {copied ? tr('guild_copied') : tr('guild_copy_invite')}
          </button>
          {isAdmin && (
            <button className="context-menu-item" onClick={() => { setShowSettings(false); setShowSettingsModal(true); }}>
              <Settings size={13} /> {tr('guild_server_settings')}
            </button>
          )}
          {myRole === 'owner' && (
            <button className="context-menu-item danger" onClick={() => { setShowSettings(false); setDeleteInput(''); setShowDeleteConfirm(true); }}>
              <Trash2 size={13} /> {tr('guild_delete_server')}
            </button>
          )}
          {myRole !== 'owner' && (
            <button className="context-menu-item danger" onClick={() => leaveGuild(currentGuild.id)}>
              <LogOut size={13} /> {tr('guild_leave_server')}
            </button>
          )}

          {/* Blocked users list */}
          {blockedContacts.length > 0 && (
            <>
              <div style={{ borderTop: '1px solid var(--border-color)', margin: '4px 0' }} />
              <div style={{ padding: '4px 10px 2px', fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <Ban size={10} style={{ display: 'inline', marginRight: 4 }} />
                {tr('guild_blocked_count').replace('{n}', String(blockedContacts.length))}
              </div>
              {blockedContacts.map(u => (
                <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px' }}>
                  {u.avatar
                    ? <img src={u.avatar} alt="" style={{ width: 22, height: 22, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                    : <div style={{ width: 22, height: 22, borderRadius: '50%', background: '#f97316', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#fff', fontWeight: 700, flexShrink: 0 }}>
                        {(u.nickname || u.username)[0]?.toUpperCase()}
                      </div>
                  }
                  <span style={{ flex: 1, fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {u.nickname || u.username}
                  </span>
                  <button
                    onClick={() => unblockUser(u.id)}
                    title={tr('guild_unblock')}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#3ba55c', display: 'flex', alignItems: 'center', padding: 2, flexShrink: 0 }}
                  >
                    <ShieldOff size={13} />
                  </button>
                </div>
              ))}
            </>
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
          {voiceChannels.map(ch => {
            const isActive = currentVoiceChannel?.id === ch.id;
            const participants = mergedPresence[ch.id] ?? [];
            return (
              <div key={ch.id} style={{ display: 'flex', flexDirection: 'column' }}>
                <div
                  className={`channel-item ${isActive ? 'active' : ''}`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => isActive ? leaveVoiceChannel() : joinVoiceChannel(ch)}
                >
                  <Volume2 size={15} className="channel-icon" style={{ color: isActive ? 'var(--accent-primary, #5865f2)' : undefined }} />
                  <span style={{ flex: 1 }}>{ch.name}</span>
                  {participants.length > 0 && (
                    <span style={{ fontSize: 10, color: 'var(--text-secondary, #888)' }}>{participants.length}</span>
                  )}
                </div>
                {participants.length > 0 && (
                  <div style={{ paddingLeft: 28, display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 2 }}>
                    {participants.map(p => (
                      <VoiceParticipantRow
                        key={p.id}
                        participant={p}
                        myRole={myRole}
                        guildId={currentGuild.id}
                        members={currentGuild.members}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
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

      {showSettingsModal && <GuildSettingsModal onClose={() => setShowSettingsModal(false)} />}

      {showDeleteConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9500 }}>
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 12, padding: 28, maxWidth: 420, width: '90%', border: '1px solid var(--border-color)' }}>
            <h3 style={{ margin: '0 0 8px', color: '#ef4444', fontSize: 18, fontWeight: 700 }}>{tr('guild_delete_server')}</h3>
            <p style={{ margin: '0 0 16px', color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.5 }}>
              {tr('guild_delete_permanent')}<br /><br />
              {tr('guild_delete_type_confirm').replace('{name}', '')}
              <strong style={{ color: 'var(--text-primary)' }}>{currentGuild.name}</strong>
            </p>
            <input
              autoFocus
              value={deleteInput}
              onChange={e => setDeleteInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') { setShowDeleteConfirm(false); setDeleteInput(''); } }}
              placeholder={currentGuild.name}
              style={{
                width: '100%', boxSizing: 'border-box', padding: '10px 12px',
                background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
                border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 14,
                marginBottom: 20, outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setShowDeleteConfirm(false); setDeleteInput(''); }}
                style={{ padding: '9px 20px', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 14, cursor: 'pointer' }}>
                {tr('cancel')}
              </button>
              <button
                disabled={deleteInput !== currentGuild.name}
                onClick={() => { deleteGuild(currentGuild.id); setShowDeleteConfirm(false); setDeleteInput(''); }}
                style={{
                  padding: '9px 20px', background: deleteInput === currentGuild.name ? '#ef4444' : 'var(--bg-tertiary)',
                  color: deleteInput === currentGuild.name ? '#fff' : 'var(--text-tertiary)',
                  border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600,
                  cursor: deleteInput === currentGuild.name ? 'pointer' : 'not-allowed',
                  transition: 'background 0.15s, color 0.15s',
                }}>
                {tr('guild_delete_server')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
