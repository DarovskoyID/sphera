import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Hash, Send, Pin, Trash2, CornerUpLeft, Plus, MoreHorizontal, X, Download, FileText, FileImage, FileVideo, FileAudio, File, ChevronLeft } from 'lucide-react';
import { useApp, reportError } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import { MessageText } from './EmojiPicker';
import { UnifiedPicker } from './StickerGifPicker';
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

function MessageBubble({
  msg, prevMsg, myId, myRole, onReply,
}: {
  msg: GuildMessage;
  prevMsg: GuildMessage | undefined;
  myId: string;
  myRole: string;
  onReply: (msg: GuildMessage) => void;
}) {
  const { deleteGuildMessage, pinGuildMessage, customEmojis } = useApp();
  const tr = useTranslation();
  const [hover, setHover] = useState(false);

  const sameAuthor = prevMsg && prevMsg.author.id === msg.author.id &&
    new Date(msg.created_at).getTime() - new Date(prevMsg.created_at).getTime() < 5 * 60 * 1000;

  const canDelete = msg.author.id === myId || myRole === 'owner' || myRole === 'admin';
  const canPin = myRole === 'owner' || myRole === 'admin';

  return (
    <div
      className="guild-message"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="guild-message-aside">
        {!sameAuthor ? (
          msg.author.avatar ? (
            <img src={msg.author.avatar} alt="" className="guild-message-avatar" />
          ) : (
            <div className="guild-message-avatar guild-message-avatar-placeholder">
              {(msg.author.nickname || msg.author.username)[0].toUpperCase()}
            </div>
          )
        ) : (
          hover ? <span className="guild-message-time-hover">{formatTime(msg.created_at)}</span> : null
        )}
      </div>

      <div className="guild-message-body">
        {!sameAuthor && (
          <div className="guild-message-header">
            <span className="guild-message-author">{msg.author.nickname || msg.author.username}</span>
            <span className="guild-message-ts">{formatTime(msg.created_at)}</span>
            {msg.is_pinned && <Pin size={11} style={{ color: 'var(--accent-primary)' }} />}
          </div>
        )}

        {msg.reply_to && (
          <div className="guild-reply-preview">
            <CornerUpLeft size={12} />
            <span className="reply-author">{msg.reply_to.author.nickname || msg.reply_to.author.username}</span>
            <span className="reply-content">{msg.reply_to.content.slice(0, 80)}</span>
          </div>
        )}

        {msg.content && (
          <div className="guild-message-text">
            <MessageText text={msg.content} customEmojis={customEmojis} />
          </div>
        )}

        {msg.attachments?.map(att => (
          <AttachmentView key={att.id} att={att} />
        ))}
      </div>

      {hover && (
        <div className="guild-message-actions">
          <button className="msg-action-btn" onClick={() => onReply(msg)} title={tr('chat_reply')}>
            <CornerUpLeft size={14} />
          </button>
          {canPin && (
            <button className="msg-action-btn" onClick={() => pinGuildMessage(msg.id)} title={msg.is_pinned ? tr('chat_unpin_msg') : tr('chat_pin')}>
              <Pin size={14} />
            </button>
          )}
          {canDelete && (
            <button className="msg-action-btn danger" onClick={() => deleteGuildMessage(msg.id)} title={tr('chat_delete')}>
              <Trash2 size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export const GuildChatMain: React.FC = () => {
  const {
    currentGuild, currentGuildChannel, guildMessages,
    sendGuildMessage, scheduleGuildMessage, loadOlderGuildMessages,
    userIDonServer, currentServerIP, authToken,
    setMobileActivePanel,
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

  type Row =
    | { kind: 'date'; date: string; key: string }
    | { kind: 'msg'; msg: GuildMessage; prevMsg: GuildMessage | undefined };

  const rows: Row[] = [];
  let lastDate = '';
  for (let i = 0; i < guildMessages.length; i++) {
    const msg = guildMessages[i];
    const d = formatDate(msg.created_at);
    if (d !== lastDate) {
      rows.push({ kind: 'date', date: d, key: `date-${d}-${i}` });
      lastDate = d;
    }
    rows.push({ kind: 'msg', msg, prevMsg: i > 0 ? guildMessages[i - 1] : undefined });
  }

  return (
    <div className="guild-chat-main">
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
      <div className="guild-messages-list" ref={listRef} onScroll={handleScroll}>
        {loadingOlder && <div className="loading-older">{tr('guild_loading_older')}</div>}
        {!hasMore && guildMessages.length > 0 && (
          <div className="channel-start">
            <Hash size={32} style={{ opacity: 0.3 }} />
            <p>{tr('guild_beginning')} <strong>#{currentGuildChannel.name}</strong></p>
          </div>
        )}
        {rows.map(row =>
          row.kind === 'date' ? (
            <div key={row.key} className="date-divider"><span>{row.date}</span></div>
          ) : (
            <MessageBubble
              key={row.msg.id}
              msg={row.msg}
              prevMsg={row.prevMsg}
              myId={userIDonServer}
              myRole={currentGuild.my_role}
              onReply={setReplyTo}
            />
          )
        )}
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
