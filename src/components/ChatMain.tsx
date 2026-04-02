import React, { useState, useEffect, useRef } from 'react';
import { Phone, Video, Search, Menu, ArrowLeft, Plus, Smile, Send } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { Settings } from './Settings';
import { CallWindow } from './CallWindow';

export const ChatMain: React.FC = () => {
  const { currentView, currentChat, currentSettingsPage, setMobileActivePanel } = useApp();

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
  const { isCallActive, currentChat, friends, toggleMobileSidebar, setCallActive, setVideoActive, setCallTargetId, setMobileActivePanel } = useApp();

  const friend = friends.find(f => String(f.id) === String(currentChat));

  if (!friend) return null;

  const displayName = friend.nickname || friend.username;

  const startCall = (withVideo = false) => {
    setCallTargetId(friend.id);
    setCallActive(true);
    if (withVideo) setVideoActive(true);
  };

  return (
    <>
    {isCallActive ? <CallWindow /> : <header className="chat-header glass-panel">
      <button className="icon-btn glass-btn mobile-back-btn" onClick={() => setMobileActivePanel('chat-list')} title="Back">
        <ArrowLeft size={20} />
      </button>
      <div className="chat-header-info">
        <div className="header-avatar">
          {friend.avatar
            ? <img src={friend.avatar} alt={displayName} />
            : <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 14 }}>
                {displayName[0].toUpperCase()}
              </div>
          }
          <span className="status-indicator offline"></span>
        </div>
        <div>
          <h3>{displayName}</h3>
          <p>@{friend.username}</p>
        </div>
      </div>
      <div className="chat-header-actions">
        <button className="icon-btn glass-btn" onClick={() => startCall(false)} title="Voice Call">
          <Phone size={20} />
        </button>
        <button className="icon-btn glass-btn" onClick={() => startCall(true)} title="Video Call">
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

const MSG_HEIGHT = 60;

const MessageRow = React.memo(({ msg, isOwn }: { msg: import('../types').ChatMessage; isOwn: boolean }) => {
  const displayName = msg.author.nickname || msg.author.username;
  const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className={`message-item ${isOwn ? 'own' : ''}`} style={{ minHeight: MSG_HEIGHT }}>
      <div className="message-avatar">
        {msg.author.avatar
          ? <img src={msg.author.avatar} alt={displayName} style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} />
          : <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 14 }}>
              {displayName[0].toUpperCase()}
            </div>
        }
      </div>
      <div className="message-content">
        <div className="message-header">
          <span className="message-author">{displayName}</span>
          <span className="message-timestamp">{time}</span>
        </div>
        <div className="message-text">{msg.content}</div>
      </div>
    </div>
  );
});

const MessagesContainer: React.FC = () => {
  const { chatMessages, userIDonServer, loadOlderMessages } = useApp();
  const containerRef = useRef<HTMLDivElement>(null);
  const wasAtBottom = useRef(true);
  const loadingOlder = useRef(false);

  // Auto-scroll to bottom when new messages arrive (if user was at bottom)
  useEffect(() => {
    const el = containerRef.current;
    if (el && wasAtBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [chatMessages.length]);

  // Track whether user is scrolled to bottom
  const handleScroll = async () => {
    const el = containerRef.current;
    if (!el) return;

    const threshold = 80;
    wasAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;

    // Load older messages when scrolled near top
    if (el.scrollTop < 100 && !loadingOlder.current && chatMessages.length > 0) {
      loadingOlder.current = true;
      const prevHeight = el.scrollHeight;
      const loaded = await loadOlderMessages();
      if (loaded) {
        // Maintain scroll position after prepending
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight - prevHeight;
        });
      }
      loadingOlder.current = false;
    }
  };

  return (
    <div className="messages-container" ref={containerRef} onScroll={handleScroll}>
      <div className="messages-list">
        {chatMessages.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>
            No messages yet. Say hello!
          </div>
        )}
        {chatMessages.map((msg, i) => (
          <MessageRow
            key={msg.id || `tmp-${i}`}
            msg={msg}
            isOwn={String(msg.author.id) === String(userIDonServer)}
          />
        ))}
      </div>
    </div>
  );
};

const MessageInput: React.FC = () => {
  const { sendChatMessage } = useApp();
  const [message, setMessage] = useState('');

  const handleSend = () => {
    if (message.trim()) {
      sendChatMessage(message);
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
        </div>
      </div>
    </div>
  );
};

const SettingsView: React.FC = () => {
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
      </div>
    </div>
  );
};
