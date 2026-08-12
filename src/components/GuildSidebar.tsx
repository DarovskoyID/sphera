import React, { useState, useRef, useEffect } from 'react';
import { Hash, Volume2, Plus, Trash2, LogOut, Copy, Users, ChevronDown, ChevronRight, ChevronLeft, Crown, Shield, UserPlus, Ban, User, MicOff, Settings, Headphones, VolumeX, Volume1, BellOff, Bell } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import { ProfileModal, type ProfileUser } from './ProfileModal';
import { UserProfile } from './ChatSidebar';
import { GuildSettingsModal } from './GuildSettings';
import type { GuildMember, GuildRole } from '../types';
import { AccountBadge, accountDisplayName } from './BotBadge';
import { useAnchoredMenu } from './useAnchoredMenu';
import { LONG_PRESS_SAFE, useLongPress } from './useLongPress';

/**
 * A row in the channel list. Its menu opens on right-click and, on touch, on a
 * long press — Android would otherwise start a text selection on the channel
 * name and never fire `contextmenu`, which is why these menus could not be
 * reached on a phone at all.
 *
 * A component rather than an inline handler because it needs a hook, and these
 * rows are rendered inside `.map`.
 */
const ChannelItem: React.FC<{
  className: string;
  style?: React.CSSProperties;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  children: React.ReactNode;
}> = ({ className, style, onOpen, onMenu, children }) => {
  const press = useLongPress(onMenu);
  return (
    <div
      className={className}
      style={{ ...LONG_PRESS_SAFE, ...style }}
      onClick={onOpen}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onMenu(e.clientX, e.clientY); }}
      {...press}
    >
      {children}
    </div>
  );
};

// ── Member context menu ──────────────────────────────────────────────────────
function MemberContextMenu({
  member, myRole, guildId, pos, onClose, onOpenProfile, guildRoles,
}: {
  member: GuildMember;
  myRole: string;
  guildId: string;
  pos: { x: number; y: number };
  onClose: () => void;
  onOpenProfile: () => void;
  guildRoles: GuildRole[];
}) {
  const { kickMember, setMemberRole, blockUser, sendFriendRequest, friends, userIDonServer, assignMemberRole, removeMemberRole, currentServerIP, authToken } = useApp();
  const tr = useTranslation();
  const { ref, style: position, portal } = useAnchoredMenu(pos, onClose);
  const [showRoles, setShowRoles] = useState(false);
  const isFriend = friends.some(f => String(f.id) === member.id);
  const isSelf = member.id === userIDonServer;
  const canManage = (myRole === 'owner' || myRole === 'admin') && !isSelf && member.role !== 'owner';

  return portal(
    <div ref={ref} style={{ ...position, minWidth: 190, maxWidth: 250, zIndex: 9999, overflowX: 'hidden', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, boxShadow: '0 10px 40px rgba(0,0,0,0.3)', padding: 4 }}>
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
      {(myRole === 'owner' || myRole === 'admin') && guildRoles.length > 0 && (
        <>
          <div style={{ borderTop: '1px solid var(--border-color)', margin: '4px 0' }} />
          <button className="context-menu-item" onClick={() => setShowRoles(v => !v)} style={{ justifyContent: 'space-between' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Shield size={13} /> {tr('guild_roles') || 'Roles'}</span>
            <ChevronRight size={12} style={{ transform: showRoles ? 'rotate(90deg)' : 'none', transition: '0.15s' }} />
          </button>
          {showRoles && (
            <div style={{ maxHeight: 180, overflowY: 'auto' }}>
              {guildRoles.map(role => {
                const has = member.custom_roles?.includes(role.id);
                return (
                  <button
                    key={role.id}
                    className="context-menu-item"
                    style={{ paddingLeft: 24, gap: 6, overflow: 'hidden' }}
                    onClick={async () => {
                      if (has) await removeMemberRole(guildId, member.id, role.id);
                      else await assignMemberRole(guildId, member.id, role.id);
                      onClose();
                    }}
                  >
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: role.color, flexShrink: 0, border: '1px solid rgba(255,255,255,0.15)' }} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{role.name}</span>
                    {has && <span style={{ color: 'var(--accent-primary)', fontWeight: 700, fontSize: 14 }}>✓</span>}
                  </button>
                );
              })}
            </div>
          )}
          <div style={{ borderTop: '1px solid var(--border-color)', margin: '4px 0' }} />
        </>
      )}
      {canManage && member.muted_until && new Date(member.muted_until).getTime() > Date.now() && (
        <button className="context-menu-item" onClick={async () => {
          await fetch(`${currentServerIP}/api/guilds/${guildId}/members/${member.id}/mute/`, {
            method: 'POST', headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ duration_minutes: 0 }),
          });
          onClose();
        }}>
          <Volume1 size={13} /> {tr('guild_unmute')}
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
function MemberRow({ member, myRole, guildId, guildRoles }: { member: GuildMember; myRole: string; guildId: string; guildRoles: GuildRole[] }) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const [roleTooltip, setRoleTooltip] = useState<{ x: number; y: number } | null>(null);
  const dotsRef = useRef<HTMLSpanElement>(null);

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
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
          <span className="member-name">{accountDisplayName(member)}</span>
          <AccountBadge account={member} />
          {member.role === 'owner' && <Crown size={11} style={{ color: '#faa81a', flexShrink: 0 }} />}
          {member.role === 'admin' && <Shield size={11} style={{ color: '#5865f2', flexShrink: 0 }} />}
          {(() => {
            const matched = member.custom_roles?.length > 0 ? guildRoles.filter(r => member.custom_roles.includes(r.id)) : [];
            if (matched.length === 0) return null;
            const first = matched[0];
            const rest = matched.length - 1;
            return (
              <>
                <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 8, background: first.color + '33', color: first.color, fontWeight: 600, flexShrink: 0, lineHeight: '14px', whiteSpace: 'nowrap', maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis' }}>{first.name}</span>
                {rest > 0 && (
                  <span
                    ref={dotsRef}
                    style={{ fontSize: 9, padding: '1px 5px', borderRadius: 8, background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', fontWeight: 600, flexShrink: 0, cursor: 'default' }}
                    onMouseEnter={() => {
                      const rect = dotsRef.current?.getBoundingClientRect();
                      if (rect) setRoleTooltip({ x: rect.left + rect.width / 2, y: rect.top });
                    }}
                    onMouseLeave={() => setRoleTooltip(null)}
                  >
                    +{rest}
                  </span>
                )}
              </>
            );
          })()}
        </div>
      </div>

      {roleTooltip && (() => {
        const matched = guildRoles.filter(r => member.custom_roles?.includes(r.id));
        return (
          <div style={{
            position: 'fixed', left: roleTooltip.x, top: roleTooltip.y,
            transform: 'translate(-50%, calc(-100% - 8px))',
            background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
            borderRadius: 8, padding: '6px 8px', display: 'flex', flexDirection: 'column',
            gap: 3, zIndex: 9999, boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            pointerEvents: 'none',
          }}>
            {matched.map(r => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: r.color, flexShrink: 0 }} />
                <span style={{ fontSize: 11, color: r.color, fontWeight: 600, whiteSpace: 'nowrap' }}>{r.name}</span>
              </div>
            ))}
          </div>
        );
      })()}

      {menuPos && (
        <MemberContextMenu
          member={member} myRole={myRole} guildId={guildId}
          pos={menuPos}
          onClose={() => setMenuPos(null)}
          onOpenProfile={() => setShowProfile(true)}
          guildRoles={guildRoles}
        />
      )}

      {showProfile && (
        <ProfileModal user={profileUser} onClose={() => setShowProfile(false)} />
      )}
    </>
  );
}

// ── Voice participant row ────────────────────────────────────────────────────
function VoiceParticipantRow({ participant, myRole, guildId, members, guildRoles }: {
  participant: { id: string; username: string; nickname: string; avatar: string; muted: boolean; deafened: boolean };
  myRole: string;
  guildId: string;
  members: GuildMember[];
  guildRoles: GuildRole[];
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
    custom_roles: [],
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
        {participant.deafened && <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}><Headphones size={12} style={{ color: '#ed4245' }} /><span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="12" height="12" viewBox="0 0 24 24"><line x1="4" y1="4" x2="20" y2="20" stroke="#ed4245" strokeWidth="2.5" strokeLinecap="round" /></svg></span></span>}
      </div>

      {menuPos && (
        <MemberContextMenu
          member={member} myRole={myRole} guildId={guildId}
          pos={menuPos}
          onClose={() => setMenuPos(null)}
          onOpenProfile={() => setShowProfile(true)}
          guildRoles={guildRoles}
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
    createChannel, deleteChannel, updateChannel, deleteGuild, leaveGuild,
    createCategory, deleteCategory, toggleGuildNotifications,
    joinVoiceChannel, leaveVoiceChannel, currentVoiceChannel,
    voiceChannelParticipants, voiceParticipants, currentServerIP, authToken,
    loadGuildRoles, setMobileActivePanel,
  } = useApp();
  const tr = useTranslation();

  const [channelMenu, setChannelMenu] = useState<{ id: string; x: number; y: number; type: 'text' | 'voice'; user_limit: number } | null>(null);
  const [userLimitValue, setUserLimitValue] = useState('');
  const [addingChannel, setAddingChannel] = useState<'text' | 'voice' | null>(null);
  const [addingChannelCategoryId, setAddingChannelCategoryId] = useState<string | null>(null);
  const [newChName, setNewChName] = useState('');
  const [areaMenu, setAreaMenu] = useState<{ x: number; y: number } | null>(null);
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [categoryMenu, setCategoryMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showMembersScreen, setShowMembersScreen] = useState(false);
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

  const [guildRoles, setGuildRoles] = useState<GuildRole[]>([]);
  useEffect(() => {
    if (!currentGuild) return;
    loadGuildRoles(currentGuild.id).then(setGuildRoles);
  }, [currentGuild?.id, loadGuildRoles]);

  useEffect(() => {
    setShowMembersScreen(false);
  }, [currentGuild?.id]);

  // Merge WS-realtime updates into local presence (WS updates take priority)
  const mergedPresence: VoicePresenceMap = {
    ...localVoicePresence,
    ...voiceChannelParticipants,
    ...(currentVoiceChannel ? { [currentVoiceChannel.id]: voiceParticipants } : {}),
  };

  const areaMenuRef = useRef<HTMLDivElement>(null);
  const categoryMenuRef = useRef<HTMLDivElement>(null);
  const channelMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (areaMenu && areaMenuRef.current && !areaMenuRef.current.contains(t)) setAreaMenu(null);
      if (categoryMenu && categoryMenuRef.current && !categoryMenuRef.current.contains(t)) setCategoryMenu(null);
      if (channelMenu && channelMenuRef.current && !channelMenuRef.current.contains(t)) setChannelMenu(null);
      if ((addingChannel || addingCategory) && !(t instanceof HTMLInputElement)) {
        setAddingChannel(null);
        setAddingChannelCategoryId(null);
        setAddingCategory(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [areaMenu, categoryMenu, channelMenu, addingChannel, addingCategory]);

  if (!currentGuild) return null;

  const myRole = currentGuild.my_role;
  const isAdmin = myRole === 'owner' || myRole === 'admin';
  const textChannels = currentGuild.channels.filter(c => c.type === 'text');
  const voiceChannels = currentGuild.channels.filter(c => c.type === 'voice');

  const handleAddChannel = async (type: 'text' | 'voice') => {
    if (!newChName.trim()) return;
    await createChannel(currentGuild.id, newChName.trim(), type, addingChannelCategoryId || undefined);
    setNewChName('');
    setAddingChannel(null);
    setAddingChannelCategoryId(null);
  };

  const handleAddCategory = async () => {
    if (!newCategoryName.trim()) return;
    await createCategory(currentGuild.id, newCategoryName.trim());
    setNewCategoryName('');
    setAddingCategory(false);
  };

  const handleCopyInvite = () => {
    navigator.clipboard.writeText(currentGuild.invite_code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const online = currentGuild.members.filter(m => m.status !== 'offline');
  const offline = currentGuild.members.filter(m => m.status === 'offline');
  const openMembersScreen = () => {
    setShowSettings(false);
    setShowMembersScreen(true);
    setMobileActivePanel('guild-members');
  };
  const closeMembersScreen = () => {
    setShowMembersScreen(false);
    setMobileActivePanel('guild-channels');
  };

  return (
    <div className={`guild-sidebar ${showMembersScreen ? 'members-open' : ''}`}>
      {/* Header */}
      <div className="guild-sidebar-header">
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
          <button className="context-menu-item" onClick={() => { toggleGuildNotifications(currentGuild.id); }}>
            {currentGuild.my_notifications_muted ? <Bell size={13} /> : <BellOff size={13} />}
            {currentGuild.my_notifications_muted ? tr('guild_unmute_notifications') : tr('guild_mute_notifications')}
          </button>
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

        </div>
      )}

      {/* Channel list */}
      <div className="guild-channel-list" onContextMenu={e => {
        if (!isAdmin) return;
        if ((e.target as HTMLElement).closest('.channel-item, .channel-category-header')) return;
        e.preventDefault();
        setAreaMenu({ x: e.clientX, y: e.clientY });
      }}>
        {/* Uncategorized channels — default text/voice groups */}
        {(() => {
          const uncatText = currentGuild.channels.filter(c => c.type === 'text' && !c.category_id);
          const uncatVoice = currentGuild.channels.filter(c => c.type === 'voice' && !c.category_id);
          return (
            <>
              {(uncatText.length > 0 || (addingChannel === 'text' && !addingChannelCategoryId)) && (
                <div className="channel-category">
                  <div className="channel-category-header" onContextMenu={e => {
                    if (!isAdmin) return; e.preventDefault(); e.stopPropagation();
                    setCategoryMenu({ id: '__text__', x: e.clientX, y: e.clientY });
                  }}>
                    <ChevronRight size={12} />
                    <span>{tr('guild_text_channels')}</span>
                    {isAdmin && (
                      <button className="icon-btn-small" onClick={() => { setAddingChannel('text'); setAddingChannelCategoryId(null); }} title={tr('guild_add_channel')}>
                        <Plus size={13} />
                      </button>
                    )}
                  </div>
                  {addingChannel === 'text' && !addingChannelCategoryId && (
                    <form onSubmit={e => { e.preventDefault(); handleAddChannel('text'); }} style={{ padding: '4px 8px' }}>
                      <input className="input-field" style={{ fontSize: 12, padding: '4px 8px' }} placeholder={tr('guild_channel_name_placeholder')} value={newChName} onChange={e => setNewChName(e.target.value)} autoFocus onKeyDown={e => e.key === 'Escape' && setAddingChannel(null)} />
                    </form>
                  )}
                  {uncatText.map(ch => (
                    <ChannelItem key={ch.id} className={`channel-item ${currentGuildChannel?.id === ch.id ? 'active' : ''}`}
                      onOpen={() => selectGuildChannel(ch)}
                      onMenu={(x, y) => setChannelMenu({ id: ch.id, x, y, type: ch.type, user_limit: ch.user_limit ?? 0 })}>
                      <Hash size={15} className="channel-icon" />
                      <span style={{ flex: 1 }}>{ch.name}</span>
                    </ChannelItem>
                  ))}
                </div>
              )}
              {(uncatVoice.length > 0 || (addingChannel === 'voice' && !addingChannelCategoryId)) && (
                <div className="channel-category">
                  <div className="channel-category-header" onContextMenu={e => {
                    if (!isAdmin) return; e.preventDefault(); e.stopPropagation();
                    setCategoryMenu({ id: '__voice__', x: e.clientX, y: e.clientY });
                  }}>
                    <ChevronRight size={12} />
                    <span>{tr('guild_voice_channels')}</span>
                    {isAdmin && (
                      <button className="icon-btn-small" onClick={() => { setAddingChannel('voice'); setAddingChannelCategoryId(null); }} title={tr('guild_add_channel')}>
                        <Plus size={13} />
                      </button>
                    )}
                  </div>
                  {addingChannel === 'voice' && !addingChannelCategoryId && (
                    <form onSubmit={e => { e.preventDefault(); handleAddChannel('voice'); }} style={{ padding: '4px 8px' }}>
                      <input className="input-field" style={{ fontSize: 12, padding: '4px 8px' }} placeholder={tr('guild_channel_name_placeholder')} value={newChName} onChange={e => setNewChName(e.target.value)} autoFocus onKeyDown={e => e.key === 'Escape' && setAddingChannel(null)} />
                    </form>
                  )}
                  {uncatVoice.map(ch => {
                    const isActive = currentVoiceChannel?.id === ch.id;
                    const participants = mergedPresence[ch.id] ?? [];
                    return (
                      <div key={ch.id} style={{ display: 'flex', flexDirection: 'column' }}>
                        <ChannelItem className={`channel-item ${isActive ? 'active' : ''}`} style={{ cursor: 'pointer', position: 'relative' }}
                          onOpen={() => {
                            if (isActive) return leaveVoiceChannel();
                            const limit = ch.user_limit ?? 0;
                            if (limit > 0 && (mergedPresence[ch.id] ?? []).length >= limit) return;
                            joinVoiceChannel(ch);
                          }}
                          onMenu={(x, y) => setChannelMenu({ id: ch.id, x, y, type: ch.type, user_limit: ch.user_limit ?? 0 })}>
                          <Volume2 size={15} className="channel-icon" style={{ color: isActive ? 'var(--accent-primary, #5865f2)' : undefined }} />
                          <span style={{ flex: 1 }}>{ch.name}</span>
                          {(participants.length > 0 || (ch.user_limit ?? 0) > 0) && <span style={{ fontSize: 10, color: 'var(--text-secondary, #888)' }}>{participants.length}{(ch.user_limit ?? 0) > 0 ? `/${ch.user_limit}` : ''}</span>}
                        </ChannelItem>
                        {participants.length > 0 && (
                          <div style={{ paddingLeft: 28, display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 2 }}>
                            {participants.map(p => (
                              <VoiceParticipantRow key={p.id} participant={p} myRole={myRole} guildId={currentGuild.id} members={currentGuild.members} guildRoles={guildRoles} />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          );
        })()}

        {/* Custom categories */}
        {(currentGuild.categories ?? []).map(cat => {
          const catChannels = currentGuild.channels.filter(c => c.category_id === cat.id);
          const catText = catChannels.filter(c => c.type === 'text');
          const catVoice = catChannels.filter(c => c.type === 'voice');
          return (
            <div key={cat.id} className="channel-category">
              <div className="channel-category-header" onContextMenu={e => {
                if (!isAdmin) return;
                e.preventDefault(); e.stopPropagation();
                setCategoryMenu({ id: cat.id, x: e.clientX, y: e.clientY });
              }}>
                <ChevronRight size={12} />
                <span>{cat.name.toUpperCase()}</span>
                {isAdmin && (
                  <button className="icon-btn-small" onClick={() => { setAddingChannel('text'); setAddingChannelCategoryId(cat.id); }} title={tr('guild_add_channel')}>
                    <Plus size={13} />
                  </button>
                )}
              </div>
              {addingChannel && addingChannelCategoryId === cat.id && (
                <form onSubmit={e => { e.preventDefault(); handleAddChannel(addingChannel); }} style={{ padding: '4px 8px' }}>
                  <input className="input-field" style={{ fontSize: 12, padding: '4px 8px' }} placeholder={tr('guild_channel_name_placeholder')} value={newChName} onChange={e => setNewChName(e.target.value)} autoFocus onKeyDown={e => { if (e.key === 'Escape') setAddingChannel(null); }} />
                </form>
              )}
              {catText.map(ch => (
                <ChannelItem key={ch.id} className={`channel-item ${currentGuildChannel?.id === ch.id ? 'active' : ''}`}
                  onOpen={() => selectGuildChannel(ch)}
                  onMenu={(x, y) => setChannelMenu({ id: ch.id, x, y, type: ch.type, user_limit: ch.user_limit ?? 0 })}>
                  <Hash size={15} className="channel-icon" />
                  <span style={{ flex: 1 }}>{ch.name}</span>
                </ChannelItem>
              ))}
              {catVoice.map(ch => {
                const isActive = currentVoiceChannel?.id === ch.id;
                const participants = mergedPresence[ch.id] ?? [];
                return (
                  <div key={ch.id} style={{ display: 'flex', flexDirection: 'column' }}>
                    <ChannelItem className={`channel-item ${isActive ? 'active' : ''}`} style={{ cursor: 'pointer', position: 'relative' }}
                      onOpen={() => {
                            if (isActive) return leaveVoiceChannel();
                            const limit = ch.user_limit ?? 0;
                            if (limit > 0 && (mergedPresence[ch.id] ?? []).length >= limit) return;
                            joinVoiceChannel(ch);
                          }}
                      onMenu={(x, y) => setChannelMenu({ id: ch.id, x, y, type: ch.type, user_limit: ch.user_limit ?? 0 })}>
                      <Volume2 size={15} className="channel-icon" style={{ color: isActive ? 'var(--accent-primary, #5865f2)' : undefined }} />
                      <span style={{ flex: 1 }}>{ch.name}</span>
                      {(participants.length > 0 || (ch.user_limit ?? 0) > 0) && <span style={{ fontSize: 10, color: 'var(--text-secondary, #888)' }}>{participants.length}{(ch.user_limit ?? 0) > 0 ? `/${ch.user_limit}` : ''}</span>}
                    </ChannelItem>
                    {participants.length > 0 && (
                      <div style={{ paddingLeft: 28, display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 2 }}>
                        {participants.map(p => (
                          <VoiceParticipantRow key={p.id} participant={p} myRole={myRole} guildId={currentGuild.id} members={currentGuild.members} guildRoles={guildRoles} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* Add category input */}
        {addingCategory && (
          <form onSubmit={e => { e.preventDefault(); handleAddCategory(); }} style={{ padding: '4px 8px' }}>
            <input className="input-field" style={{ fontSize: 12, padding: '4px 8px' }} placeholder={tr('guild_category_name_placeholder')} value={newCategoryName} onChange={e => setNewCategoryName(e.target.value)} autoFocus onKeyDown={e => e.key === 'Escape' && setAddingCategory(false)} />
          </form>
        )}
      </div>

      {/* Area context menu (right-click on empty channel list space) */}
      {areaMenu && isAdmin && (
        <div ref={areaMenuRef} style={{ position: 'fixed', left: areaMenu.x, top: areaMenu.y, zIndex: 9999, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, boxShadow: '0 10px 40px rgba(0,0,0,0.3)', padding: 4, minWidth: 180 }}>
          <button className="context-menu-item" onClick={() => { setAddingChannel('text'); setAddingChannelCategoryId(null); setAreaMenu(null); }}>
            <Hash size={13} /> {tr('guild_create_text_channel')}
          </button>
          <button className="context-menu-item" onClick={() => { setAddingChannel('voice'); setAddingChannelCategoryId(null); setAreaMenu(null); }}>
            <Volume2 size={13} /> {tr('guild_create_voice_channel')}
          </button>
          <div style={{ borderTop: '1px solid var(--border-color)', margin: '4px 0' }} />
          <button className="context-menu-item" onClick={() => { setAddingCategory(true); setAreaMenu(null); }}>
            <Plus size={13} /> {tr('guild_create_category')}
          </button>
        </div>
      )}

      {/* Category context menu */}
      {categoryMenu && isAdmin && (
        <div ref={categoryMenuRef} style={{ position: 'fixed', left: categoryMenu.x, top: categoryMenu.y, zIndex: 9999, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, boxShadow: '0 10px 40px rgba(0,0,0,0.3)', padding: 4, minWidth: 180 }}>
          <button className="context-menu-item" onClick={() => { setAddingChannel('text'); setAddingChannelCategoryId(categoryMenu.id.startsWith('__') ? null : categoryMenu.id); setCategoryMenu(null); }}>
            <Hash size={13} /> {tr('guild_create_text_channel')}
          </button>
          <button className="context-menu-item" onClick={() => { setAddingChannel('voice'); setAddingChannelCategoryId(categoryMenu.id.startsWith('__') ? null : categoryMenu.id); setCategoryMenu(null); }}>
            <Volume2 size={13} /> {tr('guild_create_voice_channel')}
          </button>
          <div style={{ borderTop: '1px solid var(--border-color)', margin: '4px 0' }} />
          {categoryMenu.id.startsWith('__') ? (
            <button className="context-menu-item danger" onClick={() => {
              const type = categoryMenu.id === '__text__' ? 'text' : 'voice';
              currentGuild.channels.filter(c => c.type === type && !c.category_id).forEach(c => deleteChannel(currentGuild.id, c.id));
              setCategoryMenu(null);
            }}>
              <Trash2 size={13} /> {tr('guild_delete_category')}
            </button>
          ) : (
            <button className="context-menu-item danger" onClick={() => { deleteCategory(currentGuild.id, categoryMenu.id); setCategoryMenu(null); }}>
              <Trash2 size={13} /> {tr('guild_delete_category')}
            </button>
          )}
        </div>
      )}

      {/* Channel context menu */}
      {channelMenu && isAdmin && (
        <div ref={channelMenuRef} style={{ position: 'fixed', left: channelMenu.x, top: channelMenu.y, zIndex: 9999, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, boxShadow: '0 10px 40px rgba(0,0,0,0.3)', padding: 4, minWidth: 180 }}>
          {channelMenu.type === 'voice' && (
            <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Users size={13} />
              <span style={{ fontSize: 12 }}>{tr('guild_set_user_limit')}</span>
              <input
                type="number" min={0} max={99} autoFocus
                value={userLimitValue || String(channelMenu.user_limit)}
                onChange={e => {
                  const val = Math.max(0, Math.min(99, parseInt(e.target.value) || 0));
                  setUserLimitValue(String(val));
                  updateChannel(currentGuild!.id, channelMenu.id, { user_limit: val });
                }}
                onKeyDown={e => { if (e.key === 'Escape') setChannelMenu(null); }}
                placeholder="0"
                style={{ width: 45, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, textAlign: 'center' }}
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>0 = ∞</span>
            </div>
          )}
          <button className="context-menu-item danger" onClick={() => { deleteChannel(currentGuild!.id, channelMenu.id); setChannelMenu(null); }}>
            <Trash2 size={13} /> {tr('guild_delete_channel')}
          </button>
        </div>
      )}

      {/* Members — fixed height */}
      <div className="guild-members-panel">
        <div className="guild-members-screen-header">
          <button className="guild-members-back" onClick={closeMembersScreen} title={tr('back')}>
            <ChevronLeft size={20} />
          </button>
          <div className="guild-members-screen-title">
            <span>{tr('guild_members')}</span>
            <small>{currentGuild.members.length}</small>
          </div>
        </div>
        <div className="members-toggle">
          <Users size={14} />
          <span>{tr('guild_members')} — {currentGuild.members.length}</span>
        </div>
        <div className="members-list">
          {online.length > 0 && (
            <>
              <div className="members-group-label">{tr('guild_online')} — {online.length}</div>
              {online.map(m => <MemberRow key={m.id} member={m} myRole={myRole} guildId={currentGuild.id} guildRoles={guildRoles} />)}
            </>
          )}
          {offline.length > 0 && (
            <>
              <div className="members-group-label">{tr('guild_offline')} — {offline.length}</div>
              {offline.map(m => <MemberRow key={m.id} member={m} myRole={myRole} guildId={currentGuild.id} guildRoles={guildRoles} />)}
            </>
          )}
        </div>
      </div>

      <button className="guild-members-entry" onClick={openMembersScreen}>
        <span className="guild-members-entry-main">
          <Users size={14} />
          <span>{tr('guild_members')}</span>
        </span>
        <span className="guild-members-entry-count">{currentGuild.members.length}</span>
        <ChevronRight size={16} />
      </button>

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
