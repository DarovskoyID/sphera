import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Phone, Video, Search, Menu, ArrowLeft, Plus, Smile, Send, FileText, FileImage, FileVideo, FileAudio, File, Download, X, MoreHorizontal, Reply, Copy, Trash2, Flag, Pin, Clock } from 'lucide-react';
import type { ChatAttachment, ChatMessage as ChatMessageType } from '../types';
import { useApp } from '../context/AppContext';
import { Settings } from './Settings';
import { CallWindow } from './CallWindow';
import { useTranslation } from '../i18n/useTranslation';
import { EmojiPicker, MessageText } from './EmojiPicker';
import type { CustomEmoji } from '../types';

export const ChatMain: React.FC = () => {
  const { currentView, currentChat, currentSettingsPage, setMobileActivePanel } = useApp();
  const tr = useTranslation();

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
          <button className="icon-btn glass-btn mobile-back-btn" onClick={() => setMobileActivePanel('chat-list')} title={tr('nav_back')}>
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
    return <ChatView />;
  }

  if (currentView === 'server') {
    return <ChatView />;
  }

  return null;
};

const ChatHeader: React.FC = () => {
  const { isCallActive, currentChat, friends, toggleMobileSidebar, setCallActive, setVideoActive, setCallTargetId, setMobileActivePanel } = useApp();
  const tr = useTranslation();

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
      <button className="icon-btn glass-btn mobile-back-btn" onClick={() => setMobileActivePanel('chat-list')} title={tr('nav_back')}>
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
        <button className="icon-btn glass-btn" onClick={() => startCall(false)} title={tr('chat_voice_call')}>
          <Phone size={20} />
        </button>
        <button className="icon-btn glass-btn" onClick={() => startCall(true)} title={tr('chat_video_call')}>
          <Video size={20} />
        </button>
        <button className="icon-btn glass-btn" title={tr('chat_search')}>
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

// ── ChatView — holds reply state, wires header + messages + input ─────────────

const ChatView: React.FC = () => {
  const [replyTo, setReplyTo] = useState<ChatMessageType | null>(null);
  return (
    <main className="chat-main">
      <ChatHeader />
      <MessagesContainer onReply={setReplyTo} />
      <MessageInput replyTo={replyTo} onCancelReply={() => setReplyTo(null)} />
    </main>
  );
};

const MSG_HEIGHT = 60;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(contentType: string) {
  if (contentType.startsWith('image/')) return <FileImage size={20} />;
  if (contentType.startsWith('video/')) return <FileVideo size={20} />;
  if (contentType.startsWith('audio/')) return <FileAudio size={20} />;
  if (contentType === 'application/pdf' || contentType.startsWith('text/')) return <FileText size={20} />;
  return <File size={20} />;
}

// Fetches media with auth token and renders as blob URL
const AuthMedia: React.FC<{ url: string; contentType: string; filename: string }> = ({ url, contentType, filename }) => {
  const { authToken, currentServerIP } = useApp();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    (async () => {
      try {
        const res = await fetch(`${currentServerIP}${url}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!res.ok) return;
        const blob = await res.blob();
        if (!revoked) setBlobUrl(URL.createObjectURL(blob));
      } catch { /* ignore */ }
    })();
    return () => {
      revoked = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, authToken, currentServerIP]);

  if (!blobUrl) {
    return (
      <div style={{ width: 200, height: 120, borderRadius: 8, background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 6 }}>
        <div style={{ width: 20, height: 20, border: '2px solid var(--accent-primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      </div>
    );
  }

  if (contentType.startsWith('image/')) {
    return (
      <img
        src={blobUrl}
        alt={filename}
        style={{ maxWidth: 320, maxHeight: 300, borderRadius: 8, display: 'block', cursor: 'pointer', marginTop: 6 }}
        onClick={() => window.open(blobUrl, '_blank')}
      />
    );
  }

  return (
    <video
      src={blobUrl}
      controls
      style={{ maxWidth: 400, maxHeight: 280, borderRadius: 8, display: 'block', marginTop: 6 }}
    />
  );
};

const AttachmentView: React.FC<{ att: ChatAttachment }> = ({ att }) => {
  const isImage = att.content_type.startsWith('image/');
  const isVideo = att.content_type.startsWith('video/');

  if (isImage || isVideo) {
    return <AuthMedia url={att.url} contentType={att.content_type} filename={att.filename} />;
  }

  return (
    <div style={{
      marginTop: 6,
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      background: 'var(--bg-secondary)',
      borderRadius: 8,
      padding: '10px 14px',
      maxWidth: 320,
    }}>
      <div style={{ color: 'var(--accent-primary)', flexShrink: 0 }}>
        {getFileIcon(att.content_type)}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {att.filename}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
          {formatFileSize(att.file_size)}
        </div>
      </div>
      <AuthDownloadButton url={att.url} filename={att.filename} />
    </div>
  );
};

const AuthDownloadButton: React.FC<{ url: string; filename: string }> = ({ url, filename }) => {
  const { authToken, currentServerIP } = useApp();
  const handleDownload = async (e: React.MouseEvent) => {
    e.preventDefault();
    try {
      const res = await fetch(`${currentServerIP}${url}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch { /* ignore */ }
  };
  return (
    <button onClick={handleDownload} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 4, flexShrink: 0 }} title="Download">
      <Download size={16} />
    </button>
  );
};

// ── Context Menu ──────────────────────────────────────────────────────────────

type CtxMenu = { x: number; y: number; msg: ChatMessageType };

const MessageContextMenu: React.FC<{
  menu: CtxMenu;
  isOwn: boolean;
  onClose: () => void;
  onReply: (msg: ChatMessageType) => void;
  onDelete: (id: number) => void;
  onPin: (id: number) => void;
  onReport: (id: number) => void;
  onCopy: (text: string) => void;
}> = ({ menu, isOwn, onClose, onReply, onDelete, onPin, onReport, onCopy }) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Adjust so menu doesn't go off-screen
  const style: React.CSSProperties = {
    position: 'fixed',
    top: menu.y,
    left: menu.x,
    zIndex: 9000,
    background: 'var(--bg-primary, #1a1a2e)',
    border: '1px solid var(--border-color, #333)',
    borderRadius: 10,
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    minWidth: 180,
    overflow: 'hidden',
    padding: '4px 0',
  };

  const item = (icon: React.ReactNode, label: string, onClick: () => void, danger = false) => (
    <button
      key={label}
      onClick={() => { onClick(); onClose(); }}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        width: '100%', padding: '9px 14px', background: 'none',
        border: 'none', cursor: 'pointer', fontSize: 14,
        color: danger ? '#ff4444' : 'var(--text-primary, #fff)',
        textAlign: 'left',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-secondary, #222)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'none')}
    >
      {icon}{label}
    </button>
  );

  return (
    <div ref={ref} style={style}>
      {item(<Reply size={15} />, 'Reply', () => onReply(menu.msg))}
      {item(<Copy size={15} />, 'Copy text', () => onCopy(menu.msg.content))}
      {item(<Pin size={15} />, menu.msg.is_pinned ? 'Unpin' : 'Pin', () => onPin(menu.msg.id))}
      {!isOwn && item(<Flag size={15} />, 'Report', () => onReport(menu.msg.id))}
      {isOwn && item(<Trash2 size={15} />, 'Delete', () => onDelete(menu.msg.id), true)}
    </div>
  );
};

// ── Message Row ───────────────────────────────────────────────────────────────

const MessageRow = React.memo(({ msg, isOwn, onContextMenu, onReply, customEmojis }: {
  msg: ChatMessageType;
  isOwn: boolean;
  onContextMenu: (e: React.MouseEvent, msg: ChatMessageType) => void;
  onReply: (msg: ChatMessageType) => void;
  customEmojis: CustomEmoji[];
}) => {
  const displayName = msg.author.nickname || msg.author.username;
  const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const [hovered, setHovered] = useState(false);
  const [avatarError, setAvatarError] = useState(false);

  return (
    <div
      className={`message-item ${isOwn ? 'own' : ''}`}
      style={{ minHeight: MSG_HEIGHT, position: 'relative', background: msg.is_pinned ? 'rgba(88,101,242,0.08)' : undefined }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={e => { e.preventDefault(); onContextMenu(e, msg); }}
    >
      {msg.is_pinned && (
        <div style={{ position: 'absolute', top: 4, right: 8, color: 'var(--accent-primary)', opacity: 0.7 }}>
          <Pin size={12} />
        </div>
      )}
      <div className="message-avatar">
        {msg.author.avatar && !avatarError
          ? <img src={msg.author.avatar} alt={displayName} style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} onError={() => setAvatarError(true)} />
          : <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 14 }}>
              {displayName[0].toUpperCase()}
            </div>
        }
      </div>
      <div className="message-content" style={{ flex: 1, minWidth: 0 }}>
        <div className="message-header">
          <span className="message-author">{displayName}</span>
          <span className="message-timestamp">{time}</span>
        </div>
        {msg.reply_to && (
          <div style={{
            borderLeft: '3px solid var(--accent-primary)',
            paddingLeft: 8, marginBottom: 4,
            color: 'var(--text-secondary)', fontSize: 12,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            <span style={{ fontWeight: 600 }}>
              {msg.reply_to.author.nickname || msg.reply_to.author.username}:
            </span>{' '}
            <MessageText text={msg.reply_to.content} customEmojis={customEmojis} />
          </div>
        )}
        {msg.content && <div className="message-text"><MessageText text={msg.content} customEmojis={customEmojis} /></div>}
        {msg.attachments?.map(att => (
          <AttachmentView key={att.id} att={att} />
        ))}
      </div>
      {hovered && (
        <div style={{ position: 'absolute', top: 4, right: msg.is_pinned ? 28 : 8, display: 'flex', gap: 4 }}>
          <button
            onClick={() => onReply(msg)}
            style={{ background: 'var(--bg-secondary)', border: 'none', borderRadius: 6, padding: '3px 6px', cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center' }}
            title="Reply"
          >
            <Reply size={14} />
          </button>
          <button
            onClick={e => onContextMenu(e, msg)}
            style={{ background: 'var(--bg-secondary)', border: 'none', borderRadius: 6, padding: '3px 6px', cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center' }}
            title="More"
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      )}
    </div>
  );
});

const MessagesContainer: React.FC<{
  onReply: (msg: ChatMessageType) => void;
}> = ({ onReply }) => {
  const { chatMessages, userIDonServer, loadOlderMessages, deleteMessage, pinMessage, reportMessage, customEmojis } = useApp();
  const tr = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const wasAtBottom = useRef(true);
  const loadingOlder = useRef(false);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (el && wasAtBottom.current) el.scrollTop = el.scrollHeight;
  }, [chatMessages.length]);

  const handleScroll = async () => {
    const el = containerRef.current;
    if (!el) return;
    wasAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 100 && !loadingOlder.current && chatMessages.length > 0) {
      loadingOlder.current = true;
      const prevHeight = el.scrollHeight;
      const loaded = await loadOlderMessages();
      if (loaded) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - prevHeight; });
      loadingOlder.current = false;
    }
  };

  const openCtx = useCallback((e: React.MouseEvent, msg: ChatMessageType) => {
    e.preventDefault();
    e.stopPropagation();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const menuW = 190;
    const menuH = 220;
    const x = e.clientX + menuW > vw ? vw - menuW - 8 : e.clientX;
    const y = e.clientY + menuH > vh ? vh - menuH - 8 : e.clientY;
    setCtxMenu({ x, y, msg });
  }, []);

  const closeCtx = useCallback(() => setCtxMenu(null), []);

  return (
    <>
      {ctxMenu && (
        <MessageContextMenu
          menu={ctxMenu}
          isOwn={String(ctxMenu.msg.author.id) === String(userIDonServer)}
          onClose={closeCtx}
          onReply={msg => { onReply(msg); closeCtx(); }}
          onDelete={id => deleteMessage(id)}
          onPin={id => pinMessage(id)}
          onReport={id => reportMessage(id)}
          onCopy={text => navigator.clipboard.writeText(text).catch(() => {})}
        />
      )}
      <div className="messages-container" ref={containerRef} onScroll={handleScroll}>
        <div className="messages-list">
          {chatMessages.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>
              {tr('chat_no_messages')}
            </div>
          )}
          {chatMessages.map((msg, i) => (
            <MessageRow
              key={msg.id || `tmp-${i}`}
              msg={msg}
              isOwn={String(msg.author.id) === String(userIDonServer)}
              onContextMenu={openCtx}
              onReply={onReply}
              customEmojis={customEmojis}
            />
          ))}
        </div>
      </div>
    </>
  );
};

const MAX_FILES = 5;

type PendingFile = { file: File; preview?: string };

const DELAY_OPTIONS = [
  { label: '5 sec', ms: 5000 },
  { label: '30 sec', ms: 30000 },
  { label: '1 min', ms: 60000 },
  { label: '5 min', ms: 300000 },
];

const MessageInput: React.FC<{ replyTo: ChatMessageType | null; onCancelReply: () => void }> = ({ replyTo, onCancelReply }) => {
  const { sendChatMessage, chatConversationId, currentServerIP, authToken } = useApp();
  const tr = useTranslation();
  const [message, setMessage] = useState('');
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [limitWarning, setLimitWarning] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showDelayMenu, setShowDelayMenu] = useState(false);
  const [delayCountdown, setDelayCountdown] = useState<number | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const delayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    e.target.value = '';
    if (!selected.length) return;

    setPendingFiles(prev => {
      const available = MAX_FILES - prev.length;
      if (available <= 0) {
        setLimitWarning(true);
        setTimeout(() => setLimitWarning(false), 3000);
        return prev;
      }
      const allowed = selected.slice(0, available);
      if (selected.length > available) {
        setLimitWarning(true);
        setTimeout(() => setLimitWarning(false), 3000);
      }
      const newEntries: PendingFile[] = allowed.map(f => ({
        file: f,
        preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
      }));
      return [...prev, ...newEntries];
    });
  }, []);

  const removeFile = useCallback((index: number) => {
    setPendingFiles(prev => {
      const entry = prev[index];
      if (entry?.preview) URL.revokeObjectURL(entry.preview);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const clearFiles = useCallback(() => {
    setPendingFiles(prev => {
      prev.forEach(f => { if (f.preview) URL.revokeObjectURL(f.preview); });
      return [];
    });
  }, []);

  const doSend = useCallback(async (text: string, files: PendingFile[], replyId?: number) => {
    if (!chatConversationId) return;
    const attachmentIds: number[] = [];
    if (files.length > 0) {
      setUploading(true);
      try {
        const results = await Promise.all(
          files.map(async ({ file }) => {
            const form = new FormData();
            form.append('file', file);
            const res = await fetch(
              `${currentServerIP}/api/conversations/${chatConversationId}/upload/`,
              { method: 'POST', headers: { Authorization: `Bearer ${authToken}` }, body: form }
            );
            if (res.ok) { const d = await res.json(); return d.id as number; }
            return null;
          })
        );
        results.forEach(id => { if (id != null) attachmentIds.push(id); });
      } catch { }
      finally { setUploading(false); }
    }
    sendChatMessage(text, attachmentIds.length > 0 ? attachmentIds : undefined, replyId);
  }, [chatConversationId, currentServerIP, authToken, sendChatMessage]);

  const handleSend = useCallback(async () => {
    if (!message.trim() && pendingFiles.length === 0) return;
    const text = message;
    const files = pendingFiles;
    const replyId = replyTo?.id;
    setMessage('');
    clearFiles();
    onCancelReply();
    await doSend(text, files, replyId);
  }, [message, pendingFiles, replyTo, doSend, clearFiles, onCancelReply]);

  const handleDelayedSend = useCallback((delayMs: number) => {
    if (!message.trim() && pendingFiles.length === 0) return;
    setShowDelayMenu(false);
    const text = message;
    const files = [...pendingFiles];
    const replyId = replyTo?.id;
    setMessage('');
    clearFiles();
    onCancelReply();

    let remaining = Math.round(delayMs / 1000);
    setDelayCountdown(remaining);

    const interval = setInterval(() => {
      remaining -= 1;
      setDelayCountdown(remaining);
      if (remaining <= 0) clearInterval(interval);
    }, 1000);

    delayTimerRef.current = setTimeout(async () => {
      clearInterval(interval);
      setDelayCountdown(null);
      await doSend(text, files, replyId);
    }, delayMs);
  }, [message, pendingFiles, replyTo, doSend, clearFiles, onCancelReply]);

  const cancelDelayedSend = useCallback(() => {
    if (delayTimerRef.current) { clearTimeout(delayTimerRef.current); delayTimerRef.current = null; }
    setDelayCountdown(null);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const canSend = message.trim().length > 0 || pendingFiles.length > 0;

  return (
    <div className="message-input-container glass-panel" style={{ flexDirection: 'column', gap: 0, alignItems: 'stretch' }}>
      {/* Delay countdown banner */}
      {delayCountdown !== null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 8px 0', padding: '8px 12px', borderRadius: 8, background: 'rgba(88,101,242,0.15)', border: '1px solid var(--accent-primary)' }}>
          <Clock size={15} style={{ color: 'var(--accent-primary)' }} />
          <span style={{ fontSize: 13, flex: 1 }}>Sending in <b>{delayCountdown}s</b>…</span>
          <button onClick={cancelDelayedSend} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ff6666', fontSize: 12, padding: 0 }}>Cancel</button>
        </div>
      )}

      {/* Reply preview */}
      {replyTo && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 8px 0', padding: '6px 12px', borderRadius: 8, background: 'var(--bg-secondary)', borderLeft: '3px solid var(--accent-primary)' }}>
          <Reply size={13} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-primary)' }}>
              {replyTo.author.nickname || replyTo.author.username}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: 200, verticalAlign: 'middle' }}>
              {replyTo.content || '[attachment]'}
            </span>
          </div>
          <button onClick={onCancelReply} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 2, flexShrink: 0 }}>
            <X size={14} />
          </button>
        </div>
      )}

      {/* File limit warning */}
      {limitWarning && (
        <div style={{ margin: '8px 8px 0', padding: '8px 12px', borderRadius: 8, background: '#ff444422', border: '1px solid #ff4444', color: '#ff6666', fontSize: 13 }}>
          Maximum {MAX_FILES} files per message
        </div>
      )}

      {/* Pending file previews */}
      {pendingFiles.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '8px 12px 0' }}>
          {pendingFiles.map((pf, i) => (
            <div key={i} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-secondary)', borderRadius: 8, padding: '6px 10px', maxWidth: 200 }}>
              {pf.preview
                ? <img src={pf.preview} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
                : <div style={{ color: 'var(--accent-primary)', flexShrink: 0 }}>{getFileIcon(pf.file.type || 'application/octet-stream')}</div>
              }
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 100 }}>{pf.file.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{formatFileSize(pf.file.size)}</div>
              </div>
              <button onClick={() => removeFile(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 2, flexShrink: 0 }} title="Remove">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input row */}
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', position: 'relative' }}>
        <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileSelect} />
        <button className="icon-btn glass-btn" title={tr('chat_attachment')} onClick={() => fileInputRef.current?.click()} disabled={uploading || pendingFiles.length >= MAX_FILES}>
          <Plus size={20} />
        </button>
        <div className="message-input-wrapper">
          <input
            type="text"
            className="message-input"
            placeholder={tr('chat_type_message')}
            value={message}
            onChange={e => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={uploading}
          />
        </div>
        <button
          ref={emojiButtonRef}
          className="icon-btn glass-btn"
          title={tr('chat_emoji')}
          onClick={() => setShowEmojiPicker(v => !v)}
        >
          <Smile size={20} />
        </button>
        {showEmojiPicker && (
          <EmojiPicker
            anchorRef={emojiButtonRef}
            onSelect={emoji => setMessage(prev => prev + emoji)}
            onClose={() => setShowEmojiPicker(false)}
          />
        )}

        {/* Delayed send */}
        <div style={{ position: 'relative' }}>
          <button
            className="icon-btn glass-btn"
            title="Schedule send"
            onClick={() => setShowDelayMenu(v => !v)}
            disabled={uploading || !canSend}
            style={{ opacity: canSend ? 1 : 0.4 }}
          >
            <Clock size={20} />
          </button>
          {showDelayMenu && (
            <div style={{ position: 'absolute', bottom: '110%', right: 0, background: 'var(--bg-primary, #1a1a2e)', border: '1px solid var(--border-color, #333)', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.5)', minWidth: 130, overflow: 'hidden', zIndex: 200 }}>
              {DELAY_OPTIONS.map(opt => (
                <button
                  key={opt.label}
                  onClick={() => handleDelayedSend(opt.ms)}
                  style={{ display: 'block', width: '100%', padding: '9px 14px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary, #fff)', textAlign: 'left' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-secondary, #222)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          className="icon-btn glass-btn send-btn"
          onClick={handleSend}
          title={tr('chat_send')}
          disabled={uploading || !canSend}
        >
          {uploading
            ? <div style={{ width: 18, height: 18, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
            : <Send size={20} />
          }
        </button>
      </div>
    </div>
  );
};

const WelcomeScreen: React.FC = () => {
  const tr = useTranslation();
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
            <h2>{tr('welcome_title')}</h2>
            <p>{tr('welcome_desc')}</p>
          </div>
        </div>
      </div>
    </div>
  );
};

const SettingsView: React.FC = () => {
  const tr = useTranslation();
  return (
    <div className="settings-welcome-screen">
      <div className="welcome-screen-inner">
        <div className="welcome-hero">
          <div className="welcome-hero-icon settings-icon">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
            </svg>
          </div>
          <h2>{tr('nav_settings')}</h2>
          <p>Customize your experience. Choose a category from the sidebar to get started.</p>
        </div>
      </div>
    </div>
  );
};
