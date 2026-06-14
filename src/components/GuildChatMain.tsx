import React, { useEffect, useRef, useState, useCallback, useLayoutEffect } from 'react';
import { Hash, Send, Pin, Trash2, CornerUpLeft, Plus, MoreHorizontal, X, Download, FileText, FileImage, FileVideo, FileAudio, File, ChevronLeft, Reply, Copy, Flag, Clock } from 'lucide-react';
import { useApp, reportError } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import { MessageText } from './EmojiPicker';
import { UnifiedPicker } from './StickerGifPicker';
import ConfirmModal from './ConfirmModal';
import type { GuildMessage } from '../types';

const MAX_FILES = 10;

type PendingFile = { file: File; preview?: string };
type ScheduledItem = { id: string; send_at: string; content: string };

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(type: string) {
  if (type.startsWith('image/')) return <FileImage size={20} />;
  if (type.startsWith('video/')) return <FileVideo size={20} />;
  if (type.startsWith('audio/')) return <FileAudio size={20} />;
  if (type.includes('text') || type.includes('pdf')) return <FileText size={20} />;
  return <File size={20} />;
}

/** Fetches media with Authorization header and renders as blob URL (image or video) */
function AuthMedia({ src, contentType, filename }: { src: string; contentType: string; filename: string }) {
  const { authToken } = useApp();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(src, { headers: { Authorization: `Bearer ${authToken}` } });
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        if (!cancelled) setBlobUrl(URL.createObjectURL(blob));
      } catch { /* ignore */ }
    })();
    return () => {
      cancelled = true;
      setBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    };
  }, [src, authToken]);

  if (!blobUrl) {
    return (
      <div style={{ width: 200, height: 120, borderRadius: 8, background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 4 }}>
        <div style={{ width: 20, height: 20, border: '2px solid var(--accent-primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      </div>
    );
  }

  if (contentType.startsWith('image/')) {
    return (
      <img
        src={blobUrl}
        alt={filename}
        style={{ maxWidth: 'min(320px, 100%)', maxHeight: 240, borderRadius: 8, display: 'block', cursor: 'pointer', marginTop: 4, objectFit: 'contain' }}
        onClick={() => window.open(blobUrl, '_blank')}
      />
    );
  }

  return (
    <video
      src={blobUrl}
      controls
      style={{ maxWidth: 'min(400px, 100%)', maxHeight: 280, borderRadius: 8, display: 'block', marginTop: 4 }}
    />
  );
}

function AttachmentView({ att }: { att: { id: string; filename: string; content_type: string; file_size: number; url: string } }) {
  const { currentServerIP, authToken } = useApp();
  const tr = useTranslation();
  const isMedia = att.content_type.startsWith('image/') || att.content_type.startsWith('video/');
  const src = `${currentServerIP}${att.url}`;

  const handleDownload = async () => {
    try {
      const res = await fetch(src, { headers: { Authorization: `Bearer ${authToken}` } });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = att.filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { reportError(e); }
  };

  if (isMedia) {
    return <AuthMedia src={src} contentType={att.content_type} filename={att.filename} />;
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-tertiary)', borderRadius: 8, padding: '8px 12px', marginTop: 4, maxWidth: 300 }}>
      <span style={{ color: 'var(--accent-primary)' }}>{getFileIcon(att.content_type)}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.filename}</div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{formatFileSize(att.file_size)}</div>
      </div>
      <button onClick={handleDownload} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 4 }} title={tr('chat_download')}>
        <Download size={16} />
      </button>
    </div>
  );
}

const MSG_HEIGHT = 60;

function shouldShowDateSeparator(current: GuildMessage, prev?: GuildMessage): boolean {
  if (!prev) return true;
  const d1 = new Date(prev.created_at);
  const d2 = new Date(current.created_at);
  return d1.getFullYear() !== d2.getFullYear() || d1.getMonth() !== d2.getMonth() || d1.getDate() !== d2.getDate();
}

const DateSeparator: React.FC<{ label: string }> = ({ label }) => (
  <div className="date-separator">
    <span className="date-separator-label">{label}</span>
  </div>
);

type GuildCtxMenu = { x: number; y: number; msg: GuildMessage };

const GuildMessageContextMenu: React.FC<{
  menu: GuildCtxMenu;
  isOwn: boolean;
  canPin: boolean;
  onClose: () => void;
  onReply: (msg: GuildMessage) => void;
  onDelete: (id: string) => void;
  onPin: (id: string) => void;
  onCopy: (text: string) => void;
}> = ({ menu, isOwn, canPin, onClose, onReply, onDelete, onPin, onCopy }) => {
  const tr = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const [adjustedPos, setAdjustedPos] = useState({ x: menu.x, y: menu.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight - 68;
    setAdjustedPos({
      x: Math.min(Math.max(menu.x, 8), vw - width - 8),
      y: Math.min(Math.max(menu.y, 8), vh - height),
    });
  }, [menu.x, menu.y]);

  const style: React.CSSProperties = {
    position: 'fixed',
    top: adjustedPos.y,
    left: adjustedPos.x,
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
      {item(<Reply size={15} />, tr('chat_reply'), () => onReply(menu.msg))}
      {item(<Copy size={15} />, tr('chat_copy_text'), () => onCopy(menu.msg.content))}
      {canPin && item(<Pin size={15} />, menu.msg.is_pinned ? tr('chat_unpin_msg') : tr('chat_pin'), () => onPin(menu.msg.id))}
      {isOwn && item(<Trash2 size={15} />, tr('chat_delete'), () => onDelete(menu.msg.id), true)}
    </div>
  );
};

const GuildMessageRow = React.memo(({ msg, isOwn, isFirstInGroup, onContextMenu, onReply, customEmojis, highlight }: {
  msg: GuildMessage;
  isOwn: boolean;
  isFirstInGroup: boolean;
  onContextMenu: (e: React.MouseEvent, msg: GuildMessage) => void;
  onReply: (msg: GuildMessage) => void;
  customEmojis: any[];
  highlight?: boolean;
}) => {
  const tr = useTranslation();
  const displayName = msg.author.nickname || msg.author.username;
  const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const [hovered, setHovered] = useState(false);
  const [avatarError, setAvatarError] = useState(false);

  return (
    <div
      data-msg-id={msg.id}
      className={`message-item ${isOwn ? 'own' : ''} ${isFirstInGroup ? '' : 'compact'}`}
      style={{
        minHeight: isFirstInGroup ? MSG_HEIGHT : undefined, position: 'relative',
        background: highlight
          ? 'rgba(0,112,243,0.18)'
          : msg.is_pinned ? 'rgba(0,112,243,0.08)' : undefined,
        transition: 'background 0.3s ease',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={e => { e.preventDefault(); onContextMenu(e, msg); }}
    >
      {msg.is_pinned && (
        <div style={{ position: 'absolute', top: 4, ...(isOwn ? { left: 4 } : { right: 4 }), color: 'var(--accent-primary)', opacity: 0.7, zIndex: 1 }}>
          <Pin size={12} />
        </div>
      )}
      <div className="message-avatar-slot">
        {isFirstInGroup
          ? (msg.author.avatar && !avatarError
              ? <img src={msg.author.avatar} alt={displayName} style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} onError={() => setAvatarError(true)} />
              : <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 14 }}>
                  {displayName[0].toUpperCase()}
                </div>
            )
          : null
        }
      </div>
      <div className="message-content" style={{ flex: 1, minWidth: 0 }}>
        <div className="message-bubble">
          {msg.content && (
            <div className="message-text" style={{ position: 'relative' }}>
              {isFirstInGroup && (
                <div className="message-author-bubble">{displayName}</div>
              )}
              {msg.reply_to && (
                <div className="message-reply-preview">
                  <span className="message-reply-author">
                    {msg.reply_to.author.nickname || msg.reply_to.author.username}
                  </span>
                  <span className="message-reply-text">
                    <MessageText text={msg.reply_to.content} customEmojis={customEmojis} />
                  </span>
                </div>
              )}
              <div className="message-line">
                <span className="message-body">
                  <MessageText text={msg.content} customEmojis={customEmojis} />
                </span>
                <span className="message-timestamp">{time}</span>
              </div>
              {hovered && (
                <div style={{ position: 'absolute', top: -8, ...(isOwn ? { left: -8 } : { right: -8 }), display: 'flex', gap: 4, zIndex: 2 }}>
                  <button
                    onClick={() => onReply(msg)}
                    style={{ background: 'var(--bg-secondary)', border: 'none', borderRadius: 6, padding: '3px 6px', cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center' }}
                    title={tr('chat_reply')}
                  >
                    <Reply size={14} />
                  </button>
                  <button
                    onClick={e => onContextMenu(e, msg)}
                    style={{ background: 'var(--bg-secondary)', border: 'none', borderRadius: 6, padding: '3px 6px', cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center' }}
                    title={tr('chat_more')}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </div>
              )}
            </div>
          )}
          {msg.attachments?.map(att => (
            <AttachmentView key={att.id} att={att} />
          ))}
          {!msg.content && (msg.attachments?.length ?? 0) > 0 && (
            <span className="message-timestamp message-timestamp-standalone">
              {time}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

export const GuildChatMain: React.FC = () => {
  const {
    currentGuild, currentGuildChannel, guildMessages,
    sendGuildMessage, scheduleGuildMessage, loadOlderGuildMessages,
    userIDonServer, currentServerIP, authToken,
    setMobileActivePanel, deleteGuildMessage, pinGuildMessage, customEmojis,
  } = useApp();
  const tr = useTranslation();

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return tr('chat_today');
    if (d.toDateString() === yesterday.toDateString()) return tr('chat_yesterday');
    return d.toLocaleDateString();
  };

  const [input, setInput] = useState('');
  const [replyTo, setReplyTo] = useState<GuildMessage | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [scheduledItems, setScheduledItems] = useState<ScheduledItem[]>([]);
  const [limitWarning, setLimitWarning] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<GuildCtxMenu | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);
  const stickerSendGuard = useRef(false);

  useEffect(() => {
    if (guildMessages.length > prevLenRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevLenRef.current = guildMessages.length;
  }, [guildMessages.length]);

  useEffect(() => {
    setHasMore(true);
    prevLenRef.current = 0;
    setScheduledItems([]);
    setTimeout(() => bottomRef.current?.scrollIntoView(), 50);
  }, [currentGuildChannel?.id]);

  const handleScroll = useCallback(async () => {
    if (!listRef.current || loadingOlder || !hasMore) return;
    if (listRef.current.scrollTop < 100) {
      setLoadingOlder(true);
      const more = await loadOlderGuildMessages();
      if (!more) setHasMore(false);
      setLoadingOlder(false);
    }
  }, [loadingOlder, hasMore, loadOlderGuildMessages]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    e.target.value = '';
    if (!selected.length) return;
    setPendingFiles(prev => {
      const available = MAX_FILES - prev.length;
      if (available <= 0) { setLimitWarning(true); setTimeout(() => setLimitWarning(false), 3000); return prev; }
      const allowed = selected.slice(0, available);
      if (selected.length > available) { setLimitWarning(true); setTimeout(() => setLimitWarning(false), 3000); }
      return [...prev, ...allowed.map(f => ({ file: f, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined }))];
    });
  }, []);

  const removeFile = useCallback((i: number) => {
    setPendingFiles(prev => {
      const entry = prev[i];
      if (entry?.preview) URL.revokeObjectURL(entry.preview);
      return prev.filter((_, idx) => idx !== i);
    });
  }, []);

  const clearFiles = useCallback(() => {
    setPendingFiles(prev => { prev.forEach(f => { if (f.preview) URL.revokeObjectURL(f.preview); }); return []; });
  }, []);

  const uploadFiles = useCallback(async (files: PendingFile[]): Promise<string[]> => {
    if (!currentGuild || !currentGuildChannel || files.length === 0) return [];
    setUploading(true);
    const ids: string[] = [];
    try {
      const results = await Promise.all(files.map(async ({ file }) => {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(
          `${currentServerIP}/api/guilds/${currentGuild.id}/channels/${currentGuildChannel.id}/upload/`,
          { method: 'POST', headers: { Authorization: `Bearer ${authToken}` }, body: form }
        );
        if (res.ok) { const d = await res.json(); return d.id as string; }
        return null;
      }));
      results.forEach(id => { if (id != null) ids.push(id); });
    } catch (e) { reportError(e); }
    finally { setUploading(false); }
    return ids;
  }, [currentGuild, currentGuildChannel, currentServerIP, authToken]);

  const handleSend = useCallback(async () => {
    if (!input.trim() && pendingFiles.length === 0) return;
    const text = input;
    const files = pendingFiles;
    const replyId = replyTo?.id;
    setInput('');
    clearFiles();
    setReplyTo(null);
    const attachmentIds = await uploadFiles(files);
    sendGuildMessage(text, replyId, attachmentIds.length ? attachmentIds : undefined);
  }, [input, pendingFiles, replyTo, uploadFiles, sendGuildMessage, clearFiles]);

  const handleDelayedSend = useCallback(async (delayMs: number) => {
    if (!input.trim() && pendingFiles.length === 0) return;
    setShowPicker(false);
    const text = input;
    const files = [...pendingFiles];
    const replyId = replyTo?.id;
    setInput('');
    clearFiles();
    setReplyTo(null);
    const attachmentIds = await uploadFiles(files);
    const result = await scheduleGuildMessage(text, Math.round(delayMs / 1000), replyId, attachmentIds.length ? attachmentIds : undefined);
    if (result) setScheduledItems(prev => [...prev, { id: result.id, send_at: result.send_at, content: text }]);
  }, [input, pendingFiles, replyTo, uploadFiles, scheduleGuildMessage, clearFiles]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const canSend = input.trim().length > 0 || pendingFiles.length > 0;

  const openCtx = useCallback((e: React.MouseEvent, msg: GuildMessage) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, msg });
  }, []);

  const closeCtx = useCallback(() => setCtxMenu(null), []);

  if (!currentGuild) return null;

  if (!currentGuildChannel) {
    return (
      <div className="guild-chat-main guild-welcome">
        <Hash size={64} style={{ opacity: 0.15 }} />
        <h2>{currentGuild.name}</h2>
        <p style={{ opacity: 0.5 }}>{currentGuild.description || tr('guild_select_channel')}</p>
        <p style={{ opacity: 0.4, fontSize: 13 }}>
          {tr('guild_invite_code')}: <code style={{ background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: 4 }}>{currentGuild.invite_code}</code>
        </p>
      </div>
    );
  }

  const myRole = currentGuild.my_role;
  const canPin = myRole === 'owner' || myRole === 'admin';

  return (
    <div className="guild-chat-main">
      {/* Delete confirm */}
      {deleteConfirmId && (
        <ConfirmModal
          title={tr('delete_message_title')}
          message={tr('delete_message_confirm')}
          confirmLabel={tr('delete_message_button')}
          cancelLabel={tr('cancel')}
          onConfirm={() => { deleteGuildMessage(deleteConfirmId); setDeleteConfirmId(null); }}
          onCancel={() => setDeleteConfirmId(null)}
        />
      )}
      {/* Context menu */}
      {ctxMenu && (
        <GuildMessageContextMenu
          menu={ctxMenu}
          isOwn={String(ctxMenu.msg.author.id) === String(userIDonServer)}
          canPin={canPin}
          onClose={closeCtx}
          onReply={msg => { setReplyTo(msg); closeCtx(); }}
          onDelete={id => { closeCtx(); setDeleteConfirmId(id); }}
          onPin={id => pinGuildMessage(id)}
          onCopy={text => navigator.clipboard.writeText(text).catch(() => {})}
        />
      )}
      {/* Header */}
      <div className="chat-header">
        <button
          className="mobile-back-btn"
          style={{ display: 'none', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '0 6px 0 0', alignItems: 'center' }}
          onClick={() => setMobileActivePanel('guild-channels')}
        >
          <ChevronLeft size={22} />
        </button>
        <Hash size={18} style={{ opacity: 0.7 }} className="desktop-only-icon" />
        <span className="chat-header-name">{currentGuildChannel.name}</span>
        {currentGuildChannel.topic && (
          <span className="chat-header-topic">{currentGuildChannel.topic}</span>
        )}
      </div>

      {/* Messages */}
      <div className="messages-container" ref={listRef} onScroll={handleScroll}>
        <div className="messages-list">
          {loadingOlder && <div className="loading-older">{tr('guild_loading_older')}</div>}
          {!hasMore && guildMessages.length > 0 && (
            <div className="channel-start">
              <Hash size={32} style={{ opacity: 0.3 }} />
              <p>{tr('guild_beginning')} <strong>#{currentGuildChannel.name}</strong></p>
            </div>
          )}
          {guildMessages.map((msg, i) => {
            const prev = guildMessages[i - 1];
            const showDate = shouldShowDateSeparator(msg, prev);
            const dateSep = showDate ? <DateSeparator key={`date-${msg.id || i}`} label={formatDate(msg.created_at)} /> : null;
            const isFirstInGroup = showDate || !prev || String(prev.author.id) !== String(msg.author.id);
            return (
              <React.Fragment key={msg.id || `tmp-${i}`}>
                {dateSep}
                <GuildMessageRow
                  msg={msg}
                  isOwn={String(msg.author.id) === String(userIDonServer)}
                  isFirstInGroup={isFirstInGroup}
                  onContextMenu={openCtx}
                  onReply={setReplyTo}
                  customEmojis={customEmojis}
                  highlight={highlightId === msg.id}
                />
              </React.Fragment>
            );
          })}
        </div>
        <div ref={bottomRef} />
      </div>

      {/* Scheduled items */}
      {scheduledItems.map(item => {
        const remaining = Math.max(0, Math.round((new Date(item.send_at).getTime() - Date.now()) / 1000));
        return (
          <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 8px 0', padding: '7px 12px', borderRadius: 8, background: 'rgba(88,101,242,0.15)', border: '1px solid var(--accent-primary)', flexShrink: 0 }}>
            <Clock size={14} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
            <span style={{ fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {tr('guild_schedule_send')} <b>{remaining}s</b>: {item.content || '[attachment]'}
            </span>
            <button onClick={() => setScheduledItems(prev => prev.filter(s => s.id !== item.id))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ff6666', fontSize: 12, padding: 0 }}>{tr('cancel')}</button>
          </div>
        );
      })}

      {/* Reply bar */}
      {replyTo && (
        <div className="reply-bar">
          <CornerUpLeft size={14} />
          <span>{tr('guild_replying_to')} <strong>{replyTo.author.nickname || replyTo.author.username}</strong>: {replyTo.content.slice(0, 60)}</span>
          <button className="icon-btn" onClick={() => setReplyTo(null)}>✕</button>
        </div>
      )}

      {/* File limit warning */}
      {limitWarning && (
        <div style={{ margin: '4px 8px 0', padding: '6px 12px', borderRadius: 8, background: '#ff444422', border: '1px solid #ff4444', color: '#ff6666', fontSize: 13 }}>
          {tr('guild_max_files').replace('{n}', String(MAX_FILES))}
        </div>
      )}

      {/* Pending file previews */}
      {pendingFiles.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '8px 12px 0' }}>
          {pendingFiles.map((pf, i) => (
            <div key={i} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-secondary)', borderRadius: 8, padding: '6px 10px', maxWidth: 200 }}>
              {pf.preview
                ? <img src={pf.preview} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
                : <span style={{ color: 'var(--accent-primary)', flexShrink: 0 }}>{getFileIcon(pf.file.type)}</span>
              }
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 100 }}>{pf.file.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{formatFileSize(pf.file.size)}</div>
              </div>
              <button onClick={() => removeFile(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 2 }}><X size={14} /></button>
            </div>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="message-input-area" style={{ flexDirection: 'column', gap: 0, alignItems: 'stretch' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%', position: 'relative' }}>
          <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileSelect} />
          <button className="icon-btn" title={tr('guild_add_attachment')} onClick={() => fileInputRef.current?.click()} disabled={uploading || pendingFiles.length >= MAX_FILES}>
            <Plus size={20} />
          </button>
          <textarea
            className="message-input"
            placeholder={`${tr('guild_send_placeholder')}${currentGuildChannel.name}`}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            rows={1}
            maxLength={5000}
            disabled={uploading}
            style={{ flex: 1 }}
          />
          <button
            ref={pickerButtonRef}
            className="icon-btn"
            title={tr('chat_emoji')}
            onClick={() => setShowPicker(v => !v)}
          >
            <MoreHorizontal size={20} />
          </button>
          {showPicker && (
            <UnifiedPicker
              anchorRef={pickerButtonRef}
              onSelectEmoji={emoji => setInput(prev => prev + emoji)}
              onSelectGif={url => {
                if (stickerSendGuard.current) return;
                stickerSendGuard.current = true;
                sendGuildMessage(url, replyTo?.id);
                setReplyTo(null);
                setShowPicker(false);
                setTimeout(() => { stickerSendGuard.current = false; }, 500);
              }}
              onSelectSticker={(url) => {
                if (stickerSendGuard.current) return;
                stickerSendGuard.current = true;
                sendGuildMessage(url, replyTo?.id);
                setReplyTo(null);
                setShowPicker(false);
                setTimeout(() => { stickerSendGuard.current = false; }, 500);
              }}
              onDelayedSend={ms => handleDelayedSend(ms)}
              canSchedule={canSend}
              onClose={() => setShowPicker(false)}
            />
          )}
          <button
            className="send-btn"
            onClick={handleSend}
            disabled={uploading || !canSend}
          >
            {uploading
              ? <div style={{ width: 18, height: 18, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              : <Send size={18} />
            }
          </button>
        </div>
      </div>
    </div>
  );
};
