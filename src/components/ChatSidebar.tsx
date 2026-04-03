import React, { useState } from 'react';
import { Sun, Moon, Search, Menu, UserPlus, Check, X, LogOut } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import type { ServerUser } from '../types';

export const ChatSidebar: React.FC = () => {
  const {
    currentView, currentServer, currentChat, currentSettingsPage,
    setCurrentChat, setCurrentSettingsPage, toggleTheme, theme,
    isMobileSidebarOpen, toggleMobileSidebar, setAuthToken,
    friends, pendingRequests, sendFriendRequest, acceptFriendRequest,
    rejectFriendRequest, searchUsers, loadFriends,
    currentServerIP, authToken,
  } = useApp();
  const tr = useTranslation();

  const [searchQuery, setSearchQuery] = useState('');
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ServerUser[]>([]);
  const [addError, setAddError] = useState('');
  const [addSuccess, setAddSuccess] = useState('');
  const [showLogoutModal, setShowLogoutModal] = useState(false);

  const filteredFriends = friends.filter(f =>
    (f.nickname || f.username).toLowerCase().includes(searchQuery.toLowerCase())
  );

  const sidebarTitle = currentView === 'settings'
    ? tr('nav_settings')
    : tr('nav_direct_messages');

  const handleSearch = async () => {
    if (!addQuery.trim()) return;
    setAddError('');
    setAddSuccess('');
    try {
      const results = await searchUsers(addQuery);
      setSearchResults(results);
      if (results.length === 0) setAddError(tr('friends_no_users'));
    } catch {
      setAddError(tr('friends_search_failed'));
    }
  };

  const handleSendRequest = async (userId: string) => {
    setAddError('');
    setAddSuccess('');
    try {
      await sendFriendRequest(userId);
      setAddSuccess(tr('friends_request_sent'));
      setSearchResults([]);
      setAddQuery('');
    } catch (e: any) {
      setAddError(e.message || 'Error sending request');
    }
  };

  const handleAccept = async (id: number) => {
    try {
      await acceptFriendRequest(id);
    } catch (e: any) {
      console.error(e);
    }
  };

  const handleReject = async (id: number) => {
    try {
      await rejectFriendRequest(id);
    } catch (e: any) {
      console.error(e);
    }
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
          <div className="search-bar glass-panel">
            <Search size={18} className="search-icon" />
            <input
              type="text"
              placeholder={tr('friends_search')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Pending friend requests */}
          {pendingRequests.length > 0 && (
            <>
              <div className="section-title">{tr('friends_requests')} ({pendingRequests.length})</div>
              {pendingRequests.map(req => (
                <div key={req.id} className="chat-item" style={{ gap: 8 }}>
                  <div className="chat-avatar">
                    {req.from_user.avatar
                      ? <img src={req.from_user.avatar} alt={req.from_user.nickname || req.from_user.username} />
                      : <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 14 }}>
                          {(req.from_user.nickname || req.from_user.username)[0].toUpperCase()}
                        </div>
                    }
                  </div>
                  <div className="chat-info" style={{ flex: 1 }}>
                    <div className="chat-name">{req.from_user.nickname || req.from_user.username}</div>
                    <div className="chat-message">{tr('friends_wants_to_be')}</div>
                  </div>
                  <button className="icon-btn glass-btn" style={{ color: '#22c55e', padding: 4 }} onClick={() => handleAccept(req.id)} title={tr('friends_accept')}>
                    <Check size={16} />
                  </button>
                  <button className="icon-btn glass-btn" style={{ color: '#ef4444', padding: 4 }} onClick={() => handleReject(req.id)} title={tr('friends_decline')}>
                    <X size={16} />
                  </button>
                </div>
              ))}
            </>
          )}

          <div className="section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{tr('friends_direct_messages')}</span>
            <button
              className="icon-btn glass-btn"
              style={{ padding: 2 }}
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
                  type="text"
                  placeholder={tr('friends_search_placeholder')}
                  value={addQuery}
                  onChange={e => setAddQuery(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSearch()}
                  style={{
                    flex: 1,
                    padding: '6px 10px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-color)',
                    background: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                    fontSize: 13,
                    outline: 'none',
                  }}
                />
                <button className="glass-btn" style={{ padding: '6px 10px', fontSize: 12 }} onClick={handleSearch}>{tr('friends_find')}</button>
              </div>
              {addError && <div style={{ color: '#ef4444', fontSize: 12 }}>{addError}</div>}
              {addSuccess && <div style={{ color: '#22c55e', fontSize: 12 }}>{addSuccess}</div>}
              {searchResults.map(u => (
                <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)' }}>
                    {u.nickname || u.username}
                    <span style={{ color: 'var(--text-secondary)', marginLeft: 4, fontSize: 11 }}>@{u.username}</span>
                  </div>
                  <button className="glass-btn" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => handleSendRequest(u.id)}>Add</button>
                </div>
              ))}
            </div>
          )}

          {filteredFriends.map((friend) => (
            <div
              key={friend.id}
              className={`chat-item ${String(currentChat) === String(friend.id) ? 'active' : ''}`}
              onClick={() => setCurrentChat(friend.id)}
            >
              <div className="chat-avatar">
                {friend.avatar
                  ? <img src={friend.avatar} alt={friend.nickname || friend.username} />
                  : <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 14 }}>
                      {(friend.nickname || friend.username)[0].toUpperCase()}
                    </div>
                }
                <span className="status-indicator offline"></span>
              </div>
              <div className="chat-info">
                <div className="chat-name">{friend.nickname || friend.username}</div>
                <div className="chat-message">@{friend.username}</div>
              </div>
            </div>
          ))}

          {filteredFriends.length === 0 && !showAddFriend && pendingRequests.length === 0 && (
            <div style={{ padding: '16px 12px', color: 'var(--text-secondary)', fontSize: 13, textAlign: 'center' }}>
              {tr('friends_none')} <UserPlus size={12} style={{ display: 'inline' }} />
            </div>
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

          <div className="settings-devider"></div>

          <div className={`settings-item ${currentSettingsPage === 'nitro' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('nitro')}>{tr('settings_nitro')}</div>
          <div className={`settings-item ${currentSettingsPage === 'subscribes' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('subscribes')}>{tr('settings_subscribes')}</div>
          <div className={`settings-item ${currentSettingsPage === 'gifts' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('gifts')}>{tr('settings_gifts')}</div>
          <div className={`settings-item ${currentSettingsPage === 'payments' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('payments')}>{tr('settings_payments')}</div>

          <div className="settings-devider"></div>

          <div className={`settings-item ${currentSettingsPage === 'view' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('view')}>{tr('settings_appearance')}</div>
          <div className={`settings-item ${currentSettingsPage === 'special' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('special')}>{tr('settings_special')}</div>
          <div className={`settings-item ${currentSettingsPage === 'voiceAndVideo' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('voiceAndVideo')}>{tr('settings_voice_video')}</div>
          <div className={`settings-item ${currentSettingsPage === 'chat' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('chat')}>{tr('settings_chat')}</div>
          <div className={`settings-item ${currentSettingsPage === 'binds' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('binds')}>{tr('settings_binds')}</div>
          <div className={`settings-item ${currentSettingsPage === 'language' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('language')}>{tr('settings_language')}</div>
          <div className={`settings-item ${currentSettingsPage === 'exportImport' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('exportImport')}>{tr('settings_export_import')}</div>
          <div className={`settings-item ${currentSettingsPage === 'streamer' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('streamer')}>{tr('settings_streamer')}</div>
          <div className={`settings-item ${currentSettingsPage === 'more' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('more')}>{tr('settings_more')}</div>

          <div className="settings-devider"></div>

          <div className={`settings-item ${currentSettingsPage === 'privacyOfActivity' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('privacyOfActivity')}>{tr('settings_activity_privacy')}</div>
          <div className={`settings-item ${currentSettingsPage === 'games' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('games')}>{tr('settings_games')}</div>

          <div className="settings-devider"></div>

          <div className="settings-item" style={{ color: '#ef4444' }} onClick={() => setShowLogoutModal(true)}>
            <LogOut size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
            {tr('settings_exit')}
          </div>
        </div>
      )}

      {/* Logout confirmation modal */}
      {showLogoutModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 12, padding: 24, maxWidth: 380, width: '90%', border: '1px solid var(--border-color)' }}>
            <h3 style={{ margin: '0 0 8px', color: 'var(--text-primary)', fontSize: 18, fontWeight: 700 }}>{tr('logout_title')}</h3>
            <p style={{ margin: '0 0 20px', color: 'var(--text-secondary)', fontSize: 14 }}>{tr('logout_confirm')}</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowLogoutModal(false)} style={{ padding: '8px 20px', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 6, fontSize: 14, cursor: 'pointer' }}>
                {tr('cancel')}
              </button>
              <button onClick={() => { setShowLogoutModal(false); setAuthToken(''); }} style={{ padding: '8px 20px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                {tr('logout_button')}
              </button>
            </div>
          </div>
        </div>
      )}

      <UserProfile />
    </aside>
  );
};

const UserProfile: React.FC = () => {
  const { currentUser } = useApp();
  const tr = useTranslation();
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);

  const displayName = currentUser?.nickname || currentUser?.username || 'You';

  return (
    <div className="user-profile-section glass-panel">
      <button className="profile-avatar-btn">
        {currentUser?.avatar
          ? <img src={currentUser.avatar} alt={displayName} />
          : <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 14 }}>
              {displayName[0].toUpperCase()}
            </div>
        }
        <span className="status-indicator online"></span>
      </button>
      <div className="profile-info">
        <div className="profile-name">{displayName}</div>
        <div className="profile-status">{tr('profile_online')}</div>
      </div>
      <div className="profile-controls">
        <button
          className={`profile-icon-btn glass-btn ${isMuted ? 'muted' : ''}`}
          onClick={() => setIsMuted(!isMuted)}
          title={tr('profile_mute')}
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/>
          </svg>
        </button>
        <button
          className={`profile-icon-btn glass-btn ${isDeafened ? 'muted' : ''}`}
          onClick={() => setIsDeafened(!isDeafened)}
          title={tr('profile_deafen')}
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M9 19V6m0 0a3 3 0 013-3h0a3 3 0 013 3m0 0a3 3 0 013-3h0a3 3 0 013 3m0 0v13m0 0H9"/>
          </svg>
        </button>
      </div>
    </div>
  );
};
