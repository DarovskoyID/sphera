import React, { useState } from 'react';
import { Phone, Video, Search, Menu, ArrowLeft, Plus, Smile, Send } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { directMessages, messages, serverChannels } from '../data/mockData';
import { Settings } from './Settings';
import { CallWindow } from './CallWindow';

export const ChatMain: React.FC = () => {
  const { currentView, currentServer, currentChat, currentSettingsPage, toggleMobileSidebar, setMobileActivePanel } = useApp();

  if (currentView === 'settings') {
    if (!currentSettingsPage) {
      return (
        <main className="chat-main">
          <SettingsView />
        </main>
      );
    }
    return (
      <main className="chat-main">
        <header className="chat-header glass-panel settings-mobile-header">
          <button className="icon-btn glass-btn mobile-back-btn" onClick={() => setMobileActivePanel('chat-list')} title="Back">
            <ArrowLeft size={20} />
          </button>
          <h3>{currentSettingsPage}</h3>
        </header>
        <Settings />
      </main>
    );
  }

  if (currentView === 'home') {
    if (!currentChat) {
      return (
        <main className="chat-main">
          <WelcomeScreen />
        </main>
      );
    }
    return (
      <main className="chat-main">
        <ChatHeader />
        <MessagesContainer />
        <MessageInput />
      </main>
    );
  }

  if (currentView === 'server') {
    return (
      <main className="chat-main">
        <ChatHeader />
        <MessagesContainer />
        <MessageInput />
      </main>
    );
  }

  return null;
};

const ChatHeader: React.FC = () => {
  const { isCallActive, currentView, currentChat, toggleMobileSidebar, setCallActive, setVideoActive, setMobileActivePanel } = useApp();

  const chat = currentChat ? directMessages[currentChat] : null;

  if (!chat) return null;

  return (
    <>
    {isCallActive ? <CallWindow /> : <header className="chat-header glass-panel">
      <button className="icon-btn glass-btn mobile-back-btn" onClick={() => setMobileActivePanel('chat-list')} title="Back">
        <ArrowLeft size={20} />
      </button>
      <div className="chat-header-info">
        <div className="header-avatar">
          <img src={chat.avatar} alt={chat.name} />
          <span className={`status-indicator ${chat.status}`}></span>
        </div>
        <div>
          <h3>{chat.name}</h3>
          <p>{chat.status}</p>
        </div>
      </div>
      <div className="chat-header-actions">
        <button className="icon-btn glass-btn" onClick={() => (setCallActive(true))} title="Voice Call">
          <Phone size={20} />
        </button>
        <button className="icon-btn glass-btn" onClick={() => {setCallActive(true); setVideoActive(true)}} title="Video Call">
          <Video size={20} />
        </button>
        <button className="icon-btn glass-btn" title="Search">
          <Search size={20} />
        </button>
        <button className="icon-btn glass-btn mobile-menu-btn" onClick={toggleMobileSidebar}>
          <Menu size={20} />
        </button>
      </div>
    </header>}
    </>

  );
};

const MessagesContainer: React.FC = () => {
  const { currentChat } = useApp();
  const chatMessages = currentChat && messages[currentChat] ? messages[currentChat] : [];

  return (
    <div className="messages-container">
      <div className="messages-list">
        <div className="date-divider">Today</div>
        {chatMessages.map((message) => (
          <div key={message.id} className={`message-item ${message.isOwn ? 'own' : ''}`}>
            <img src={message.avatar} alt={message.author} className="message-avatar" />
            <div className="message-content">
              <div className="message-header">
                <span className="message-author">{message.author}</span>
                <span className="message-timestamp">{message.timestamp}</span>
              </div>
              <div className="message-text">{message.content}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const MessageInput: React.FC = () => {
  const [message, setMessage] = useState('');

  const handleSend = () => {
    if (message.trim()) {
      console.log('Sending message:', message);
      setMessage('');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="message-input-container glass-panel">
      <button className="icon-btn glass-btn" title="Add Attachment">
        <Plus size={20} />
      </button>
      <div className="message-input-wrapper">
        <input
          type="text"
          className="message-input"
          placeholder="Type a message..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyPress={handleKeyPress}
        />
      </div>
      <button className="icon-btn glass-btn" title="Emoji">
        <Smile size={20} />
      </button>
      <button className="icon-btn glass-btn send-btn" onClick={handleSend} title="Send Message">
        <Send size={20} />
      </button>
    </div>
  );
};

const WelcomeScreen: React.FC = () => {
  const ads = [
    {
      label: 'GAMING',
      image: 'https://images.pexels.com/photos/3945683/pexels-photo-3945683.jpeg?auto=compress&cs=tinysrgb&w=600',
      title: 'Join Gaming Servers',
      desc: 'Connect with players worldwide',
      cta: 'Explore',
      color: '#16a34a'
    },
    {
      label: 'DEVELOPMENT',
      image: 'https://images.pexels.com/photos/577585/pexels-photo-577585.jpeg?auto=compress&cs=tinysrgb&w=600',
      title: 'Developer Communities',
      desc: 'Learn, share, and grow together',
      cta: 'Join Now',
      color: '#2563eb'
    },
    {
      label: 'MUSIC',
      image: 'https://images.pexels.com/photos/1763075/pexels-photo-1763075.jpeg?auto=compress&cs=tinysrgb&w=600',
      title: 'Music & Audio',
      desc: 'Discover new sounds and artists',
      cta: 'Listen',
      color: '#dc2626'
    },
    {
      label: 'STUDY',
      image: 'https://images.pexels.com/photos/159490/yale-university-landscape-universities-schools-159490.jpeg?auto=compress&cs=tinysrgb&w=600',
      title: 'Study Groups',
      desc: 'Collaborate and ace your exams',
      cta: 'Study',
      color: '#d97706'
    }
  ];

  return (
    <div className="messages-container">
      <div className="welcome-screen active">
        <div className="welcome-screen-inner">
          <div className="welcome-hero">
            <div className="welcome-hero-icon">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
              </svg>
            </div>
            <h2>Your Messages</h2>
            <p>Select a conversation from the sidebar to start chatting with your friends.</p>
          </div>
          <div className="welcome-ads-grid">
            {ads.map((ad, i) => (
              <div key={i} className="welcome-ad-card">
                <div className="welcome-ad-image" style={{ backgroundImage: `url(${ad.image})` }}>
                  <span className="welcome-ad-label">{ad.label}</span>
                </div>
                <div className="welcome-ad-body">
                  <h3 className="welcome-ad-title">{ad.title}</h3>
                  <p className="welcome-ad-desc">{ad.desc}</p>
                  <button className="welcome-ad-cta" style={{ background: ad.color }}>{ad.cta}</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const SettingsView: React.FC = () => {
  const settingsAds = [
    {
      label: 'PREMIUM',
      image: 'https://images.pexels.com/photos/1939485/pexels-photo-1939485.jpeg?auto=compress&cs=tinysrgb&w=600',
      title: 'Get Premium Features',
      desc: 'Unlock exclusive perks and customization',
      cta: 'Upgrade',
      color: '#8b5cf6'
    },
    {
      label: 'SECURITY',
      image: 'https://images.pexels.com/photos/60504/security-protection-anti-virus-software-60504.jpeg?auto=compress&cs=tinysrgb&w=600',
      title: 'Two-Factor Auth',
      desc: 'Keep your account secure',
      cta: 'Enable',
      color: '#059669'
    }
  ];

  return (
    <div className="settings-welcome-screen">
      <div className="welcome-screen-inner">
        <div className="welcome-hero">
          <div className="welcome-hero-icon settings-icon">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
            </svg>
          </div>
          <h2>Settings</h2>
          <p>Customize your experience. Choose a category from the sidebar to get started.</p>
        </div>
        <div className="welcome-ads-grid">
          {settingsAds.map((ad, i) => (
            <div key={i} className="welcome-ad-card">
              <div className="welcome-ad-image" style={{ backgroundImage: `url(${ad.image})` }}>
                <span className="welcome-ad-label">{ad.label}</span>
              </div>
              <div className="welcome-ad-body">
                <h3 className="welcome-ad-title">{ad.title}</h3>
                <p className="welcome-ad-desc">{ad.desc}</p>
                <button className="welcome-ad-cta" style={{ background: ad.color }}>{ad.cta}</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
