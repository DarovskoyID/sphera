import React, { useState } from 'react';
import { Sun, Moon, ArrowLeft, Search, Menu } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { directMessages, serverChannels } from '../data/mockData';

export const ChatSidebar: React.FC = () => {
  const { currentView, currentServer, currentChat, currentSettingsPage, setCurrentChat, setCurrentSettingsPage, toggleTheme, theme, isMobileSidebarOpen, toggleMobileSidebar } = useApp();
  const [searchQuery, setSearchQuery] = useState('');

  const filteredChats = Object.values(directMessages).filter(chat =>
    chat.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const serverData = currentServer !== 'home' && currentServer !== 'settings'
    ? serverChannels[currentServer]
    : null;

  const sidebarTitle = currentView === 'settings'
    ? 'Settings'
    : serverData
    ? serverData.name
    : 'Direct Messages';

  return (
    <aside className={`chat-sidebar ${isMobileSidebarOpen ? 'mobile-open' : ''}`}>
      <div className="chat-sidebar-header">
        <button className="icon-btn glass-btn mobile-hamburger-btn" onClick={toggleMobileSidebar} title="Menu">
          <Menu size={20} />
        </button>
        <h2>{sidebarTitle}</h2>
        <button className="icon-btn glass-btn" onClick={toggleTheme} title="Toggle Theme">
          {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
        </button>
      </div>

      {currentView === 'home' && (
        <div className="chat-list">
          <div className="search-bar glass-panel">
            <Search size={18} className="search-icon" />
            <input
              type="text"
              placeholder="Search conversations"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="section-title">DIRECT MESSAGES</div>

          {filteredChats.map((chat) => (
            <div
              key={chat.id}
              className={`chat-item ${currentChat === chat.id ? 'active' : ''}`}
              onClick={() => setCurrentChat(chat.id)}
            >
              <div className="chat-avatar">
                <img src={chat.avatar} alt={chat.name} />
                <span className={`status-indicator ${chat.status}`}></span>
              </div>
              <div className="chat-info">
                <div className="chat-name">{chat.name}</div>
                <div className="chat-message">{chat.lastMessage}</div>
              </div>
              <div className="chat-meta">
                <div className="chat-time">{chat.lastMessageTime}</div>
                {chat.unread > 0 && (
                  <div className="unread-badge">{chat.unread}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {currentView === 'server' && serverData && (
        <div className="channel-list">
          <div className="section-title">TEXT CHANNELS</div>
          {serverData.channels.map((channel) => (
            <div key={channel} className="channel-item">
              <span>#</span>
              <span>{channel}</span>
            </div>
          ))}

          <div className="section-title">VOICE CHANNELS</div>
          {serverData.voiceChannels.map((channel) => (
            <div key={channel} className="channel-item">
              <span>🔊</span>
              <span>{channel}</span>
            </div>
          ))}
        </div>
      )}

      {currentView === 'settings' && (
        <div className="settings-list">
          <div className={`settings-item ${currentSettingsPage === 'profile' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('profile')}>My Account</div>
          <div className={`settings-item ${currentSettingsPage === 'content' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('content')}>Privacy & Safety</div>
          <div className={`settings-item ${currentSettingsPage === 'data' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('data')}>Data and privacy</div>
          <div className={`settings-item ${currentSettingsPage === 'devices' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('devices')}>Devices</div>
          <div className={`settings-item ${currentSettingsPage === 'family' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('family')}>Family center</div>
          <div className={`settings-item ${currentSettingsPage === 'integration' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('integration')}>Integration</div>
          <div className={`settings-item ${currentSettingsPage === 'notifications' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('notifications')}>Notifications</div>
          <div className={`settings-item ${currentSettingsPage === 'apps' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('apps')}>Apps</div>

          <div className="settings-devider"></div>

          <div className={`settings-item ${currentSettingsPage === 'nitro' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('nitro')}>Nitro</div>
          <div className={`settings-item ${currentSettingsPage === 'subscribes' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('subscribes')}>Subscribes</div>
          <div className={`settings-item ${currentSettingsPage === 'gifts' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('gifts')}>Gifts</div>
          <div className={`settings-item ${currentSettingsPage === 'payments' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('payments')}>Payments</div>

          <div className="settings-devider"></div>

          <div className={`settings-item ${currentSettingsPage === 'view' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('view')}>Appearance</div>
          <div className={`settings-item ${currentSettingsPage === 'special' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('special')}>Special</div>
          <div className={`settings-item ${currentSettingsPage === 'voiceAndVideo' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('voiceAndVideo')}>Voice & Video</div>
          <div className={`settings-item ${currentSettingsPage === 'chat' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('chat')}>Chat</div>
          <div className={`settings-item ${currentSettingsPage === 'binds' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('binds')}>Key binds</div>
          <div className={`settings-item ${currentSettingsPage === 'language' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('language')}>Language</div>
          <div className={`settings-item ${currentSettingsPage === 'exportImport' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('exportImport')}>Export & Import</div>
          <div className={`settings-item ${currentSettingsPage === 'streamer' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('streamer')}>Streamer mode</div>
          <div className={`settings-item ${currentSettingsPage === 'more' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('more')}>More</div>

          <div className="settings-devider"></div>

          <div className={`settings-item ${currentSettingsPage === 'privacyOfActivity' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('privacyOfActivity')}>Privacy of activity</div>
          <div className={`settings-item ${currentSettingsPage === 'games' ? 'active' : ''}`} onClick={() => setCurrentSettingsPage('games')}>Registered games</div>

          <div className="settings-devider"></div>

          <div className="settings-item" style={{ color: '#ef4444' }}>Exit</div>
        </div>
      )}

      <UserProfile />
    </aside>
  );
};

const UserProfile: React.FC = () => {
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);

  return (
    <div className="user-profile-section glass-panel">
      <button className="profile-avatar-btn">
        <img src="https://images.pexels.com/photos/220453/pexels-photo-220453.jpeg?auto=compress&cs=tinysrgb&w=100" alt="Profile" />
        <span className="status-indicator online"></span>
      </button>
      <div className="profile-info">
        <div className="profile-name">You</div>
        <div className="profile-status">Online</div>
      </div>
      <div className="profile-controls">
        <button
          className={`profile-icon-btn glass-btn ${isMuted ? 'muted' : ''}`}
          onClick={() => setIsMuted(!isMuted)}
          title="Mute Microphone"
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/>
          </svg>
        </button>
        <button
          className={`profile-icon-btn glass-btn ${isDeafened ? 'muted' : ''}`}
          onClick={() => setIsDeafened(!isDeafened)}
          title="Deafen"
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M9 19V6m0 0a3 3 0 013-3h0a3 3 0 013 3m0 0a3 3 0 013-3h0a3 3 0 013 3m0 0v13m0 0H9"/>
          </svg>
        </button>
      </div>
    </div>
  );
};
